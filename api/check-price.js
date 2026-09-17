// Serverless Function: GeoRates Geo-Preisvergleich. Prueft den Preis eines konkreten
// Booking.com-Zimmers ueber Proxy-Sessions aus mehreren Laendern (Smartproxy) und meldet
// zurueck, ob ein Laenderwechsel (VPN) eine relevante Ersparnis bringt. Portiert die bereits
// Parsing-Logik eines lokalen Python-Prototyps (nie veroeffentlicht) nach JavaScript.
//
// Kostenschutz (echter Proxy-Traffic kostet Geld, daher mehrfach abgesichert):
//   1. Cloudflare Turnstile Bot-Check vor jeder Anfrage (siehe verifyTurnstile).
//   2. Ergebnis-Cache (Upstash Redis, 24h) - identische Anfragen loesen keinen neuen
//      Proxy-Traffic aus.
//   3. Bilder/Fonts/Stylesheets werden beim Laden geblockt (nur Text noetig).
//   4. Erst DE+CO parallel als schnelle Probe; nur wenn das keine klare Ersparnis zeigt,
//      werden weitere Laender NACHEINANDER (nicht alle parallel, wegen Arbeitsspeicher)
//      geprueft. Eine weitere Ländergruppe wird nur gestartet, wenn sie nach der bisher
//      gemessenen Gruppendauer noch vor dem Vercel-Zeitlimit fertig wird. Reicht die Zeit
//      nicht, liefert die Antwort die bis dahin geprueften Laender plus partial:true zurueck.

const crypto = require('crypto');
const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');

// Vollstaendiges Chromium-Paket (inkl. Shared Libraries wie libnss3.so) wird zur Laufzeit
// aus dem passenden GitHub-Release geladen. So entfaellt das fragile Mitbundeln der Libs
// durch Vercel, das zuvor den Fehler "libnss3.so: cannot open shared object file" ausloeste.
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';

// ---- Konfiguration -----------------------------------------------------------------------

// Alle Laender, ueber die wir per Proxy einen Preis abfragen koennen. Reihenfolge = Prioritaet
// bei der Erweiterung: erfahrungsgemaess guenstige Laender (schwache Waehrung/hohe Inflation)
// zuerst, damit ein evtl. durch das Zeitlimit gekuerztes Ergebnis trotzdem die relevanten
// Kandidaten enthaelt. Teure Maerkte (USA, Japan) ganz am Ende.
// Hinweis: Tuerkei (TR) bewusst NICHT enthalten - von dort sind aktuell keine internationalen
// Buchungen moeglich, daher waere eine Abfrage nur verschwendeter Proxy-Traffic.
const ALL_COUNTRIES = ['DE', 'CO', 'AR', 'EG', 'IN', 'VN', 'ID', 'PK', 'LK', 'PE', 'MX', 'PH', 'TH', 'US', 'JP'];
// "Guenstig-Kandidat" fuer die schnelle Probe (neben dem Ausgangsland).
const CHEAP_PROBE_COUNTRY = 'CO';
// Ausgangsland (Referenzpreis), falls es sich nicht aus dem Link ableiten laesst.
const DEFAULT_BASELINE_COUNTRY = 'DE';
// Ab dieser Ersparnis empfehlen wir aktiv einen Laenderwechsel per VPN.
const PROBE_CONFIDENCE_THRESHOLD_PCT = 10.0;
// Frueher wurde die Suche abgebrochen, sobald Kolumbien diese Schwelle riss. Das ist aus:
// siehe die ausfuehrliche Begruendung an der Verwendungsstelle weiter unten. Auf true
// gesetzt spart es Proxy-Traffic, liefert dafuer aber nur "ein gutes" statt "dem besten"
// Land - und liefert vor allem keine Daten mehr zu der offenen Frage, ob Kolumbien
// tatsaechlich fast immer vorne liegt.
const STOP_EARLY_ON_CLEAR_WIN = false;
// Unterhalb dieser Schwelle ist ein Preisunterschied blosses Rauschen (Wechselkurs-Rundung,
// Nachkommastellen). Solche Treffer werden NICHT als "guenstigeres Land" verkauft - weder im
// Ergebnis noch im Deal-Log. Sonst wirkt das Tool, als wolle es um jeden Preis etwas finden.
const RELEVANT_SAVINGS_PCT = 1.0;
// Ausgangsland + Kolumbien: 2 Versuche (Referenzpreis MUSS verlaesslich sein). Dank der kurzen
// Einzel-Timeouts unten bleiben selbst 2 Versuche pro Land klar unter dem 60s-Limit von Vercel.
// Die zusaetzlichen Laender bekommen nur 1 Versuch (Tempo; ein verpasstes Land ist unkritisch).
const MAX_ATTEMPTS = 2;
const EXPANSION_ATTEMPTS = 1;
const BATCH_SIZE = 2; // weniger gleichzeitige Chromium-Instanzen = zuverlaessigeres Laden
// In der Erweiterungsphase duerfen es mehr sein: dort zaehlt nur 1 Versuch pro Land, ein
// verpasstes Land ist unkritisch, und seit der Umstellung auf 2 GB (vercel.json) ist genug
// Arbeitsspeicher fuer mehr gleichzeitige Chromium-Instanzen da. Das halbiert die Laufzeit
// eines vollstaendigen Scans. Hoeher als 4 bringt wenig: der Hobby-Plan hat nur 1 vCPU,
// ab da warten die Instanzen nur noch aufeinander.
const EXPANSION_BATCH_SIZE = 4;
const MIN_LOADED_LINES = 300;
// Obergrenze fuer die Laenge eines Zimmernamens. Das ist eine Plausibilitaetsbremse gegen
// versehentlich mitgelesene Textabsaetze - KEIN inhaltliches Kriterium. Frueher standen hier
// 55 bis 70 Zeichen, und das hat echte Zimmer verschluckt: Booking haengt Unterscheidungen
// hinten an ("... - kleinere Villa"), und solche Namen kommen leicht auf ueber 70 Zeichen.
// Ausgerechnet die guenstigste Kategorie eines Hotels fiel dadurch aus der Auswahl.
const ROOM_NAME_MAX_LEN = 140;
// Zeitsteuerung der Erweiterungsphase.
//
// Frueher galt ein starres Budget von 36s: Wurde es ueberschritten, brach die Schleife ab.
// Das hatte zwei Nachteile. Erstens wurde Zeit verschenkt - bei 35,9s startete noch eine
// volle Gruppe, bei 36,1s keine mehr, obwohl noch 20s frei waren. Zweitens war genau der
// erste Fall riskant: eine bei 35,9s gestartete Gruppe konnte bis ~56s laufen und damit das
// 60s-Limit von Vercel streifen.
//
// Jetzt wird vorausschauend geplant: Wir messen, wie lange die letzte Gruppe wirklich
// gedauert hat, und starten die naechste nur, wenn sie nach dieser Erfahrung noch vor
// HARD_DEADLINE_MS fertig wird. Das nutzt das Zeitfenster deutlich besser aus UND kann das
// Limit nicht mehr ueberfahren.
// Seit Vercel "Fluid Compute" (im Projekt aktiv) erlaubt auch der kostenlose Hobby-Plan bis zu
// 300s pro Funktion - die alte 60s-Grenze gilt nicht mehr. Wir nehmen NICHT das Maximum: 15
// Laender brauchen erfahrungsgemaess ~100-120s, und jede Sekunde Laufzeit ist bezahlter
// Proxy-Traffic. 180s lassen genug Luft, begrenzen aber einen entgleisten Lauf.
// WICHTIG: Dieser Wert muss zu maxDuration in vercel.json passen.
const FUNCTION_LIMIT_MS = 180000;         // Vercel-Limit (siehe vercel.json)
const RESPONSE_RESERVE_MS = 10000;        // Puffer fuer Zusammenfassung, Cache-Write, Logging, Antwort
const HARD_DEADLINE_MS = FUNCTION_LIMIT_MS - RESPONSE_RESERVE_MS;
// Schaetzung fuer die erste Gruppe (noch kein Messwert vorhanden) - bewusst pessimistisch.
const FIRST_BATCH_ESTIMATE_MS = 14000;
// Sicherheitsaufschlag auf die gemessene Gruppendauer: die naechste Gruppe kann langsamer sein.
const BATCH_ESTIMATE_SAFETY = 1.25;
const CACHE_TTL_SECONDS = 24 * 3600;

const DEFAULT_CURRENCY_BY_COUNTRY = {
  DE: 'EUR', US: 'USD', CO: 'COP', TH: 'THB', IN: 'INR', EG: 'EGP', AR: 'ARS',
  TR: 'TRY', LK: 'LKR', VN: 'VND', ID: 'IDR', PK: 'PKR', PE: 'PEN',
  MX: 'MXN', PH: 'PHP', JP: 'JPY',
};

// Anzeige-/Sprachkuerzel aus dem Booking.com-Link (z.B. "grand-fasano.de.html") -> Ausgangsland.
// Nur Laender, fuer die wir auch einen Proxy haben, koennen als Baseline dienen; alles andere
// faellt auf DEFAULT_BASELINE_COUNTRY zurueck.
const LANG_TO_BASELINE_COUNTRY = {
  de: 'DE', 'de-de': 'DE', 'de-at': 'DE', 'de-ch': 'DE',
  'en-us': 'US',
  'es-co': 'CO', 'es-ar': 'AR', 'es-mx': 'MX', 'es-pe': 'PE',
  th: 'TH', hi: 'IN', ar: 'EG',
  vi: 'VN', id: 'ID', ja: 'JP',
};

