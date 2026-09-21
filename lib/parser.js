// Preis-Parser von GeoRates: reine Textfunktionen ohne Netzwerk und ohne Browser.
// Alles hier ist ueber test/parser-test.js abgedeckt und darf keine Abhaengigkeit auf Puppeteer haben.

const { ROOM_NAME_MAX_LEN, ALL_COUNTRIES, RELEVANT_SAVINGS_PCT, RELEVANT_SAVINGS_PCT_CONVERTED, PROBE_CONFIDENCE_THRESHOLD_PCT, DEFAULT_CURRENCY_BY_COUNTRY } = require('./config');

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
// Genius ist Bookings Treueprogramm. Der Rabatt gilt NUR eingeloggt ("...wenn Sie sich
// anmelden oder sich kostenlos registrieren"), Booking zieht ihn aber trotzdem von der
// "Gesamt"-Summe ab, die eine ausgeloggte Sitzung angezeigt bekommt.
//
// Hinweis (20.09.2026): Der Betrag wird nur noch MITGEFUEHRT, nicht mehr herausgerechnet -
// siehe die ausfuehrliche Begruendung in lib/browser.js. "Genius-Praemien" (Sammelbegriff
// weiter unten auf der Seite) darf hier weiterhin NICHT greifen.
const GENIUS_LINE_RE = /genius[-\s]?rabatt/i;
const NEG_AMOUNT_RE = /^[-–−]\s*([^\d\s]{1,6})\s*([\d][\d.,]*)\s*$/;
const BACKSCAN_LINES = 6;
// Deal-Plaketten, wie Booking sie im deutschen Layout schreibt. Schluessel sind sprachneutral,
// das Frontend uebersetzt sie. "Genius" hier NUR als Hinweis - herausgerechnet wird nichts mehr.
const DEAL_MUSTER = [
  { key: 'mobile', re: /mobile[- ]?(rate|preis|deal|angebot)|mobil(er|e)?[- ]?(rate|preis|rabatt)/i },
  { key: 'online_payment', re: /online[- ]?zahlung|bei online-zahlung|booking\.com bezahlt|zahl(en|ung) (jetzt|online).*(rabatt|sparen)/i },
  { key: 'genius', re: /genius/i },
  { key: 'early', re: /fr(ü|ue)hbucher|early[- ]?booker/i },
  { key: 'last_minute', re: /kurzfristig|last[- ]?minute|zeitlich begrenzt|limited[- ]?time|nur (noch )?heute/i },
  { key: 'secret', re: /geheimangebot|secret deal|geheim/i },
  { key: 'deal', re: /^\s*(deal|angebot|rabatt|sparen sie|sie sparen)\b|\bdeal\b/i },
];

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

