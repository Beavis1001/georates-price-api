// Serverless Function: GeoRates Geo-Preisvergleich. Prueft den Preis eines konkreten
// Booking.com-Zimmers ueber Proxy-Sessions aus mehreren Laendern (Smartproxy) und meldet
// zurueck, ob ein Laenderwechsel (VPN) eine relevante Ersparnis bringt. Portiert die bereits
// gehaertete Parsing-Logik aus dem lokalen `hotel_compare.py`-Skript nach JavaScript.
//
// Kostenschutz (echter Proxy-Traffic kostet Geld, daher mehrfach abgesichert):
//   1. Cloudflare Turnstile Bot-Check vor jeder Anfrage (siehe verifyTurnstile).
//   2. Ergebnis-Cache (Upstash Redis, 24h) - identische Anfragen loesen keinen neuen
//      Proxy-Traffic aus.
//   3. Bilder/Fonts/Stylesheets werden beim Laden geblockt (nur Text noetig).
//   4. Erst DE+CO parallel als schnelle Probe; nur wenn das keine klare Ersparnis zeigt,
//      werden weitere Laender NACHEINANDER (nicht alle parallel, wegen Arbeitsspeicher)
//      geprueft - begrenzt durch ein Zeitbudget, damit die Funktion nicht am Vercel-
//      Zeitlimit scheitert. Wird das Budget waehrend der Erweiterung aufgebraucht, liefert
//      die Antwort die bis dahin geprueften Laender plus partial:true zurueck.

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
// Kolumbien (bzw. das beste Land) muss MINDESTENS so viel Prozent guenstiger sein als das
// Ausgangsland, damit die Probe als eindeutig gilt bzw. ein Laenderwechsel empfohlen wird.
const PROBE_CONFIDENCE_THRESHOLD_PCT = 10.0;
// Ausgangsland + Kolumbien: 2 Versuche (Referenzpreis MUSS verlaesslich sein). Dank der kurzen
// Einzel-Timeouts unten bleiben selbst 2 Versuche pro Land klar unter dem 60s-Limit von Vercel.
// Die zusaetzlichen Laender bekommen nur 1 Versuch (Tempo; ein verpasstes Land ist unkritisch).
const MAX_ATTEMPTS = 2;
const EXPANSION_ATTEMPTS = 1;
const BATCH_SIZE = 3;            // wie viele Laender gleichzeitig (Arbeitsspeicher-Grenze)
const MIN_LOADED_LINES = 300;
// Vor jeder neuen Ländergruppe pruefen: ist mehr Zeit als dieses Budget verstrichen, wird
// abgebrochen. 36s + max. eine ~20s-Gruppe + Antwort bleibt sicher unter dem 60s-Limit.
const TIME_BUDGET_MS = 36000;
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

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet', 'other']);

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

// ---- Preis-Parsing (1:1 Logik-Port aus hotel_compare.py) -------------------------------

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
  if (idx >= lines.length || lines[idx].length > 60) return false;
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
      rawTiers.push({ amount: pm[2], anchor: k });
    } else if (TAX_LINE_RE.test(lines[k])) {
      let amount = null;
      for (let back = k - 1; back > Math.max(k - 1 - BACKSCAN_LINES, start); back--) {
        const m = AMOUNT_LINE_RE.exec(lines[back]);
        if (m) { amount = m[2]; break; }
        if (back === lastAmountLine) break;
      }
      if (amount) rawTiers.push({ amount, anchor: k });
    }
    k++;
  }

  if (!rawTiers.length) return [null, null];

  // Kontext je Ratenstufe bis zur NAECHSTEN Stufe begrenzen (max. 14 Zeilen), damit die
  // Verpflegungs-/Stornierungserkennung nicht in die naechste Rate "ausblutet".
  const tiers = rawTiers.map((t, i) => {
    const nextAnchor = i + 1 < rawTiers.length ? rawTiers[i + 1].anchor : lines.length;
    const end = Math.min(nextAnchor, t.anchor + 14);
    return [t.amount, lines.slice(t.anchor, end).join('\n')];
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
  const isFree = (ctx) => /kostenlose stornierung|kostenlos stornierbar/i.test(ctx);
  const isPartial = (ctx) => /teilweise erstattbar/i.test(ctx);
  const isNonRef = (ctx) => /nicht kostenlos stornierbar|nicht erstattbar|keine kostenlose stornierung/i.test(ctx);
  const matchesCancel = (ctx) => {
    if (cancelPref === 'ja') return isFree(ctx);
    if (cancelPref === 'teilweise') return isPartial(ctx);
    if (cancelPref === 'nein') return isNonRef(ctx);
    return true; // "unsicher"/leer -> egal
  };

  // Auswahl-Priorität: 1) Verpflegung UND Stornier-Wunsch, 2) nur Verpflegung,
  // 3) nur Stornier-Wunsch, 4) erste gefundene Stufe.
  for (const t of tiers) if (matchesBoard(t[1]) && matchesCancel(t[1])) return t;
  for (const t of tiers) if (matchesBoard(t[1])) return t;
  for (const t of tiers) if (matchesCancel(t[1])) return t;
  return tiers[0];
}

function detectSessionCurrency(bodyText) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines.slice(0, 8)) {
    if (/^[A-Z]{3}$/.test(l)) return l;
  }
  return null;
}