// Leitet das Ausgangsland aus dem Anzeige-/Sprachkuerzel des Booking-Links ab. Booking-Hotel-
// URLs enden auf ".<lang>.html" (z.B. ".de.html", ".en-gb.html"). Nicht zuordenbar -> DE.
function detectBaselineCountry(link) {
  try {
    const path = new URL(link).pathname;
    const m = path.match(/\.([a-z]{2}(?:-[a-z]{2})?)\.html$/i);
    if (m) {
      const lang = m[1].toLowerCase();
      if (LANG_TO_BASELINE_COUNTRY[lang]) return LANG_TO_BASELINE_COUNTRY[lang];
      const two = lang.slice(0, 2).toUpperCase();
      if (ALL_COUNTRIES.includes(two)) return two;
    }
  } catch (e) { /* ungueltiger Link -> Default */ }
  return DEFAULT_BASELINE_COUNTRY;
}

// ---- Proxy-Traffic sparen -----------------------------------------------------------------
// Jedes geladene Byte kostet Guthaben. Fuer die Preiserkennung brauchen wir nur das HTML der
// Hotelseite und Bookings eigene Skripte - Bilder, Schriften, Videos, Tracker und alle
// Drittanbieter-Domains werden hart geblockt.
const BLOCKED_RESOURCE_TYPES = new Set([
  'image', 'media', 'font', 'stylesheet', 'other',
  'texttrack', 'websocket', 'manifest', 'eventsource', 'ping', 'cspviolationreport',
]);
// Schalter fuer den Preis-Pfad: Bookings eigene JavaScript-Bundles mitblocken. Das ist der
// groesste Hebel beim Proxy-Verbrauch (Skripte sind der Grossteil der Bytes), darf aber erst
// scharf geschaltet werden, wenn gemessen ist, dass die Zimmertabelle ohne sie vollstaendig
// bleibt. Bis dahin false - im "rooms"-Modus laesst sich per noScripts:true einzeln testen.
const BLOCK_BOOKING_SCRIPTS = false;
// Nur Bookings eigene Domains duerfen laden (bstatic.com ist Bookings Asset-CDN).
const ALLOWED_HOST_RE = /(^|\.)booking\.com$|(^|\.)bstatic\.com$/i;
// Bekannte Tracker/Werbenetze - sicherheitshalber explizit, falls sie unter booking.com laufen.
const TRACKER_HOST_RE = /google-analytics|googletagmanager|doubleclick|googlesyndication|googleadservices|gstatic|connect\.facebook|facebook\.net|criteo|hotjar|segment\.(io|com)|newrelic|nr-data|sentry|adsrvr|taboola|outbrain|bat\.bing|clarity\.ms|amplitude|mixpanel|optimizely|quantserve|scorecardresearch|adnxs|pubmatic|rubiconproject|casalemedia|tiktok|snapchat|pinterest|twitter|cloudflareinsights|onetrust|cookielaw/i;

// ---- Live-Wechselkurse (tagesaktuell, EUR-Basis, kostenlos ohne API-Key) -----------------
// Wichtig: Der Vergleich ist nur so verlaesslich wie der Wechselkurs. Deshalb werden zwei
// unabhaengige Live-Quellen versucht. Liefert KEINE Quelle aktuelle Kurse, wird KEIN Preis
// umgerechnet (getLiveRates gibt null zurueck) und die Anfrage bricht sauber ab, statt mit
// veralteten/falschen Kursen zu rechnen.
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getLiveRates() {
  // Quelle 1: open.er-api.com (deckt alle hier genutzten Waehrungen ab).
  try {
    const json = await fetchJson('https://open.er-api.com/v6/latest/EUR', 6000);
    if (json && json.result === 'success' && json.rates) {
      const inverse = { EUR: 1.0 };
      for (const [cur, rate] of Object.entries(json.rates)) {
        if (rate) inverse[cur] = 1 / rate; // EUR-Gegenwert von 1 Einheit `cur`
      }
      return inverse;
    }
  } catch (e) { /* naechste Quelle versuchen */ }

  // Quelle 2: fawazahmed0 currency-api (freie ECB-/Marktdaten, ebenfalls alle Waehrungen).
  try {
    const json = await fetchJson('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json', 6000);
    if (json && json.eur) {
      const inverse = { EUR: 1.0 };
      for (const [cur, rate] of Object.entries(json.eur)) {
        if (rate) inverse[cur.toUpperCase()] = 1 / rate;
      }
      return inverse;
    }
  } catch (e) { /* beide Quellen fehlgeschlagen */ }

  return null; // keine verlaesslichen Live-Kurse -> Aufrufer bricht ab
}

// ---- Preis-Parsing (1:1 Logik-Port aus dem Python-Prototyp) ----------------------------

function parseAmount(rawText) {
  let digits = (rawText || '').replace(/[^\d.,]/g, '');
  if (!digits) return null;
  if (digits.includes(',')) {
    digits = digits.replace(/\./g, '').replace(',', '.');
  } else {
    digits = digits.replace(/\./g, '');
  }
  const val = parseFloat(digits);
  return Number.isNaN(val) ? null : val;
}

const TAX_LINE_RE = /steuern und geb/i;
const AMOUNT_LINE_RE = /^(?:Preis\s+|Gesamt\s+)?([^\d\s]{1,6})\s*([\d][\d.,]*)\s*$/;
const PRICE_PREFIX_RE = /^Preis\s+([^\d\s]{1,6})\s*([\d][\d.,]*)\s*$/;
const EXCLUSIVE_TAX_LINE_RE = /nicht inbegriffen[:\s]*(.+)/i;
const PCT_TOKEN_RE = /([\d]+(?:[.,]\d+)?)\s*%/g;
const ROOM_CARD_LOOKAHEAD = 3;
const BACKSCAN_LINES = 6;

function extractExclusiveTaxPct(context) {
  const m = EXCLUSIVE_TAX_LINE_RE.exec(context || '');
  if (!m) return null;
  const pctValues = [...m[1].matchAll(PCT_TOKEN_RE)].map((x) => parseFloat(x[1].replace(',', '.')));
  if (!pctValues.length) return null;
  return pctValues.reduce((a, b) => a + b, 0);
}

// Manche Laender zeigen den Zimmerpreis OHNE Steuern und weisen sie als ABSOLUTEN Betrag aus:
// "plus EGP 954 Steuern und Gebühren" (statt "Einschließlich Steuern und Gebühren"). Fuer einen
// FAIREN Vergleich (Deutschland zeigt inkl.) muss dieser Betrag aufaddiert werden. Gibt den
// zusaetzlichen Steuerbetrag in Landeswaehrung zurueck, oder null (Preis ist bereits inklusive).
const ABS_EXTRA_TAX_RE = /(?:plus|zzgl\.?|zuz(?:ü|ue)glich|\+)\s+[^\d\s]{0,4}\s*([\d][\d.,]*)\s+steuern?\s+und\s+geb/i;
function extractAbsoluteExtraTax(context) {
  const m = ABS_EXTRA_TAX_RE.exec(context || '');
  if (!m) return null;
  return parseAmount(m[1]);
}

function looksLikeNewRoomHeading(lines, idx) {
  if (idx >= lines.length || lines[idx].length > ROOM_NAME_MAX_LEN) return false;
  for (let j = idx + 1; j < Math.min(idx + 1 + ROOM_CARD_LOOKAHEAD, lines.length); j++) {
    if (lines[j].includes('m²')) return true;
  }
  return false;
}