// Zerlegt den Textblock eines Zimmers in seine Tarifstufen. Ausgelagert, weil BEIDE Stellen
// dieselbe Sicht brauchen: die Preis-Erkennung unten und die Verpflegungs-/Storno-Optionen
// fuers Dropdown. Solange die Optionsliste anders segmentierte als der Parser, bot das
// Formular Tarife an, die es nicht gab - und verschwieg welche, die es gab.
function tarifstufen(lines, start, maxEnd) {
  const rawTiers = []; // { amount, cur, anchor, blockStart }
  let lastAmountLine = -1;
  let k = start + 1;
  while (k < maxEnd) {
    if (rawTiers.length && looksLikeNewRoomHeading(lines, k)) break;

    const pm = PRICE_PREFIX_RE.exec(lines[k]);
    if (pm) {
      lastAmountLine = k;
      rawTiers.push({ amount: pm[2], cur: pm[1], anchor: k, blockStart: rawTiers.length ? rawTiers[rawTiers.length - 1].anchor + 1 : start });
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
        if (amount) rawTiers.push({ amount, cur, anchor: k, blockStart: rawTiers.length ? rawTiers[rawTiers.length - 1].anchor + 1 : start });
      }
    }
    k++;
  }
  if (!rawTiers.length) return [];

  // Genius-Abzug dieser Stufe suchen. Er steht VOR der "Gesamt"-Zeile, also im Block zwischen
  // der vorigen Stufe und dem Anker dieser Stufe - der Kontext ab Anker reicht dafuer nicht.
  const geniusAbzugIm = (blockStart, anchor) => {
    for (let i = Math.max(0, blockStart); i <= anchor && i < lines.length; i++) {
      if (!GENIUS_LINE_RE.test(lines[i])) continue;
      for (let j = i + 1; j <= Math.min(i + 2, anchor); j++) {
        const m = NEG_AMOUNT_RE.exec(lines[j]);
        if (m) { const v = parseAmount(m[2]); if (v !== null) return v; }
      }
    }
    return null;
  };

  // Deal-Zeilen einer Stufe einsammeln. Booking wuerfelt nicht: Was wie Lotto aussieht, ist eine
  // Zuteilung pro Sitzung - Mobile Rate, Rabatt fuer Online-Zahlung, Kurzfristig-Deal, Genius.
  // Am 20.09.2026 war Indien nur wegen "Booking.com bezahlt -27.413 INR" guenstiger, ein
  // Zahlungsart-Rabatt, kein Landespreis. Wer den Grund nicht mitliest, meldet den Rabatt als
  // Laenderunterschied. Deshalb steht ab jetzt an jeder Stufe, welche Deals im Block standen.
  // Gesucht wird im ganzen Block der Stufe (vor UND nach der Gesamt-Zeile), weil Booking die
  // Deal-Plakette mal ueber, mal unter den Preis setzt.
  const dealsIm = (von, bis) => {
    const gefunden = new Set();
    for (let i = Math.max(0, von); i < Math.min(bis, lines.length); i++) {
      for (const d of DEAL_MUSTER) if (d.re.test(lines[i])) gefunden.add(d.key);
    }
    // "deal" ist der Sammelbegriff fuer Plaketten ohne erkennbaren Grund. Steht ein konkreter
    // Grund daneben (Online-Zahlung, Mobile Rate ...), traegt der Sammelbegriff nichts bei.
    if (gefunden.size > 1) gefunden.delete('deal');
    return [...gefunden];
  };

  // Kontext je Stufe bis zur NAECHSTEN Stufe begrenzen (max. 14 Zeilen), damit die
  // Verpflegungs-/Stornierungserkennung nicht in die naechste Rate "ausblutet".
  return rawTiers.map((t, i) => {
    // Ende der letzten Stufe am Fenster des Zimmers festmachen, NICHT am Dateiende: sonst
    // blutet der Kontext ins naechste Zimmer und dessen "Fruehstueck inbegriffen" wird
    // faelschlich diesem Zimmer zugeschrieben.
    const nextAnchor = i + 1 < rawTiers.length ? rawTiers[i + 1].anchor : maxEnd;
    const end = Math.min(nextAnchor, t.anchor + 14);
    return {
      amount: t.amount, cur: t.cur, anchor: t.anchor, blockStart: t.blockStart,
      ctx: lines.slice(t.anchor, end).join('\n'),
      genius: geniusAbzugIm(t.blockStart, t.anchor),
      deals: dealsIm(t.blockStart, end),
    };
  });
}