// ---- Ein Land pruefen (Proxy + Headless-Chrome, Bilder/Fonts/Stylesheets geblockt) --------

async function attemptFetch(targetUrl, proxyServer, proxyAuth) {
  let browser;
  try {
    const launchArgs = proxyServer ? [...chromium.args, `--proxy-server=${proxyServer}`] : [...chromium.args];
    browser = await puppeteer.launch({
      args: launchArgs,
      defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    if (proxyServer && proxyAuth) await page.authenticate(proxyAuth);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 13000 });

    for (const sel of ["button ::-p-text('Alle akzeptieren')", '#onetrust-accept-btn-handler']) {
      try {
        await page.click(sel, { timeout: 1200 });
        break;
      } catch (e) { /* kein Banner - ignorieren */ }
    }

    try {
      await page.waitForFunction(
        () => /Zimmerkategorie|Preis für/i.test(document.body.innerText),
        { timeout: 6000 }
      );
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    try {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await new Promise((r) => setTimeout(r, 1200));
    } catch (e) { /* ignorieren */ }

    const bodyText = await page.evaluate(() => document.body.innerText);

    // Zimmer direkt aus dem DOM der Zimmertabelle lesen: pro Zeile der erste Link (= der blaue
    // Zimmername, exakt was der Nutzer sieht) plus die in DIESEM Zimmerblock real vorhandenen
    // Verpflegungs- und Storno-Optionen (ueber alle Tarifzeilen des Zimmers). Viel zuverlaessiger
    // als aus dem reinen Text zu raten.
    let roomData = [];
    let roomMeta = null;
    try {
      const ev = await page.evaluate(() => {
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
          if (!ths.some((h) => /zimmerkategorie|unterkunftstyp|zimmertyp|room type/.test(h))) continue;
          let cur = null;
          for (const row of tbl.querySelectorAll('tr')) {
            const firstTd = [...row.children].find((c) => c.tagName === 'TD');
            if (!firstTd) continue;
            const a = firstTd.querySelector('a');
            const nm = a ? clean(a.innerText) : '';
            if (nm && nm.length >= 3 && nm.length <= 70) cur = nm;
            if (cur) addRow(cur, row.innerText);
          }
          if (order.length) { strategy = 1; break; }
        }
        // Strategie 2 (Fallback): nur Namen aus bekannten Zimmernamen-Links.
        if (!order.length) {
          const sel = 'a.hprt-roomtype-icon-link, .hprt-roomtype-link, [data-testid="room-name"], [data-testid="rt-title"], [data-component="room-type-name"]';
          for (const el of document.querySelectorAll(sel)) {
            const nm = clean(el.innerText || el.textContent);
            if (nm && nm.length >= 3 && nm.length <= 70) addRow(nm, '');
          }
          if (order.length) strategy = 2;
        }
        const rooms = order.map((name) => ({ name, boards: boardsOf(map[name]), cancels: cancelsOf(map[name]) }));
        const meta = {
          strategy,
          tablesTotal,
          firstOptSample: order.length ? (map[order[0]] || '').slice(0, 260) : '',
          bodyHasFruehstueck: /fr(ü|ue)hst(ü|ue)ck/i.test(document.body.innerText),
          bodyHasStorno: /stornier/i.test(document.body.innerText),
        };
        return { rooms, meta };
      });
      roomData = ev.rooms || [];
      roomMeta = ev.meta || null;
    } catch (e) { roomData = []; }

    await browser.close();
    return { bodyText, rooms: roomData, roomMeta, loadedOk: bodyText.split('\n').length >= MIN_LOADED_LINES, err: null };
  } catch (err) {
    console.error('[attemptFetch] Fehler beim Laden/Chromium-Start:', (err && err.stack) || err);
    if (browser) { try { await browser.close(); } catch (e) { /* ignorieren */ } }
    return { bodyText: null, rooms: [], loadedOk: false, err };
  }
}