function findRoomPrice(bodyText, roomName, boardType, cancelPref) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  const roomLower = roomName.toLowerCase();
  let start = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l === roomLower || l.startsWith(roomLower)) { start = i; break; }
  }
  if (start === null) return [null, null];

  const maxEnd = Math.min(start + 250, lines.length);
  const rawTiers = []; // { amount, anchor }
  let lastAmountLine = -1;
  let k = start + 1;
  while (k < maxEnd) {
    if (rawTiers.length && looksLikeNewRoomHeading(lines, k)) break;

    const pm = PRICE_PREFIX_RE.exec(lines[k]);
    if (pm) {
      lastAmountLine = k;
      rawTiers.push({ amount: pm[2], cur: pm[1], anchor: k });
    } else if (TAX_LINE_RE.test(lines[k])) {
      // "Einschliesslich Steuern und Gebühren" steht IMMER direkt unter dem zugehoerigen
      // Preis. Hat dieser Preis eine Zeile vorher schon eine Ratenstufe erzeugt, darf hier
      // keine zweite fuer denselben Betrag entstehen.
      //
      // Genau das ist am 17.09. passiert und hat den falschen Preis geliefert. Booking gibt
      // aus: "Preis € 1.523" / "Einschliesslich Steuern und Gebühren" / "Nicht kostenlos
      // stornierbar". Die doppelte Stufe hatte als Kontext nur die eine Zeile "Preis € 1.523",
      // weil die naechste Stufe unmittelbar folgte - also KEINE Storno-Angabe. Und eine Stufe
      // ohne Storno-Angabe gilt unten als "nicht ausschliessbar", rutschte damit durch die
      // Auswahl und verdraengte die tatsaechlich kostenlos stornierbare Rate zu 1.589 EUR.
      const letzte = rawTiers.length ? rawTiers[rawTiers.length - 1] : null;
      const gehoertZurLetztenStufe = letzte && (k - letzte.anchor) <= 2;
      if (!gehoertZurLetztenStufe) {
        let amount = null;
        let cur = null;
        for (let back = k - 1; back > Math.max(k - 1 - BACKSCAN_LINES, start); back--) {
          if (back === lastAmountLine) break;
          const m = AMOUNT_LINE_RE.exec(lines[back]);
          if (m) { amount = m[2]; cur = m[1]; break; }
        }
        if (amount) rawTiers.push({ amount, cur, anchor: k });
      }
    }
    k++;
  }

  if (!rawTiers.length) return [null, null];

  // Kontext je Ratenstufe bis zur NAECHSTEN Stufe begrenzen (max. 14 Zeilen), damit die
  // Verpflegungs-/Stornierungserkennung nicht in die naechste Rate "ausblutet".
  const tiers = rawTiers.map((t, i) => {
    const nextAnchor = i + 1 < rawTiers.length ? rawTiers[i + 1].anchor : lines.length;
    const end = Math.min(nextAnchor, t.anchor + 14);
    return [t.amount, lines.slice(t.anchor, end).join('\n'), t.cur];
  });

  // Deutsche Umlaute vereinheitlichen, damit z.B. Formularwert "fruehstueck" zu "Frühstück"
  // auf der Seite passt (frueher schlug dieser Vergleich fehl -> falsche Rate).
  const normDe = (s) => (s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[\s-]/g, '');
  // Tarif-Verpflegung ueber die Mahlzeiten-Zeile bestimmen (gleiche Logik wie beim Laden der
  // Optionen), damit z.B. "Frühstück, Mittagessen & Abendessen" korrekt als Vollpension zaehlt.
  const boardOfCtx = (ctx) => {
    for (const line of (ctx || '').split('\n')) {
      const b = boardOfLine(line);
      if (b) return b;
    }
    return null;
  };
  const matchesBoard = (ctx) => {
    if (!boardType || boardType === 'egal') return true;
    const b = boardOfCtx(ctx);
    if (b) return b === boardType;
    return normDe(ctx).includes(normDe(boardType));
  };
  // Booking-Formulierungen: "Kostenlose Stornierung vor dem ..." (erstattbar) vs
  // "Nicht kostenlos stornierbar" (nicht erstattbar).
  const cancelOfCtx = (ctx) => {
    for (const line of (ctx || '').split('\n')) {
      const c = cancelOfLine(line);
      if (c) return c;
    }
    return null;
  };
  const matchesCancel = (ctx) => {
    if (!cancelPref || cancelPref === 'unsicher') return true;
    const c = cancelOfCtx(ctx);
    if (c) return c === cancelPref;
    return true; // keine Storno-Info im Tarif -> nicht ausschliessen
  };

  // Auswahl-Priorität.
  //
  // Entscheidend ist der Unterschied zwischen "erfuellt den Wunsch ausdruecklich" und "sagt
  // dazu nichts". Frueher galten beide als Treffer, deshalb konnte eine Rate ohne jede
  // Storno-Angabe die Rate verdraengen, die der Nutzer tatsaechlich wollte. Eine Rate, bei der
  // "Kostenlose Stornierung" DASTEHT, schlaegt jetzt immer eine, bei der nichts dasteht.
  const hatStornoInfo = (ctx) => cancelOfCtx(ctx) !== null;
  const hatBoardInfo = (ctx) => boardOfCtx(ctx) !== null;
  const wunschStorno = !!cancelPref && cancelPref !== 'unsicher';
  const stornoAusdruecklichPasst = (ctx) => wunschStorno && hatStornoInfo(ctx) && matchesCancel(ctx);

  // 1. Verpflegung passt UND Storno passt ausdruecklich
  for (const t of tiers) if (matchesBoard(t[1]) && stornoAusdruecklichPasst(t[1])) return t;
  // 2. Storno passt ausdruecklich, Verpflegung passt oder steht gar nicht dabei
  for (const t of tiers) if ((matchesBoard(t[1]) || !hatBoardInfo(t[1])) && stornoAusdruecklichPasst(t[1])) return t;
  // 3./4./5. wie bisher: erst beides locker, dann Verpflegung, dann Storno, dann erste Stufe
  for (const t of tiers) if (matchesBoard(t[1]) && matchesCancel(t[1])) return t;
  for (const t of tiers) if (matchesBoard(t[1])) return t;
  for (const t of tiers) if (matchesCancel(t[1])) return t;
  return tiers[0];
}

// Waehrungssymbol/-kuerzel aus der Preiszeile in einen ISO-Code uebersetzen. Booking zeigt je
// nach Hotel/Sitzung z.B. "US$2.238" auch in einer deutschen Sitzung - deshalb richtet sich die
// Umrechnung nach der TATSAECHLICH angezeigten Waehrung, nicht nach dem Land des Proxys.
// WICHTIG: Ein nacktes "$" steht hier BEWUSST NICHT fuer USD. Argentinien, Mexiko, Kolumbien,
// Chile und Uruguay schreiben ihre eigene Waehrung ebenfalls "$". Die Gleichsetzung "$ = USD"
// hat am 17.09. dazu gefuehrt, dass 2.762.635 argentinische Pesos als 2.762.635 US-Dollar
// gelesen und zu 2.401.524,90 EUR umgerechnet wurden - ein Hotelzimmer fuer 2,4 Millionen Euro.
// Ohne Eintrag faellt normalizeCurrency auf die Landeswaehrung der Sitzung zurueck, und das ist
// bei einem nackten "$" immer die bessere Annahme. "US$" bleibt eindeutig und steht weiter drin.
const CURRENCY_SYMBOLS = {
  '€': 'EUR', 'US$': 'USD', 'USD$': 'USD', '£': 'GBP', '¥': 'JPY', 'CN¥': 'CNY',
  'R$': 'BRL', 'CA$': 'CAD', 'A$': 'AUD', 'NZ$': 'NZD', 'MX$': 'MXN', 'AR$': 'ARS', 'CO$': 'COP',
  '₺': 'TRY', '₹': 'INR', '₫': 'VND', '₱': 'PHP', '฿': 'THB', '₪': 'ILS', '₩': 'KRW', 'RP': 'IDR',
  'E£': 'EGP', 'EG£': 'EGP', '₨': 'PKR', 'S/': 'PEN', 'S/.': 'PEN', 'CHF': 'CHF',
};
function normalizeCurrency(tok, fallback) {
  if (!tok) return fallback;
  const t = String(tok).trim().replace(/\s+/g, '');
  if (CURRENCY_SYMBOLS[t]) return CURRENCY_SYMBOLS[t];
  const up = t.toUpperCase();
  if (CURRENCY_SYMBOLS[up]) return CURRENCY_SYMBOLS[up];
  if (/^[A-Z]{3}$/.test(up)) return up;
  return fallback;
}

function detectSessionCurrency(bodyText) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines.slice(0, 8)) {
    if (/^[A-Z]{3}$/.test(l)) return l;
  }
  return null;
}

// ---- Geraeteprofile -----------------------------------------------------------------------
// Mehrere Leute im Vielfliegertreff berichten, dass bei Booking das GERAET den groessten
// Preisunterschied macht - groesser als das Land. Messbar ist das nur, wenn wir mehr faelschen
// als den User-Agent-String.
//
// Der haeufigste Fehler dabei: nur den UA aendern. Aktuelles Chrome schickt zusaetzlich
// Client Hints (Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform). Bleiben die auf dem echten
// Wert der Lambda-Umgebung ("Linux", mobile: ?0), waehrend der UA "iPhone" behauptet, ist der
// Widerspruch fuer jede Bot-Erkennung offensichtlich - und Booking liefert dann womoeglich
// genau deshalb andere Preise, was wir faelschlich als Geraete-Effekt lesen wuerden.
// Deshalb wird pro Profil AUCH die Metadata gesetzt, plus passender Viewport und Touch.
const DEVICE_PROFILES = {
  // Der bisherige Standard - bleibt Default, damit alte Messungen vergleichbar bleiben.
  windows: {
    label: 'Windows/Desktop',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    meta: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64', mobile: false, model: '' },
  },
  mac: {
    label: 'macOS/Desktop',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
    meta: { platform: 'macOS', platformVersion: '14.4.0', architecture: 'arm', bitness: '64', mobile: false, model: '' },
  },
  android: {
    label: 'Android/Smartphone',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
    meta: { platform: 'Android', platformVersion: '14.0.0', architecture: '', bitness: '', mobile: true, model: 'Pixel 8' },
  },
  // iPhone laeuft mit Safari-Kennung. Client Hints schickt Safari nicht, deshalb hier keine
  // Metadata - das ist bei einem echten iPhone genauso und faellt daher nicht auf.
  iphone: {
    label: 'iOS/iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    meta: null,
  },
};
const DEFAULT_DEVICE = 'windows';
function deviceProfile(name) {
  return DEVICE_PROFILES[String(name || '').toLowerCase()] || DEVICE_PROFILES[DEFAULT_DEVICE];
}

// ---- Ein Land pruefen (Proxy + Headless-Chrome, Bilder/Fonts/Stylesheets geblockt) --------