function findRoomPrice(bodyText, roomName, boardType, cancelPref) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  const roomLower = roomName.toLowerCase();

  // ALLE Fundstellen des Zimmernamens sammeln, nicht nur die erste.
  //
  // Anlass (21.09.2026, Horizon of Pattaya, deutsche Sitzung): Sechs Abrufe derselben Seite
  // lieferten abwechselnd 452,84 und 462,24 EUR - zwei Tarife DESSELBEN Zimmers, einmal nicht
  // stornierbar, einmal kostenlos stornierbar. Die Ursache lag nicht bei Booking, sondern hier:
  // Der Anker war die ERSTE Zeile, die mit dem Zimmernamen beginnt, und die lag mal vor, mal
  // hinter dem ersten Tarifblock. Je nachdem stand eine andere Stufe an Position 0 - und
  // "erste Stufe" ist unten die letzte Rueckfallregel, die in der Praxis oft greift.
  //
  // Aus allen Fundstellen wird eine Liste: Dubletten (dieselbe Ankerzeile aus zwei
  // Fundstellen) fliegen raus, sortiert wird nach Position im Text. Damit ist die Auswahl
  // reproduzierbar, egal wo der erste Namenstreffer lag.
  //
  // NICHT geloest ist damit, dass die Stufenliste bis zu 250 Zeilen weit laeuft und dabei ins
  // FOLGEZIMMER bluten kann (in test/seite-genius.txt sammelt "Superior Double Room" die 300
  // des Komfort-Doppelzimmers mit ein). Das faellt bisher nicht auf, weil unten immer die
  // erste PASSENDE Stufe gewinnt und die zum richtigen Zimmer gehoert. Solange das so ist,
  // darf hier keine Regel "nimm die guenstigste Stufe" stehen - die wuerde bei einem
  // billigeren Nachbarzimmer dessen Preis unter dem falschen Namen melden.
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l === roomLower || l.startsWith(roomLower)) starts.push(i);
  }
  if (!starts.length) return [null, null];

  const gesehen = new Set();
  const stufen = [];
  for (const s of starts) {
    for (const t of tarifstufen(lines, s, Math.min(s + 250, lines.length))) {
      if (gesehen.has(t.anchor)) continue;
      gesehen.add(t.anchor);
      stufen.push(t);
    }
  }
  if (!stufen.length) return [null, null];
  stufen.sort((a, b) => a.anchor - b.anchor);
  const tiers = stufen.map((t) => [t.amount, t.ctx, t.cur, t.genius, t.deals || []]);

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

  // Die gewaehlte Stufe gibt zusaetzlich preis, WAS sie ist: Storno- und Verpflegungsart.
  // Ohne diese Angabe laesst sich im Ergebnis nicht erkennen, ob zwei Laender denselben Tarif
  // verglichen haben - und genau daran haengt, ob eine gemeldete Ersparnis echt ist.
  // Siebtes Element: die Deal-Plaketten dieser Stufe (siehe DEAL_MUSTER).
  const mitTarifart = (t) => (t ? [t[0], t[1], t[2], t[3], cancelOfCtx(t[1]), boardOfCtx(t[1]), t[4] || []] : t);

  // 1. Verpflegung passt UND Storno passt ausdruecklich
  for (const t of tiers) if (matchesBoard(t[1]) && stornoAusdruecklichPasst(t[1])) return mitTarifart(t);
  // 2. Storno passt ausdruecklich, Verpflegung passt oder steht gar nicht dabei
  for (const t of tiers) if ((matchesBoard(t[1]) || !hatBoardInfo(t[1])) && stornoAusdruecklichPasst(t[1])) return mitTarifart(t);
  // 3./4./5. wie bisher: erst beides locker, dann Verpflegung, dann Storno, dann erste Stufe
  for (const t of tiers) if (matchesBoard(t[1]) && matchesCancel(t[1])) return mitTarifart(t);
  for (const t of tiers) if (matchesBoard(t[1])) return mitTarifart(t);
  for (const t of tiers) if (matchesCancel(t[1])) return mitTarifart(t);
  return mitTarifart(tiers[0]);
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

// opts.userPriceEuro: der Preis, den der Nutzer in seinem eigenen Browser sieht. Booking teilt
// Preise pro Sitzung zu; unsere Proxy-Sitzung zieht ein anderes Los als seine. Der Vorwurf "ihr
// rechnet den Ausgangspreis hoch, damit die Ersparnis groesser aussieht" trifft nur die Referenz -
// also wird gegen den NIEDRIGEREN von beiden gerechnet. Die Ersparnis ist damit im Zweifel
// unterschaetzt, nie ueberschaetzt.
function summarize(results, baselineCountry, opts) {
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
  if (!withPrice.length) {
    // Die Diagnose des Ausgangslandes mitgeben (nur die ist aussagekraeftig: dort wurde die
    // Seite in der Sprache und Waehrung geladen, die der Nutzer selbst sieht).
    const baseDiag = (baseRow && baseRow.diagnose) || (results.find((r) => r.diagnose) || {}).diagnose || null;
    return { success: false, reason: 'price_not_found', results, baselineCountry, diagnose: baseDiag };
  }

  const best = withPrice.reduce((a, b) => (b.priceEuro < a.priceEuro ? b : a));
  const baseline = results.find((r) => r.country === baselineCountry);
  const userPriceEuro = opts && Number.isFinite(opts.userPriceEuro) && opts.userPriceEuro > 0 ? opts.userPriceEuro : null;
  // Referenz: unser Ausgangspreis, aber nie hoeher als das, was der Nutzer selbst sieht.
  let baselineUsedEuro = baseline && baseline.priceEuro !== null ? baseline.priceEuro : null;
  let userPriceDiffers = false;
  if (userPriceEuro !== null && baselineUsedEuro !== null) {
    userPriceDiffers = Math.abs(userPriceEuro - baselineUsedEuro) / baselineUsedEuro >= 0.005;
    baselineUsedEuro = Math.min(baselineUsedEuro, userPriceEuro);
  } else if (userPriceEuro !== null) {
    baselineUsedEuro = userPriceEuro;
  }
  let savingsPct = null;
  let recommendVpnCountry = null;
  if (baselineUsedEuro !== null && best.country !== baselineCountry) {
    savingsPct = Math.round(((baselineUsedEuro - best.priceEuro) / baselineUsedEuro) * 1000) / 10;
    if (savingsPct >= PROBE_CONFIDENCE_THRESHOLD_PCT) recommendVpnCountry = best.country;
  }
  // Nur ab RELEVANT_SAVINGS_PCT sprechen wir ueberhaupt von einem Unterschied - und wenn der
  // Bestpreis in einer anderen Waehrung stand als der Ausgangspreis (also von uns umgerechnet
  // wurde), erst ab RELEVANT_SAVINGS_PCT_CONVERTED. Siehe Kommentar in config.js.
  const umgerechnet = !!(baseline && baseline.currency && best.currency && baseline.currency !== best.currency);
  const relevantThresholdPct = umgerechnet ? RELEVANT_SAVINGS_PCT_CONVERTED : RELEVANT_SAVINGS_PCT;
  const relevantSaving = savingsPct != null && savingsPct >= relevantThresholdPct;
  if (recommendVpnCountry && !relevantSaving) recommendVpnCountry = null;
  // Streuung des Ausgangslandes: der Handler ruft es zweimal ab und haengt die Stichproben an.
  const baselineSamples = baseline && Array.isArray(baseline.samples) ? baseline.samples : null;
  return {
    success: true, results, best, savingsPct, relevantSaving, relevantThresholdPct, convertedCurrency: umgerechnet,
    recommendVpnCountry, baselineCountry,
    baselineUsedEuro, userPriceEuro, userPriceDiffers,
    baselineSamples, baselineSpreadPct: baseline && baseline.spreadPct != null ? baseline.spreadPct : null,
  };
}