async function fetchPrice(countryCode, targetUrl, proxyServer, userPrefix, password, room, board, cancel, rates, maxAttempts) {
  const attempts = maxAttempts || MAX_ATTEMPTS;
  const t0 = Date.now();
  const proxyAuth = { username: `${userPrefix}${countryCode}`, password };
  const expectedCurrency = DEFAULT_CURRENCY_BY_COUNTRY[countryCode];
  const result = { country: countryCode, priceRaw: null, currency: null, priceLocal: null, priceEuro: null };

  let bodyText = null;
  let loadedOk = false;
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await attemptFetch(targetUrl, proxyServer, proxyAuth);
    bodyText = r.bodyText;
    loadedOk = r.loadedOk;
    lastErr = r.err;
    if (loadedOk && expectedCurrency) {
      const seen = detectSessionCurrency(bodyText);
      if (seen && seen !== expectedCurrency) loadedOk = false;
    }
    if (loadedOk) break;
  }

  console.log(`[fetchPrice] ${countryCode}: ${loadedOk ? 'ok' : 'kein Preis'} nach ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!loadedOk) {
    result.priceRaw = lastErr ? `Fehler: ${lastErr.message || lastErr}` : 'Seite nicht vollständig geladen (Proxy-Exit instabil)';
    return result;
  }

  const currency = expectedCurrency || 'EUR';
  const [rawAmt, ctx] = findRoomPrice(bodyText, room, board, cancel);
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

function cacheKeyFor(link, room, board, cancel) {
  return 'georates:' + crypto.createHash('sha256').update(`${link}|${room}|${board}|${cancel}`).digest('hex').slice(0, 32);
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

// ---- Gesamtergebnis aus Einzelländern ableiten --------------------------------------------

function summarize(results, baselineCountry) {
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
  return { success: true, results, best, savingsPct, recommendVpnCountry, baselineCountry };
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
  if (l.length < 3 || l.length > 55) return false;
  if (l.includes(':')) return false;                 // "Schlafzimmer 1: ...", "Bis 12:00"
  if (/^\d/.test(l)) return false;                   // "1 Schlafsofa", "2 Einzelbetten und"
  if (!ROOM_TYPE_RE.test(l)) return false;           // muss ein Zimmertyp-Wort enthalten
  if (NOT_ROOM_RE.test(l)) return false;
  if (/\d/.test(l) && BED_RE.test(l)) return false;  // Bett-Angabe, kein Name
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
  if (/fr(ü|ue)hst(ü|ue)ck/.test(l)) return 'fruehstueck';
  if (/ohne (fr(ü|ue)hst(ü|ue)ck|mahlzeit)|nur (ü|ue)bernachtung|room only|ohne verpflegung/.test(l)) return 'uebernachtung';
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
  t = (t || '').toLowerCase();
  const c = [];
  if (/kostenlose stornierung|kostenlos stornierbar/.test(t)) c.push('ja');
  if (/teilweise erstattbar/.test(t)) c.push('teilweise');
  if (/nicht erstattbar|nicht kostenlos stornierbar|keine kostenlose stornierung/.test(t)) c.push('nein');
  return [...new Set(c)];
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
      for (let a = 1; a <= 2 && !withOpts; a++) {
        const r = await attemptFetch(link, srv, proxyAuth);
        lastR = r;
        if (r.loadedOk) {
          const rl = roomsFrom(r);
          if (rl.length) { if (hasOpts(rl)) withOpts = rl; else if (!namesOnly) namesOnly = rl; }
        }
      }
      // 2) Falls der Proxy gar nichts brachte: kostenloser Direktabruf, wenigstens fuer die Namen.
      if (!withOpts && !namesOnly) {
        const r = await attemptFetch(link, null, null);
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
      if (req.body && req.body.debug && lastR) payload.dbg = { roomMeta: lastR.roomMeta, bodyLen: (lastR.bodyText || '').length };
      res.status(200).json(payload);
    } catch (err) {
      res.status(200).json({ success: false, reason: 'error', message: String((err && err.message) || err) });
    }
    return;
  }

  const remoteIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const humanOk = await verifyTurnstile(turnstileToken, remoteIp);
  if (!humanOk) {
    res.status(403).json({ success: false, reason: 'bot_check_failed' });
    return;
  }

  if (!link || !/^https?:\/\/([a-z0-9-]+\.)*booking\.com\//i.test(link)) {
    res.status(400).json({ success: false, reason: 'invalid_link' });
    return;
  }
  if (!room) {
    res.status(400).json({ success: false, reason: 'missing_room' });
    return;
  }

  const cacheKey = cacheKeyFor(link, room, board || '', cancel || '');
  const cached = await cacheGet(cacheKey);
  if (cached) {
    res.status(200).json({ ...cached, fromCache: true });
    return;
  }

  const userPrefix = process.env.SMARTPROXY_USER_PREFIX; // z.B. "smart-ut1nl7crifne_area-"
  const password = process.env.SMARTPROXY_PASSWORD;
  const proxyServer = process.env.SMARTPROXY_SERVER || 'http://proxy.smartproxy.net:3120';
  if (!userPrefix || !password) {
    res.status(200).json({ success: false, reason: 'proxy_not_configured' });
    return;
  }

  try {
    // Verlaessliche Live-Wechselkurse sind Pflicht - ohne sie waere der Laendervergleich
    // wertlos. Sind beide Quellen nicht erreichbar, brechen wir sauber ab.
    const rates = await getLiveRates();
    if (!rates) {
      res.status(200).json({ success: false, reason: 'fx_unavailable' });
      return;
    }

    // Chromium EINMAL vorab entpacken. Danach koennen mehrere Browser gefahrlos gleichzeitig
    // starten (kein spawn ETXTBSY / libnss3.so-Race mehr) - so laeuft auch die Probe parallel.
    try { await chromium.executablePath(CHROMIUM_PACK_URL); } catch (e) { /* Fehler taucht beim Launch erneut auf */ }

    // Ausgangsland (Referenzpreis) aus dem Booking-Link ableiten - nicht zwingend Deutschland.
    const baselineCountry = detectBaselineCountry(link);

    // Probe: Ausgangsland + Guenstig-Kandidat (Kolumbien) PARALLEL, je 2 Versuche (Genauigkeit).
    const probeCountries = [baselineCountry];
    if (!probeCountries.includes(CHEAP_PROBE_COUNTRY)) probeCountries.push(CHEAP_PROBE_COUNTRY);

    let results = await Promise.all(
      probeCountries.map((c) => fetchPrice(c, link, proxyServer, userPrefix, password, room, board, cancel, rates, MAX_ATTEMPTS))
    );

    console.log('[check-price] Baseline:', baselineCountry, '| Probe-Ergebnis:',
      JSON.stringify(results.map((r) => ({ c: r.country, eur: r.priceEuro, raw: r.priceRaw }))));

    let summary = summarize(results, baselineCountry);
    let partial = false;

    // Erweitern, wenn der Guenstig-Kandidat nicht mindestens 10% guenstiger als das Ausgangsland
    // ist (oder das Ausgangsland/CO keinen Preis lieferte). Dann alle restlichen Laender pruefen.
    const baseR = results.find((r) => r.country === baselineCountry);
    const cheapR = results.find((r) => r.country === CHEAP_PROBE_COUNTRY);
    let probeConclusive = false;
    if (baseR && cheapR && baseR.priceEuro !== null && cheapR.priceEuro !== null) {
      const diffPct = ((cheapR.priceEuro - baseR.priceEuro) / baseR.priceEuro) * 100;
      probeConclusive = diffPct <= -PROBE_CONFIDENCE_THRESHOLD_PCT;
    }

    if (!probeConclusive) {
      // Die restlichen Laender in PARALLELEN Gruppen pruefen (je 1 Versuch, damit's schnell
      // bleibt). Chromium ist bereits entpackt, daher ist Parallelitaet gefahrlos; die
      // Gruppengroesse begrenzt den Arbeitsspeicher. Zeitbudget stoppt vor dem Vercel-Limit.
      const remaining = ALL_COUNTRIES.filter((c) => !probeCountries.includes(c));
      for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
        if (Date.now() - startTime > TIME_BUDGET_MS) { partial = true; break; }
        const batch = remaining.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map((c) => fetchPrice(c, link, proxyServer, userPrefix, password, room, board, cancel, rates, EXPANSION_ATTEMPTS))
        );
        results.push(...batchResults);
      }
      summary = summarize(results, baselineCountry);
    }

    const payload = { ...summary, partial };
    if (summary.success) await cacheSet(cacheKey, summary);
    res.status(200).json(payload);
  } catch (err) {
    res.status(200).json({ success: false, reason: 'error', message: String((err && err.message) || err) });
  }
};