// blockScripts: zusaetzlich zu Bildern/Fonts/CSS auch Bookings eigene JavaScript-Bundles
// verwerfen. Die machen den Loewenanteil des Proxy-Traffics aus, und die Zimmertabelle steht
// im ausgelieferten HTML - ob sie OHNE Skripte noch vollstaendig ist, muss aber gemessen
// werden, nicht angenommen. Deshalb als Schalter, nicht als fixe Aenderung.
async function attemptFetch(targetUrl, proxyServer, proxyAuth, blockScripts, device) {
  let browser;
  // Ausserhalb des try, damit der bis zum Abbruch verbrauchte Traffic auch im Fehlerfall
  // zurueckgegeben werden kann.
  let transferBytes = 0;
  const prof = deviceProfile(device);
  try {
    const launchArgs = proxyServer ? [...chromium.args, `--proxy-server=${proxyServer}`] : [...chromium.args];
    browser = await puppeteer.launch({
      args: launchArgs,
      defaultViewport: prof.viewport,
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    if (proxyServer && proxyAuth) await page.authenticate(proxyAuth);
    await page.setViewport(prof.viewport);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        const typ = req.resourceType();
        if (BLOCKED_RESOURCE_TYPES.has(typ)) return req.abort();
        if (blockScripts && typ === 'script') return req.abort();
        const host = new URL(req.url()).hostname;
        if (TRACKER_HOST_RE.test(host)) return req.abort();
        if (!ALLOWED_HOST_RE.test(host)) return req.abort(); // alle Drittanbieter-Domains
        return req.continue();
      } catch (e) {
        try { return req.continue(); } catch (e2) { /* Request bereits behandelt */ }
      }
    });

    // Tatsaechlich uebertragene Bytes zaehlen - das ist exakt das, was Smartproxy abrechnet.
    //
    // Frueher wurde hier der content-length-Header aufsummiert. Das war praktisch wertlos:
    // Booking liefert fast alles chunked aus, also ganz ohne content-length, und komprimiert
    // zusaetzlich. Gemessen wurden dadurch 7 KB fuer eine Seite mit zwei Dutzend Zimmern -
    // eine Zahl, mit der man keine Entscheidung ueber Proxy-Kosten treffen kann.
    //
    // Network.loadingFinished liefert encodedDataLength: die real ueber die Leitung gegangene,
    // komprimierte Byte-Zahl inklusive Header. Genau die richtige Groesse.
    try {
      const cdp = await page.target().createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.loadingFinished', (e) => { transferBytes += (e && e.encodedDataLength) || 0; });

      // Geraeteprofil setzen: User-Agent UND Client Hints in einem Zug. Ueber CDP, weil nur so
      // die userAgentMetadata mitgeht - mit page.setUserAgent() allein bliebe
      // Sec-CH-UA-Platform auf "Linux" und Sec-CH-UA-Mobile auf "?0" stehen. Ein UA, der
      // "iPhone" behauptet, waehrend die Client Hints "Linux, nicht mobil" sagen, ist fuer
      // Booking sofort als Faelschung erkennbar - und dann messen wir nicht den Geraete-Effekt,
      // sondern die Reaktion auf einen auffaelligen Bot.
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: prof.ua,
        acceptLanguage: 'de-DE,de;q=0.9',
        platform: prof.meta ? prof.meta.platform : 'iPhone',
        ...(prof.meta ? {
          userAgentMetadata: {
            brands: [
              { brand: 'Chromium', version: '123' },
              { brand: 'Google Chrome', version: '123' },
              { brand: 'Not:A-Brand', version: '99' },
            ],
            fullVersion: '123.0.0.0',
            platform: prof.meta.platform,
            platformVersion: prof.meta.platformVersion,
            architecture: prof.meta.architecture,
            bitness: prof.meta.bitness,
            model: prof.meta.model,
            mobile: prof.meta.mobile,
          },
        } : {}),
      });
      if (prof.viewport.hasTouch) {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      }
    } catch (e) {
      // Faellt CDP aus, laeuft alles weiter - aber dann OHNE korrekte Geraetekennung. Das muss
      // im Log stehen, sonst messen wir Desktop und schreiben "Mobil" in die Tabelle.
      console.log('[attemptFetch] CDP-Override fehlgeschlagen, Geraeteprofil evtl. unwirksam:', (e && e.message) || e);
      try { await page.setUserAgent(prof.ua); } catch (e2) { /* ignorieren */ }
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 13000 });

    for (const sel of ["button ::-p-text('Alle akzeptieren')", '#onetrust-accept-btn-handler']) {
      try {
        await page.click(sel, { timeout: 1200 });
        break;
      } catch (e) { /* kein Banner - ignorieren */ }
    }

    try {
      await page.waitForFunction(
        () => !!document.body && /Zimmerkategorie|Preis für|Art der Unterbringung/i.test(document.body.innerText),
        { timeout: 9000 }
      );
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    try {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await new Promise((r) => setTimeout(r, 1200));
    } catch (e) { /* ignorieren */ }

    // Null-sicher: unter Last kann document.body beim Auslesen noch fehlen - das darf den
    // gesamten Abruf nicht abbrechen lassen.
    const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '');

    // Zimmer direkt aus dem DOM der Zimmertabelle lesen: pro Zeile der erste Link (= der blaue
    // Zimmername, exakt was der Nutzer sieht) plus die in DIESEM Zimmerblock real vorhandenen
    // Verpflegungs- und Storno-Optionen (ueber alle Tarifzeilen des Zimmers). Viel zuverlaessiger
    // als aus dem reinen Text zu raten.
    let roomData = [];
    let roomMeta = null;
    try {
      // ROOM_NAME_MAX_LEN wird hineingereicht: der Code unten laeuft im Browser, dort sind die
      // Konstanten dieser Datei nicht sichtbar.
      const ev = await page.evaluate((ROOM_NAME_MAX_LEN) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const boardsOf = (t) => {
          t = t.toLowerCase();
          const b = [];
          if (/all[-\s]?inclusive/.test(t)) b.push('allinclusive');
          if (/vollpension/.test(t)) b.push('vollpension');
          if (/halbpension|abendessen inbegriffen/.test(t)) b.push('halbpension');
          if (/fr(ü|ue)hst(ü|ue)ck/.test(t)) b.push('fruehstueck');
          if (/ohne (fr(ü|ue)hst(ü|ue)ck|mahlzeit)|nur (ü|ue)bernachtung|room only/.test(t)) b.push('uebernachtung');
          return [...new Set(b)];
        };
        const cancelsOf = (t) => {
          t = t.toLowerCase();
          const c = [];
          if (/kostenlose stornierung|kostenlos stornierbar/.test(t)) c.push('ja');
          if (/teilweise erstattbar/.test(t)) c.push('teilweise');
          if (/nicht erstattbar|nicht kostenlos stornierbar|keine kostenlose stornierung/.test(t)) c.push('nein');
          return [...new Set(c)];
        };
        const order = [];
        const map = {};
        const addRow = (name, txt) => {
          if (!map[name]) { map[name] = ''; order.push(name); }
          map[name] += ' ' + (txt || '');
        };
        let strategy = 0;
        let tablesTotal = document.querySelectorAll('table').length;
        // Strategie 1: klassische Zimmertabelle. Der Zimmername steht per rowspan nur in der ersten
        // Tarifzeile; Folgezeilen gehoeren zum selben (zuletzt gesehenen) Zimmer.
        for (const tbl of document.querySelectorAll('table')) {
          const ths = [...tbl.querySelectorAll('th')].map((th) => (th.innerText || '').toLowerCase());
          if (!ths.some((h) => /zimmerkategorie|unterkunftstyp|zimmertyp|art der unterbringung|unterbringungsart|room type|accommodation type/.test(h))) continue;
          let cur = null;
          for (const row of tbl.querySelectorAll('tr')) {
            // Zimmernamen stehen je nach Layout in TD ODER in einer TH-Zeilenkopfzelle.
            const firstTd = [...row.children].find((c) => c.tagName === 'TD' || c.tagName === 'TH');
            if (!firstTd) continue;
            const a = firstTd.querySelector('a');
            const nm = a ? clean(a.innerText) : '';
            // Laengenobergrenze nur als Schutz gegen versehentlich gegriffene Textabsaetze.
            // Sie war mit 70 viel zu knapp: Booking haengt an Zimmernamen gern Zusaetze an
            // ("... - kleinere Villa", "... mit Meerblick"), und genau die laengeren Namen
            // gehoeren oft zu den GUENSTIGSTEN Kategorien. Ein Name mit 71 Zeichen fiel so
            // lautlos raus - der Nutzer sah drei statt vier Zimmern und ausgerechnet das
            // billigste fehlte. Die eigentliche Absicherung ist hier ohnehin die Struktur
            // (erster Link in der Zimmerzeile der Zimmertabelle), nicht die Laenge.
            if (nm && nm.length >= 3 && nm.length <= ROOM_NAME_MAX_LEN) cur = nm;
            if (cur) addRow(cur, row.innerText);
          }
          if (order.length) { strategy = 1; break; }
        }
        // Strategie 2 (Fallback): nur Namen aus bekannten Zimmernamen-Links.
        if (!order.length) {
          const sel = 'a.hprt-roomtype-icon-link, .hprt-roomtype-link, [data-testid="room-name"], [data-testid="rt-title"], [data-component="room-type-name"]';
          for (const el of document.querySelectorAll(sel)) {
            const nm = clean(el.innerText || el.textContent);
            if (nm && nm.length >= 3 && nm.length <= ROOM_NAME_MAX_LEN) addRow(nm, '');
          }
          if (order.length) strategy = 2;
        }
        const rooms = order.map((name) => ({ name, boards: boardsOf(map[name]), cancels: cancelsOf(map[name]) }));
        const meta = {
          strategy,
          tablesTotal,
          firstOptSample: order.length ? (map[order[0]] || '').slice(0, 260) : '',
          bodyHasFruehstueck: /fr(ü|ue)hst(ü|ue)ck/i.test((document.body && document.body.innerText) || ''),
          bodyHasStorno: /stornier/i.test((document.body && document.body.innerText) || ''),
        };
        return { rooms, meta };
      }, ROOM_NAME_MAX_LEN);
      roomData = ev.rooms || [];
      roomMeta = ev.meta || null;
    } catch (e) { roomData = []; }

    await browser.close();
    // "Geladen" heisst: die Zimmer-/Preistabelle ist wirklich da. Eine starre Zeilenzahl hat
    // schwere Seiten faelschlich verworfen, obwohl Zimmer und Preise vorhanden waren.
    const lineCount = bodyText.split('\n').length;
    const hasRoomTable = /Zimmerkategorie|Art der Unterbringung|Unterkunftstyp|Zimmertyp|Preis für/i.test(bodyText);
    const loadedOk = hasRoomTable ? lineCount >= 80 : lineCount >= MIN_LOADED_LINES;
    console.log(`[attemptFetch] geladen: ${(transferBytes / 1024).toFixed(0)} KB (${lineCount} Zeilen)`);
    return { bodyText, rooms: roomData, roomMeta, loadedOk, transferBytes, err: null };
  } catch (err) {
    console.error('[attemptFetch] Fehler beim Laden/Chromium-Start:', (err && err.stack) || err);
    if (browser) { try { await browser.close(); } catch (e) { /* ignorieren */ } }
    // Auch ein gescheiterter Versuch hat schon Traffic verbraucht - der muss mitgezaehlt
    // werden, sonst sieht die Kostenbilanz besser aus als sie ist.
    return { bodyText: null, rooms: [], loadedOk: false, transferBytes, err };
  }
}