// ---- Alle Zimmernamen einer Hotelseite auflisten (fuer das Dropdown im Formular) ----------
// Reine Text-Heuristik als Rueckfallebene. Bevorzugt wird die Zimmerliste aus dem DOM der
// Zimmertabelle (siehe attemptFetch -> rooms), die ist deutlich sauberer.
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
  const lines = (bodyText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const positions = names
    .map((n) => {
      const nl = n.toLowerCase();
      const idx = lines.findIndex((l) => l.toLowerCase().includes(nl));
      return { name: n, idx };
    })
    .filter((p) => p.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  // Gleiche Sicht wie die Preis-Erkennung: erst in Tarifstufen zerlegen, dann je Stufe
  // bestimmen, was sie bietet. Frueher wurde der ganze Zimmerblock in einen Topf geworfen -
  // damit war jede Stufe "Fruehstueck", sobald irgendeine Stufe Fruehstueck enthielt.
  const boardOfCtx = (ctx) => {
    for (const line of (ctx || '').split('\n')) { const b = boardOfLine(line); if (b) return b; }
    return null;
  };
  const cancelOfCtx = (ctx) => {
    for (const line of (ctx || '').split('\n')) { const c = cancelOfLine(line); if (c) return c; }
    return null;
  };

  const result = {};
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx;
    const end = i + 1 < positions.length ? positions[i + 1].idx : Math.min(lines.length, start + 60);
    const stufen = tarifstufen(lines, start, end);
    const boards = new Set();
    const cancels = new Set();
    for (const t of stufen) {
      // Kein Verpflegungshinweis an einer Stufe MIT Preis heisst bei Booking "ohne Verpflegung".
      // "Fruehstueck inbegriffen" wird hingeschrieben, wenn es inbegriffen ist - sonst steht da
      // nichts. Wer nur sammelt, was dasteht, kann "Nur Uebernachtung" nie anbieten, obwohl es
      // der haeufigste und oft guenstigste Tarif ist.
      boards.add(boardOfCtx(t.ctx) || 'uebernachtung');
      const c = cancelOfCtx(t.ctx);
      if (c) cancels.add(c);
    }
    // Fallback fuer Zimmer ohne erkennbare Tarifstufen: wie bisher den ganzen Block ansehen,
    // dann aber OHNE die Annahme "ohne Hinweis = Uebernachtung" (dafuer fehlt der Preisbezug).
    if (!stufen.length) {
      const span = lines.slice(start, end).join('\n');
      for (const b of boardsFromText(span)) boards.add(b);
      for (const c of cancelsFromText(span)) cancels.add(c);
    }
    result[positions[i].name] = { boards: [...boards], cancels: [...cancels] };
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


module.exports = {
  DEAL_MUSTER,
  parseAmount, extractExclusiveTaxPct, extractAbsoluteExtraTax, looksLikeNewRoomHeading, tarifstufen,
  findRoomPrice, normalizeCurrency, detectSessionCurrency, implausibleVsBaseline, summarize,
  isRoomName, listRooms, boardOfLine, cancelOfLine, boardsFromText, cancelsFromText,
  computeRoomOptions, enrichRoomOptions,
};