async function fetchPrice(countryCode, targetUrl, proxyServer, userPrefix, password, room, board, cancel, rates, maxAttempts, device) {
  const attempts = maxAttempts || MAX_ATTEMPTS;
  const t0 = Date.now();
  const proxyAuth = { username: `${userPrefix}${countryCode}`, password };
  const expectedCurrency = DEFAULT_CURRENCY_BY_COUNTRY[countryCode];
  const result = { country: countryCode, priceRaw: null, currency: null, priceLocal: null, priceEuro: null };

  let bodyText = null;
  let loadedOk = false;
  let lastErr = null;

  // Traffic ueber ALLE Versuche dieses Landes summieren - Fehlversuche kosten genauso.
  result.transferBytes = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await attemptFetch(targetUrl, proxyServer, proxyAuth, BLOCK_BOOKING_SCRIPTS, device);
    result.transferBytes += r.transferBytes || 0;
    bodyText = r.bodyText;
    loadedOk = r.loadedOk;
    lastErr = r.err;
    if (loadedOk && expectedCurrency) {
      const seen = detectSessionCurrency(bodyText);
      // Nur protokollieren, NICHT verwerfen: Booking zeigt z.B. bei US-Hotels auch in einer
      // deutschen Sitzung US-Dollar. Die Umrechnung erfolgt unten anhand der echten Waehrung.
      if (seen && seen !== expectedCurrency) {
        console.log(`[fetchPrice] ${countryCode}: Sitzungswaehrung ${seen} statt ${expectedCurrency}`);
      }
    }
    if (loadedOk) break;
  }

  console.log(`[fetchPrice] ${countryCode}: ${loadedOk ? 'ok' : 'kein Preis'} nach ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!loadedOk) {
    result.priceRaw = lastErr ? `Fehler: ${lastErr.message || lastErr}` : 'Seite nicht vollständig geladen (Proxy-Exit instabil)';
    return result;
  }

  const [rawAmt, ctx, curTok] = findRoomPrice(bodyText, room, board, cancel);
  // Waehrung aus der tatsaechlichen Preiszeile ableiten (Fallback: Landeswaehrung).
  const currency = normalizeCurrency(curTok, expectedCurrency || 'EUR');
  if (rawAmt) {
    let val = parseAmount(rawAmt);
    const taxPct = extractExclusiveTaxPct(ctx);
    const absExtra = extractAbsoluteExtraTax(ctx);
    if (val !== null && taxPct !== null) {
      val = Math.round(val * (1 + taxPct / 100) * 100) / 100;
      result.priceRaw = `${rawAmt} (${currency}, zzgl. ${taxPct}% Steuer -> steuerinkl.: ${val})`;
    } else if (val !== null && absExtra !== null) {
      val = Math.round((val + absExtra) * 100) / 100;
      result.priceRaw = `${rawAmt} (${currency}, zzgl. ${absExtra} ${currency} Steuern -> steuerinkl.: ${val})`;
    } else {
      result.priceRaw = `${rawAmt} (${currency}, inkl. Steuern & Gebühren)`;
    }
    result.currency = currency;
    result.priceLocal = val; // Betrag in der Landeswaehrung (zur VPN-Kontrolle im Frontend)
    if (val !== null) {
      const rate = rates[currency];
      if (rate) result.priceEuro = Math.round(val * rate * 100) / 100;
    }
  } else {
    result.priceRaw = `Zimmer "${room}" auf dieser Landes-Session nicht gefunden/verfügbar`;
  }
  return result;
}

// ---- Cloudflare Turnstile Bot-Check -----------------------------------------------------

async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // nicht konfiguriert -> Check übersprungen (Setup noch offen)
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp || '' }),
    });
    const json = await res.json();
    return !!json.success;
  } catch (e) {
    return false;
  }
}

// ---- Ergebnis-Cache (Upstash Redis REST, optional) ----------------------------------------

// Das Geraet MUSS in den Cache-Schluessel. Sonst liefert eine Mobil-Abfrage das gecachte
// Desktop-Ergebnis zurueck - und genau der Unterschied, den wir messen wollen, waere
// wegdefiniert, ohne dass es jemand merkt.
function cacheKeyFor(link, room, board, cancel, device) {
  return 'georates:' + crypto.createHash('sha256')
    .update(`${link}|${room}|${board}|${cancel}|${device || DEFAULT_DEVICE}`).digest('hex').slice(0, 32);
}

async function cacheGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    return json && json.result ? JSON.parse(json.result) : null;
  } catch (e) { return null; }
}

async function cacheSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${key}?EX=${CACHE_TTL_SECONDS}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(value),
    });
  } catch (e) { /* ignorieren - Cache ist nur Optimierung, kein kritischer Pfad */ }
}

// ---- Abfrage-Log (optional, an eine Google-Tabelle via Apps-Script-Webhook) ----------------

const LOG_BOARD_LABEL = { uebernachtung: 'Nur Übernachtung', fruehstueck: 'Frühstück', halbpension: 'Halbpension', vollpension: 'Vollpension', allinclusive: 'All-Inclusive', egal: 'Egal' };
const LOG_CANCEL_LABEL = { ja: 'Kostenlos stornierbar', teilweise: 'Teilweise erstattbar', nein: 'Nicht kostenlos stornierbar', unsicher: 'Egal' };
const LOG_COUNTRY_LABEL = { DE: 'Deutschland', CO: 'Kolumbien', AR: 'Argentinien', EG: 'Ägypten', IN: 'Indien', VN: 'Vietnam', ID: 'Indonesien', PK: 'Pakistan', LK: 'Sri Lanka', PE: 'Peru', MX: 'Mexiko', PH: 'Philippinen', TH: 'Thailand', US: 'USA', JP: 'Japan' };

// Schreibt EINE Zeile pro Abfrage in die Google-Tabelle. Fehler werden verschluckt - das Logging
// darf den Preis-Check niemals blockieren oder verzoegern.
async function logQuery(entry) {
  const url = process.env.LOG_WEBHOOK_URL;
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: process.env.LOG_WEBHOOK_TOKEN || '', ...entry }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
  } catch (e) { /* Logging ist optional - nie den Check gefaehrden */ }
}

// ---- Gesamtergebnis aus Einzelländern ableiten --------------------------------------------

// Sicherheitsnetz gegen Waehrungs-Verwechslungen. Derselbe Aufenthalt kann von Land zu Land
// ein paar Prozent kosten, aber niemals das Zehnfache. Weicht ein Landespreis so extrem vom
// Ausgangspreis ab, ist nicht der Preis exotisch, sondern die Umrechnung kaputt (falsch
// erkannte Waehrung, verrutschtes Tausendertrennzeichen). So etwas darf nicht in der Tabelle
// landen - es macht das ganze Ergebnis unglaubwuerdig. Dann lieber "kein Preis ermittelt".
const PLAUSIBLE_MAX_FACTOR = 10;
const PLAUSIBLE_MIN_FACTOR = 0.1;
function implausibleVsBaseline(priceEuro, basePriceEuro) {
  if (priceEuro == null || basePriceEuro == null || basePriceEuro <= 0) return false;
  const ratio = priceEuro / basePriceEuro;
  return ratio > PLAUSIBLE_MAX_FACTOR || ratio < PLAUSIBLE_MIN_FACTOR;
}

function summarize(results, baselineCountry) {
  // Erst aussortieren, dann auswerten: Ein unplausibler Wert wuerde sonst als "teuerstes Land"
  // in der Tabelle stehen bleiben und Nutzer an den uebrigen Zahlen zweifeln lassen.
  const baseRow = results.find((r) => r.country === baselineCountry);
  const basePrice = baseRow && baseRow.priceEuro != null ? baseRow.priceEuro : null;
  for (const r of results) {
    if (r.country !== baselineCountry && implausibleVsBaseline(r.priceEuro, basePrice)) {
      console.log(`[summarize] ${r.country}: ${r.priceEuro} EUR gegen Basis ${basePrice} EUR ` +
        `- unplausibel (${r.priceRaw} ${r.currency}), wird verworfen`);
      r.priceEuro = null;
      r.priceLocal = null;
      r.priceRaw = 'Preis nicht verlässlich erkannt';
      r.implausible = true;
    }
  }

  const withPrice = results.filter((r) => r.priceEuro !== null);
  if (!withPrice.length) return { success: false, reason: 'price_not_found', results, baselineCountry };

  const best = withPrice.reduce((a, b) => (b.priceEuro < a.priceEuro ? b : a));
  const baseline = results.find((r) => r.country === baselineCountry);
  let savingsPct = null;
  let recommendVpnCountry = null;
  if (baseline && baseline.priceEuro !== null && best.country !== baselineCountry) {
    savingsPct = Math.round(((baseline.priceEuro - best.priceEuro) / baseline.priceEuro) * 1000) / 10;
    if (savingsPct >= PROBE_CONFIDENCE_THRESHOLD_PCT) recommendVpnCountry = best.country;
  }
  // Nur ab RELEVANT_SAVINGS_PCT sprechen wir ueberhaupt von einem Unterschied.
  const relevantSaving = savingsPct != null && savingsPct >= RELEVANT_SAVINGS_PCT;
  return { success: true, results, best, savingsPct, relevantSaving, recommendVpnCountry, baselineCountry };
}

// ---- Alle Zimmernamen einer Hotelseite auflisten (fuer das Dropdown im Formular) ----------
// Nutzt dieselbe Heuristik wie die Zimmererkennung: eine Zeile ist eine Zimmer-Ueberschrift,
// wenn kurz danach eine Flaechenangabe ("... m²") folgt.
const BED_RE = /doppelbett|einzelbett|zweibett|etagenbett|schlafsofa|schlafcouch|\bbett\b|\bbetten\b/i;
// Ein echter Zimmername enthaelt praktisch immer ein Unterkunfts-/Zimmertyp-Wort. Das ist ein viel
// verlaesslicheres Signal als "steht neben einer Bett-Angabe" (dort landete sonst Ausstattung wie
// "Ventilator" oder "Schrank", weil die Ausstattungsliste direkt neben den Betten steht).
const ROOM_TYPE_RE = /(zimmer\b|\broom\b|suite|studio|apartment|appartement|bungalow|villa|chalet|cottage|penthouse|maisonette|schlafsaal|mehrbett|\bloft\b|\bzelt\b|\bcabin\b|\bdorm\b|deluxe|superior|standard|komfort|classic|\bking\b|\bqueen\b|\bdouble\b|\btwin\b|\bsingle\b)/i;
// Zeilen, die KEIN Zimmername sein koennen (Verfuegbarkeits-, Preis-, Belegungs-, Options-Zeilen).
const NOT_ROOM_RE = /m²|€|\$|\beur\b|usd|egp|cop|thb|inr|ars|try|lkr|vnd|idr|pkr|pen|mxn|php|jpy|inbegriffen|stornier|steuern|geb(ü|ue)hren|preis|gesamt|parkplatz|internet|wlan|frühstück|fruehstueck|zahlung|verf(ü|ue)gbar|wir haben noch|nur noch|belegung|erwachsen|g(ä|ae)ste|online|anzahl|abreise|anreise/i;

function isRoomName(lines, idx) {
  const l = (lines[idx] || '').trim();
  // Auch hier war die alte Grenze (55) zu eng. Dass eine Zeile ein Zimmername ist, entscheiden
  // die Pruefungen darunter (Zimmertyp-Wort vorhanden, keine Preis-/Belegungs-/Storno-Begriffe),
  // nicht ihre Laenge.
  if (l.length < 3 || l.length > ROOM_NAME_MAX_LEN) return false;
  if (l.includes(':')) return false;                 // "Schlafzimmer 1: ...", "Bis 12:00"
  if (/^\d/.test(l)) return false;                   // "1 Schlafsofa", "2 Einzelbetten und"
  if (!ROOM_TYPE_RE.test(l)) return false;           // muss ein Zimmertyp-Wort enthalten
  if (NOT_ROOM_RE.test(l)) return false;
  // Frueher stand hier: Zeile enthaelt eine Ziffer UND ein Bett-Wort -> kein Zimmername.
  // Die Regel sollte Zeilen wie "1 Schlafsofa" oder "2 Einzelbetten" aussortieren, hat aber
  // viel zu breit gegriffen: "Villa mit 1 Schlafzimmer, Kingsize-Bett und Schlafsofa" ist ein
  // voellig normaler Zimmername und flog ebenfalls raus. Die eigentlichen Bett-Zeilen faengt
  // schon der Test oben ab (sie beginnen mit einer Ziffer oder enthalten einen Doppelpunkt)
  // bzw. die Pflicht auf ein Zimmertyp-Wort.
  return true;
}

function listRooms(bodyText) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  const rooms = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (isRoomName(lines, i)) {
      const name = lines[i];
      const key = name.toLowerCase();
      if (!seen.has(key)) { seen.add(key); rooms.push(name); }
    }
  }
  return rooms;
}

// Verpflegungs-/Storno-Tokens aus einem Textabschnitt bestimmen (identisch zur In-Page-Logik,
// hier aber im Node-Kontext, damit wir die Optionen layout-unabhaengig direkt aus dem Seitentext
// je Zimmer ableiten koennen - die DOM-Tabellenerkennung greift nicht auf allen Booking-Layouts).
// Verpflegung ZEILENWEISE klassifizieren: Booking schreibt die Verpflegung je Tarif in EINE Zeile
// ("Frühstück inbegriffen" / "Frühstück & Abendessen inbegriffen" = Halbpension / "Frühstück,
// Mittagessen & Abendessen inbegriffen" = Vollpension). Nur so wird jeder Tarif korrekt getrennt.
function boardOfLine(line) {
  const l = (line || '').toLowerCase();
  if (/all[-\s]?inclusive/.test(l)) return 'allinclusive';
  if (/vollpension|mittagessen/.test(l)) return 'vollpension';
  if (/halbpension|abendessen/.test(l)) return 'halbpension';
  if (/fr(ü|ue)hst(ü|ue)ck/.test(l)) {
    if (/inbegriffen|inklus/.test(l)) return 'fruehstueck';   // "Frühstück inbegriffen"
    if (/€|eur|usd|\$|\d/.test(l)) return 'uebernachtung';     // "Frühstück € 23" = Aufpreis, NICHT inkl.
    return 'fruehstueck';
  }
  if (/ohne (fr(ü|ue)hst(ü|ue)ck|mahlzeit)|nur (ü|ue)bernachtung|room only|ohne verpflegung/.test(l)) return 'uebernachtung';
  return null;
}
// Storno ZEILENWEISE, und "nicht ..." VOR "kostenlos" pruefen - sonst matcht "Nicht kostenlos
// stornierbar" faelschlich als kostenlos (der Teilstring "kostenlos stornierbar" steckt darin).
function cancelOfLine(line) {
  const l = (line || '').toLowerCase();
  if (/nicht kostenlos stornierbar|nicht erstattbar|keine kostenlose stornierung/.test(l)) return 'nein';
  if (/teilweise erstattbar/.test(l)) return 'teilweise';
  if (/kostenlose stornierung|kostenlos stornierbar/.test(l)) return 'ja';
  return null;
}
function boardsFromText(t) {
  const set = new Set();
  for (const line of (t || '').split('\n')) {
    const b = boardOfLine(line);
    if (b) set.add(b);
  }
  return [...set];
}
function cancelsFromText(t) {
  const set = new Set();
  for (const line of (t || '').split('\n')) {
    const c = cancelOfLine(line);
    if (c) set.add(c);
  }
  return [...set];
}

// Fuer jeden Zimmernamen den Textabschnitt vom ersten Vorkommen bis zum naechsten Zimmernamen
// scannen und daraus Verpflegung/Storno bestimmen.
function computeRoomOptions(bodyText, names) {
  const lines = (bodyText || '').split('\n').map((l) => l.trim());
  const positions = names
    .map((n) => {
      const nl = n.toLowerCase();
      const idx = lines.findIndex((l) => l.toLowerCase().includes(nl));
      return { name: n, idx };
    })
    .filter((p) => p.idx >= 0)
    .sort((a, b) => a.idx - b.idx);
  const result = {};
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx;
    const end = i + 1 < positions.length ? positions[i + 1].idx : Math.min(lines.length, start + 60);
    const span = lines.slice(start, end).join('\n');
    result[positions[i].name] = { boards: boardsFromText(span), cancels: cancelsFromText(span) };
  }
  return result;
}

// Fehlende Verpflegungs-/Storno-Optionen (z.B. wenn nur die Namen aus dem DOM kamen) aus dem
// Seitentext ergaenzen. DOM-Werte haben Vorrang, sind aber oft leer.
function enrichRoomOptions(bodyText, rooms) {
  if (!bodyText || !rooms.length) return rooms;
  const opts = computeRoomOptions(bodyText, rooms.map((r) => r.name));
  return rooms.map((r) => {
    const c = opts[r.name] || { boards: [], cancels: [] };
    // Text-Erkennung (zeilenweise) hat Vorrang - sie ist am genauesten; DOM nur als Rueckfall.
    return {
      name: r.name,
      boards: c.boards.length ? c.boards : (r.boards || []),
      cancels: c.cancels.length ? c.cancels : (r.cancels || []),
    };
  });
}

// ---- HTTP Handler ------------------------------------------------------------------------

module.exports = async (req, res) => {
  const startTime = Date.now();
  res.setHeader('Access-Control-Allow-Origin', 'https://georates.tech');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ success: false, reason: 'method_not_allowed' }); return; }

  const { link, room, board, cancel, mode, turnstileToken } = req.body || {};

  // ---- Streaming ---------------------------------------------------------------------------
  // Ein vollstaendiger Laendervergleich dauert etwa eine Minute. Frueher schwieg der Server
  // diese ganze Zeit und schickte am Ende alles auf einmal - der Nutzer sass vor einem
  // Spinner und wusste nicht, ob ueberhaupt etwas passiert. Viele brechen dann ab.
  //
  // Mit stream:true schicken wir stattdessen NDJSON: pro fertigem Land sofort eine Zeile,
  // ganz am Ende eine "summary"-Zeile mit dem Gesamtergebnis. Das Frontend fuellt die Tabelle
  // damit live. Die Gesamtdauer aendert sich dadurch nicht - die gefuehlte Wartezeit schon,
  // weil nach ~20s die ersten echten Zahlen dastehen.
  //
  // Wichtig: Turnstile-Pruefung, Vergleichslogik und Logging bleiben hier im Server. Die
  // Alternative (mehrere parallele Requests aus dem Browser) haette genau das in den Client
  // verlagert, wo es manipulierbar waere.
  const wantsStream = !!(req.body && req.body.stream) && mode !== 'rooms';
  let streamOpen = false;
  const streamSend = (obj) => {
    if (!streamOpen) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { /* Verbindung weg - egal */ }
  };
  const openStream = () => {
    if (streamOpen) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Ohne diese Header puffern manche Zwischenschichten die Antwort, bis sie komplett ist -
    // dann waere das Streaming wirkungslos.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    streamOpen = true;
  };
  // Antwortet je nach Modus als Stream-Abschluss oder als klassisches JSON, damit der restliche
  // Code sich nicht um den Unterschied kuemmern muss.
  const respond = (statusCode, payload) => {
    if (wantsStream) {
      openStream();
      streamSend({ type: 'summary', ...payload });
      res.end();
    } else {
      res.status(statusCode).json(payload);
    }
  };

  // Modus "rooms": nur die Zimmerliste des Hotels laden (fuer das Auswahl-Dropdown im Formular).
  // Ein einziger Seitenabruf ueber das Ausgangsland, kein Laendervergleich. Kein Turnstile noetig
  // (leichter, seltener Abruf), aber weiterhin Proxy-/Link-Pruefung.
  if (mode === 'rooms') {
    if (!link || !/^https?:\/\/([a-z0-9-]+\.)*booking\.com\//i.test(link)) {
      res.status(400).json({ success: false, reason: 'invalid_link' });
      return;
    }
    const up = process.env.SMARTPROXY_USER_PREFIX;
    const pw = process.env.SMARTPROXY_PASSWORD;
    const srv = process.env.SMARTPROXY_SERVER || 'http://proxy.smartproxy.net:3120';
    if (!up || !pw) { res.status(200).json({ success: false, reason: 'proxy_not_configured' }); return; }
    try {
      try { await chromium.executablePath(CHROMIUM_PACK_URL); } catch (e) { /* Fehler taucht beim Launch erneut auf */ }
      const baselineCountry = detectBaselineCountry(link);

      // Zimmer zuerst aus den DOM-Links der Zimmertabelle nehmen (r.rooms, inkl. Verpflegungs-/
      // Storno-Optionen); nur wenn leer, faellt es auf die Text-Heuristik (nur Namen) zurueck.
      const roomsFrom = (r) => {
        const base = r.rooms && r.rooms.length
          ? r.rooms
          : listRooms(r.bodyText || '').map((name) => ({ name, boards: [], cancels: [] }));
        return enrichRoomOptions(r.bodyText || '', base);
      };
      const hasOpts = (rl) => rl.some((x) => (x.boards && x.boards.length) || (x.cancels && x.cancels.length));

      let withOpts = null;   // Zimmer inkl. Verpflegungs-/Storno-Optionen (bevorzugt)
      let namesOnly = null;  // Zimmer nur mit Namen (Fallback)
      let lastR = null;

      // 1) Ueber den Baseline-Proxy laden: NUR mit echter (Residential-)Verfuegbarkeit liefert
      //    Booking die Tarifzeilen mit Verpflegung/Storno. Ein Datacenter-Direktabruf bekommt zwar
      //    die Zimmernamen, aber keine Optionen - daher hier Proxy zuerst.
      const proxyAuth = { username: `${up}${baselineCountry}`, password: pw };
      // Messmodus: Mit noScripts:true laesst sich derselbe Abruf einmal mit und einmal ohne
      // Bookings JavaScript fahren, um Traffic-Ersparnis und Trefferquote zu vergleichen.
      const blockScripts = !!(req.body && req.body.noScripts);
      // Geraeteprofil: windows (Default), mac, android, iphone. Hier durchgereicht, damit sich
      // die Zimmerliste eines Geraets einzeln pruefen laesst - das ist der billigste Weg zu
      // sehen, ob der Parser die mobile Seitenstruktur ueberhaupt versteht.
      const device = (req.body && req.body.device) || DEFAULT_DEVICE;
      for (let a = 1; a <= 2 && !withOpts; a++) {
        const r = await attemptFetch(link, srv, proxyAuth, blockScripts, device);
        lastR = r;
        if (r.loadedOk) {
          const rl = roomsFrom(r);
          if (rl.length) { if (hasOpts(rl)) withOpts = rl; else if (!namesOnly) namesOnly = rl; }
        }
      }
      // 2) Falls der Proxy gar nichts brachte: kostenloser Direktabruf, wenigstens fuer die Namen.
      if (!withOpts && !namesOnly) {
        const r = await attemptFetch(link, null, null, blockScripts, device);
        lastR = r;
        if (r.loadedOk) { const rl = roomsFrom(r); if (rl.length) namesOnly = rl; }
      }
      const rooms = withOpts || namesOnly;
      if (!rooms) {
        const failPayload = { success: false, reason: 'rooms_not_loaded' };
        if (req.body && req.body.debug && lastR) failPayload.dbg = { roomMeta: lastR.roomMeta, loadedOk: lastR.loadedOk, bodyLen: (lastR.bodyText || '').length };
        res.status(200).json(failPayload);
        return;
      }
      const payload = { success: true, rooms, baselineCountry };
      if (req.body && req.body.debug && lastR) {
        payload.dbg = { roomMeta: lastR.roomMeta, bodyLen: (lastR.bodyText || '').length, loadedOk: lastR.loadedOk, transferKB: Math.round((lastR.transferBytes || 0) / 1024) };
        // Diagnose: die echte Preis-Erkennung gegen den vom Server geladenen Seitentext testen.
        try {
          const bt = lastR.bodyText || '';
          const ls = bt.split('\n').map((l) => l.trim()).filter(Boolean);
          payload.dbg.lineCount = ls.length;
          payload.dbg.minLines = MIN_LOADED_LINES;
          const rn = (rooms && rooms[0] && rooms[0].name) || '';
          const idx = ls.findIndex((l) => l.toLowerCase().startsWith(rn.toLowerCase()));
          const [amt] = rn ? findRoomPrice(bt, rn, '', '') : [null];
          payload.dbg.probe = { room: rn, roomLineIdx: idx, amount: amt, snippet: idx >= 0 ? ls.slice(idx, idx + 22) : [] };
          // Mit debug:'price' den ECHTEN Preis-Pfad fuers Ausgangsland durchlaufen lassen.
          if (req.body.debug === 'price' && rn) {
            // Ohne zweiten Browserstart: die Preis-Kette auf dem BEREITS geladenen Seitentext pruefen.
            const rr = await getLiveRates();
            const useRoom = req.body.room || rn;
            const [amt2, , curTok] = findRoomPrice(bt, useRoom, req.body.board || '', req.body.cancel || '');
            const cur = normalizeCurrency(curTok, DEFAULT_CURRENCY_BY_COUNTRY[baselineCountry] || 'EUR');
            const val = parseAmount(amt2);
            const rate = rr && rr[cur];
            payload.dbg.pricePath = {
              ratesOk: !!rr, room: useRoom, rawAmount: amt2, currencyToken: curTok, currency: cur,
              value: val, rate: rate || null,
              priceEuro: (val !== null && rate) ? Math.round(val * rate * 100) / 100 : null,
            };
          }
        } catch (e) { payload.dbg.probeErr = String(e); }
      }
      res.status(200).json(payload);
    } catch (err) {
      res.status(200).json({ success: false, reason: 'error', message: String((err && err.message) || err) });
    }
    return;
  }

  const remoteIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const humanOk = await verifyTurnstile(turnstileToken, remoteIp);
  if (!humanOk) {
    respond(403, { success: false, reason: 'bot_check_failed' });
    return;
  }

  // Herkunftsland des Besuchers (setzt Vercel am Edge). Nur das Laenderkuerzel, keine IP.
  const visitorCountry = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
  const herkunftsland = LOG_COUNTRY_LABEL[visitorCountry] || visitorCountry || 'unbekannt';

  // Jede Abfrage protokollieren - auch die erfolglosen. Die zeigen Traffic und belegen, dass die
  // Seite benutzt wird; ausserdem sieht man an den Status-Werten sofort, wo es klemmt.
  const logAttempt = (status, extra) => logQuery({
    hotelLink: link || '',
    room: room || '',
    board: LOG_BOARD_LABEL[board] || board || '',
    cancel: LOG_CANCEL_LABEL[cancel] || cancel || '',
    baselineLand: '',
    baselinePreisEuro: '',
    bestesLand: '',
    bestPreisEuro: '',
    bestPreisVorOrt: '',
    ersparnisProzent: '',
    ersparnisEuro: '',
    herkunftsland,
    relevant: 'nein',
    empfehlung: 'nein',
    status,
    ...(extra || {}),
  });

  if (!link || !/^https?:\/\/([a-z0-9-]+\.)*booking\.com\//i.test(link)) {
    await logAttempt('kein gültiger Booking-Link');
    respond(400, { success: false, reason: 'invalid_link' });
    return;
  }
  if (!room) {
    await logAttempt('kein Zimmer angegeben');
    respond(400, { success: false, reason: 'missing_room' });
    return;
  }

  const cacheKey = cacheKeyFor(link, room, board || '', cancel || '', (req.body && req.body.device) || DEFAULT_DEVICE);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    await logAttempt('aus Cache');
    // Aus dem Cache liegt alles sofort vor. Im Stream-Modus schicken wir die Laenderzeilen
    // trotzdem einzeln, damit das Frontend nur EINEN Darstellungsweg braucht.
    if (wantsStream) {
      openStream();
      streamSend({ type: 'meta', baselineCountry: cached.baselineCountry, fromCache: true, totalCountries: (cached.results || []).length });
      (cached.results || []).forEach((r) => streamSend({ type: 'country', result: r }));
    }
    respond(200, { ...cached, fromCache: true });
    return;
  }

  const userPrefix = process.env.SMARTPROXY_USER_PREFIX; // z.B. "smart-ut1nl7crifne_area-"
  const password = process.env.SMARTPROXY_PASSWORD;
  const proxyServer = process.env.SMARTPROXY_SERVER || 'http://proxy.smartproxy.net:3120';
  if (!userPrefix || !password) {
    respond(200, { success: false, reason: 'proxy_not_configured' });
    return;
  }

  try {
    // Verlaessliche Live-Wechselkurse sind Pflicht - ohne sie waere der Laendervergleich
    // wertlos. Sind beide Quellen nicht erreichbar, brechen wir sauber ab.
    const rates = await getLiveRates();
    if (!rates) {
      await logAttempt('Wechselkurse nicht erreichbar');
      respond(200, { success: false, reason: 'fx_unavailable' });
      return;
    }

    // Chromium EINMAL vorab entpacken. Danach koennen mehrere Browser gefahrlos gleichzeitig
    // starten (kein spawn ETXTBSY / libnss3.so-Race mehr) - so laeuft auch die Probe parallel.
    try { await chromium.executablePath(CHROMIUM_PACK_URL); } catch (e) { /* Fehler taucht beim Launch erneut auf */ }

    // Ausgangsland (Referenzpreis) aus dem Booking-Link ableiten - nicht zwingend Deutschland.
    const baselineCountry = detectBaselineCountry(link);

    // Geraeteprofil gilt fuer ALLE Laender derselben Abfrage. Sonst waere der Vergleich wertlos:
    // Wir wollen den Laendereffekt messen, nicht Land gegen Geraet.
    const device = (req.body && req.body.device) || DEFAULT_DEVICE;
    const deviceLabel = deviceProfile(device).label;

    // Probe: Ausgangsland + Guenstig-Kandidat (Kolumbien) PARALLEL, je 2 Versuche (Genauigkeit).
    const probeCountries = [baselineCountry];
    if (!probeCountries.includes(CHEAP_PROBE_COUNTRY)) probeCountries.push(CHEAP_PROBE_COUNTRY);

    if (wantsStream) {
      openStream();
      streamSend({ type: 'meta', baselineCountry, totalCountries: ALL_COUNTRIES.length });
    }
    // Im Stream-Modus geht jedes Land raus, SOBALD es fertig ist - nicht erst, wenn die ganze
    // Gruppe durch ist. Deshalb haengt der Versand am einzelnen Promise, nicht am Promise.all.
    // Sobald der Ausgangspreis feststeht, wird jeder weitere Landespreis schon VOR dem Senden
    // gegen ihn plausibilisiert. Sonst blitzt ein kaputter Wert (2,4 Mio. EUR) kurz in der
    // Live-Tabelle auf und verschwindet erst mit der Endauswertung wieder - das sieht aus,
    // als wuerde das Tool raten.
    let basePriceForGuard = null;
    const fetchAndStream = (c, attempts) =>
      fetchPrice(c, link, proxyServer, userPrefix, password, room, board, cancel, rates, attempts, device)
        .then((r) => {
          if (c !== baselineCountry && implausibleVsBaseline(r.priceEuro, basePriceForGuard)) {
            r.priceEuro = null;
            r.priceLocal = null;
            r.priceRaw = 'Preis nicht verlässlich erkannt';
            r.implausible = true;
          }
          streamSend({ type: 'country', result: r });
          return r;
        });

    let results = await Promise.all(probeCountries.map((c) => fetchAndStream(c, MAX_ATTEMPTS)));
    // Ab hier kennen wir den Referenzpreis - alle folgenden Laender laufen durch die Pruefung.
    const probeBase = results.find((r) => r.country === baselineCountry);
    basePriceForGuard = probeBase && probeBase.priceEuro != null ? probeBase.priceEuro : null;

    console.log('[check-price] Baseline:', baselineCountry, '| Probe-Ergebnis:',
      JSON.stringify(results.map((r) => ({ c: r.country, eur: r.priceEuro, raw: r.priceRaw }))));

    let summary = summarize(results, baselineCountry);
    let partial = false;

    // Frueher wurde hier abgebrochen, sobald Kolumbien mindestens 10% guenstiger war als das
    // Ausgangsland ("gut genug gefunden, Rest sparen"). Das ist raus, und zwar aus einem
    // belegbaren Grund: Am 17.09. lag bei derselben Suite Kolumbien bei 11%, Indien aber bei
    // 19,3%. Mit der alten Regel haette das Tool bei Kolumbien aufgehoert und 8 Prozentpunkte
    // liegen lassen - und dabei behauptet, das guenstigste Land gefunden zu haben.
    //
    // Die zwei urspruenglichen Gruende fuer den Abbruch sind beide entfallen: Ein Voll-Scan
    // passt inzwischen bequem ins Zeitlimit, und dank Streaming sieht der Nutzer den ersten
    // Treffer nach ~20s, muss also aufs Ende gar nicht warten, um ihn zu kennen.
    //
    // Uebrig bleibt nur der Proxy-Traffic. Den nehmen wir bewusst in Kauf: Ein Tool, das
    // verspricht das guenstigste Land zu finden, darf nicht bei "gut genug" stehenbleiben.
    // Solange nicht belegt ist, dass Kolumbien praktisch immer gewinnt, ist jeder frueh
    // abgebrochene Scan ausserdem ein Datenpunkt weniger fuer genau diese Frage.
    const probeConclusive = STOP_EARLY_ON_CLEAR_WIN && (() => {
      const baseR = results.find((r) => r.country === baselineCountry);
      const cheapR = results.find((r) => r.country === CHEAP_PROBE_COUNTRY);
      if (!baseR || !cheapR || baseR.priceEuro === null || cheapR.priceEuro === null) return false;
      const diffPct = ((cheapR.priceEuro - baseR.priceEuro) / baseR.priceEuro) * 100;
      return diffPct <= -PROBE_CONFIDENCE_THRESHOLD_PCT;
    })();

    if (!probeConclusive) {
      // Die restlichen Laender in PARALLELEN Gruppen pruefen (je 1 Versuch, damit's schnell
      // bleibt). Chromium ist bereits entpackt, daher ist Parallelitaet gefahrlos; die
      // Gruppengroesse begrenzt den Arbeitsspeicher.
      //
      // Die naechste Gruppe wird nur gestartet, wenn sie nach der bisher gemessenen Dauer
      // auch noch fertig wird. So laeuft die Funktion weder ins Vercel-Limit noch bricht sie
      // ab, obwohl noch Zeit fuer eine weitere Gruppe waere.
      const remaining = ALL_COUNTRIES.filter((c) => !probeCountries.includes(c));
      let batchEstimateMs = FIRST_BATCH_ESTIMATE_MS;
      for (let i = 0; i < remaining.length; i += EXPANSION_BATCH_SIZE) {
        const elapsed = Date.now() - startTime;
        if (elapsed + batchEstimateMs > HARD_DEADLINE_MS) {
          partial = true;
          console.log(`[check-price] Erweiterung gestoppt nach ${(elapsed / 1000).toFixed(1)}s: ` +
            `naechste Gruppe braucht geschaetzt ${(batchEstimateMs / 1000).toFixed(1)}s, ` +
            `Deadline ${(HARD_DEADLINE_MS / 1000).toFixed(0)}s. ` +
            `${remaining.length - i} Land/Laender ungeprueft.`);
          break;
        }
        const batch = remaining.slice(i, i + EXPANSION_BATCH_SIZE);
        const batchStart = Date.now();
        const batchResults = await Promise.all(batch.map((c) => fetchAndStream(c, EXPANSION_ATTEMPTS)));
        results.push(...batchResults);
        // Schaetzung fortschreiben: gemessene Dauer plus Sicherheitsaufschlag. Wir nehmen den
        // groesseren Wert aus alter und neuer Schaetzung nicht - sonst zieht ein einzelner
        // Ausreisser die Planung dauerhaft nach oben und wir pruefen weniger Laender als moeglich.
        batchEstimateMs = Math.round((Date.now() - batchStart) * BATCH_ESTIMATE_SAFETY);
      }
      summary = summarize(results, baselineCountry);
    }

    const payload = { ...summary, partial };
    if (summary.success) {
      await cacheSet(cacheKey, summary);
      // Jede (neue) erfolgreiche Abfrage in die Google-Tabelle loggen - als Deal-Sammlung.
      const baseRow = results.find((r) => r.country === baselineCountry);
      const best = summary.best;
      const basePrice = baseRow && baseRow.priceEuro != null ? baseRow.priceEuro : null;
      await logQuery({
        hotelLink: link,
        room: room || '',
        board: LOG_BOARD_LABEL[board] || board || '',
        cancel: LOG_CANCEL_LABEL[cancel] || cancel || '',
        baselineLand: LOG_COUNTRY_LABEL[baselineCountry] || baselineCountry,
        baselinePreisEuro: basePrice != null ? basePrice : '',
        bestesLand: LOG_COUNTRY_LABEL[best.country] || best.country,
        bestPreisEuro: best.priceEuro != null ? best.priceEuro : '',
        bestPreisVorOrt: best.priceLocal != null ? `${best.priceLocal} ${best.currency}` : '',
        ersparnisProzent: summary.savingsPct != null ? summary.savingsPct : '',
        ersparnisEuro: basePrice != null && best.priceEuro != null ? Math.round((basePrice - best.priceEuro) * 100) / 100 : '',
        // "ja" nur bei einem Unterschied, der kein Rundungsrauschen ist - so laesst sich die
        // Tabelle nach echten Funden filtern, statt 0,1-%-Treffer mitzuzaehlen.
        relevant: summary.relevantSaving ? 'ja' : 'nein',
        empfehlung: summary.recommendVpnCountry ? 'ja' : 'nein',
        herkunftsland,
        // Bei einem gekuerzten Lauf gehoert in die Tabelle, WIE stark gekuerzt wurde - sonst
        // laesst sich spaeter nicht beurteilen, ob ein "kein Fund" belastbar ist.
        // Dazu der Proxy-Verbrauch dieser Abfrage: Nur so laesst sich sehen, was eine Suche
        // wirklich kostet, ohne es jedes Mal aus dem Smartproxy-Dashboard zurueckzurechnen.
        // Das Geraet gehoert mit in die Zeile: Ohne diese Angabe liessen sich Desktop- und
        // Mobil-Messungen in der Tabelle spaeter nicht mehr auseinanderhalten.
        status: (partial ? `ok (nur ${results.length} von ${ALL_COUNTRIES.length} Ländern – Zeitlimit)` : 'ok')
          + ` · ${deviceLabel}`
          + ` · ${Math.round(results.reduce((s, r) => s + (r.transferBytes || 0), 0) / (1024 * 1024))} MB`,
      });
    } else {
      // Im Log festhalten, ob der Link Reisedaten enthielt. Ohne checkin/checkout sucht Booking
      // sich selbst einen Termin und zeigt haeufig gar keine Zimmertabelle - das war am 17.09.
      // die Ursache saemtlicher Fehlschlaege. So laesst sich spaeter auszaehlen, wie oft es
      // wirklich daran liegt, statt es zu vermuten.
      const hatDatum = /[?&](checkin|checkout)=/i.test(link) || /[?&]checkin_year=/i.test(link);
      await logAttempt(hatDatum ? 'kein Preis gefunden' : 'kein Preis gefunden (Link ohne Reisedaten)',
        { baselineLand: LOG_COUNTRY_LABEL[baselineCountry] || baselineCountry });
    }
    respond(200, payload);
  } catch (err) {
    try { await logAttempt('Fehler: ' + String((err && err.message) || err).slice(0, 120)); } catch (e) { /* Logging ist optional */ }
    respond(200, { success: false, reason: 'error', message: String((err && err.message) || err) });
  }
};
