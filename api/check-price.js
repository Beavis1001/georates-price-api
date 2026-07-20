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
  'https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar';

// ---- Konfiguration -----------------------------------------------------------------------

const PROBE_COUNTRIES = ['DE', 'CO'];
const EXPANSION_COUNTRIES = ['US', 'TH', 'IN', 'EG', 'AR', 'TR', 'LK', 'VN', 'ID', 'PK', 'PE', 'MX', 'PH', 'JP'];
const PROBE_CONFIDENCE_THRESHOLD_PCT = 3.0;
const MAX_ATTEMPTS = 2;
const MIN_LOADED_LINES = 300;
const TIME_BUDGET_MS = 45000; // Sicherheitsmarge unter maxDuration in vercel.json
const CACHE_TTL_SECONDS = 24 * 3600;

const DEFAULT_CURRENCY_BY_COUNTRY = {
  DE: 'EUR', US: 'USD', CO: 'COP', TH: 'THB', IN: 'INR', EG: 'EGP', AR: 'ARS',
  TR: 'TRY', LK: 'LKR', VN: 'VND', ID: 'IDR', PK: 'PKR', PE: 'PEN',
  MX: 'MXN', PH: 'PHP', JP: 'JPY',
};

// Notfall-Fallback, falls die Live-FX-Abfrage (siehe getLiveRates) fehlschlaegt.
const STATIC_FALLBACK_RATES = {
  EUR: 1.0, USD: 0.8759, COP: 0.000242, THB: 0.0263, INR: 0.009181, EGP: 0.0179,
  ARS: 0.000586, TRY: 0.018692, LKR: 0.002614, VND: 0.00003324,
  IDR: 0.00004864, PKR: 0.003147, PEN: 0.25729, MXN: 0.050051, PHP: 0.014231,
  JPY: 0.005405,
};

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet', 'other']);

// ---- Live-Wechselkurse (tagesaktuell, EUR-Basis, kostenlos ohne API-Key) -----------------

async function getLiveRates() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://open.er-api.com/v6/latest/EUR', { signal: controller.signal });
    clearTimeout(t);
    const json = await res.json();
    if (json && json.result === 'success' && json.rates) {
      const inverse = { EUR: 1.0 };
      for (const [cur, rate] of Object.entries(json.rates)) {
        if (rate) inverse[cur] = 1 / rate; // EUR-Gegenwert von 1 Einheit `cur`
      }
      return inverse;
    }
  } catch (e) { /* auf statischen Fallback zurueckfallen */ }
  return STATIC_FALLBACK_RATES;
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

function looksLikeNewRoomHeading(lines, idx) {
  if (idx >= lines.length || lines[idx].length > 60) return false;
  for (let j = idx + 1; j < Math.min(idx + 1 + ROOM_CARD_LOOKAHEAD, lines.length); j++) {
    if (lines[j].includes('m²')) return true;
  }
  return false;
}

function findRoomPrice(bodyText, roomName, boardType) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  const roomLower = roomName.toLowerCase();
  let start = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l === roomLower || l.startsWith(roomLower)) { start = i; break; }
  }
  if (start === null) return [null, null];

  const maxEnd = Math.min(start + 250, lines.length);
  const tiers = [];
  let lastAmountLine = -1;
  let k = start + 1;
  while (k < maxEnd) {
    if (tiers.length && looksLikeNewRoomHeading(lines, k)) break;

    const pm = PRICE_PREFIX_RE.exec(lines[k]);
    if (pm) {
      lastAmountLine = k;
      tiers.push([pm[2], lines.slice(k, k + 10).join('\n')]);
    } else if (TAX_LINE_RE.test(lines[k])) {
      let amount = null;
      for (let back = k - 1; back > Math.max(k - 1 - BACKSCAN_LINES, start); back--) {
        const m = AMOUNT_LINE_RE.exec(lines[back]);
        if (m) { amount = m[2]; break; }
        if (back === lastAmountLine) break;
      }
      if (amount) tiers.push([amount, lines.slice(k, k + 10).join('\n')]);
    }
    k++;
  }

  if (!tiers.length) return [null, null];

  if (boardType) {
    const normTarget = boardType.toLowerCase().replace(/[\s-]/g, '');
    for (const [amount, context] of tiers) {
      const normCtx = context.toLowerCase().replace(/[\s-]/g, '');
      if (normCtx.includes(normTarget)) return [amount, context];
    }
  }
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
    browser = await puppeteer.launch({
      args: [...chromium.args, `--proxy-server=${proxyServer}`],
      defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.authenticate(proxyAuth);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    for (const sel of ["button ::-p-text('Alle akzeptieren')", '#onetrust-accept-btn-handler']) {
      try {
        await page.click(sel, { timeout: 2000 });
        break;
      } catch (e) { /* kein Banner - ignorieren */ }
    }

    try {
      await page.waitForFunction(
        () => /Zimmerkategorie|Preis für/i.test(document.body.innerText),
        { timeout: 18000 }
      );
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000));
    }

    try {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await new Promise((r) => setTimeout(r, 1200));
    } catch (e) { /* ignorieren */ }

    const bodyText = await page.evaluate(() => document.body.innerText);
    await browser.close();
    return { bodyText, loadedOk: bodyText.split('\n').length >= MIN_LOADED_LINES, err: null };
  } catch (err) {
    console.error('[attemptFetch] Fehler beim Laden/Chromium-Start:', (err && err.stack) || err);
    if (browser) { try { await browser.close(); } catch (e) { /* ignorieren */ } }
    return { bodyText: null, loadedOk: false, err };
  }
}

async function fetchPrice(countryCode, targetUrl, proxyServer, userPrefix, password, room, board, rates) {
  const proxyAuth = { username: `${userPrefix}${countryCode}`, password };
  const expectedCurrency = DEFAULT_CURRENCY_BY_COUNTRY[countryCode];
  const result = { country: countryCode, priceRaw: null, currency: null, priceEuro: null };

  let bodyText = null;
  let loadedOk = false;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

  if (!loadedOk) {
    result.priceRaw = lastErr ? `Fehler: ${lastErr.message || lastErr}` : 'Seite nicht vollständig geladen (Proxy-Exit instabil)';
    return result;
  }

  const currency = expectedCurrency || 'EUR';
  const [rawAmt, ctx] = findRoomPrice(bodyText, room, board);
  if (rawAmt) {
    let val = parseAmount(rawAmt);
    const taxPct = extractExclusiveTaxPct(ctx);
    if (val !== null && taxPct !== null) {
      val = Math.round(val * (1 + taxPct / 100) * 100) / 100;
      result.priceRaw = `${rawAmt} (${currency}, zzgl. ${taxPct}% Steuer -> steuerinkl. korrigiert: ${val})`;
    } else {
      result.priceRaw = `${rawAmt} (${currency}, inkl. Steuern & Gebühren)`;
    }
    result.currency = currency;
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

function cacheKeyFor(link, room, board) {
  return 'georates:' + crypto.createHash('sha256').update(`${link}|${room}|${board}`).digest('hex').slice(0, 32);
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

function summarize(results) {
  const withPrice = results.filter((r) => r.priceEuro !== null);
  if (!withPrice.length) return { success: false, reason: 'price_not_found', results };

  const best = withPrice.reduce((a, b) => (b.priceEuro < a.priceEuro ? b : a));
  const baseline = results.find((r) => r.country === 'DE');
  let savingsPct = null;
  let recommendVpnCountry = null;
  if (baseline && baseline.priceEuro !== null && best.country !== 'DE') {
    savingsPct = Math.round(((baseline.priceEuro - best.priceEuro) / baseline.priceEuro) * 1000) / 10;
    if (savingsPct >= PROBE_CONFIDENCE_THRESHOLD_PCT) recommendVpnCountry = best.country;
  }
  return { success: true, results, best, savingsPct, recommendVpnCountry };
}

// ---- HTTP Handler ------------------------------------------------------------------------

module.exports = async (req, res) => {
  const startTime = Date.now();
  res.setHeader('Access-Control-Allow-Origin', 'https://georates.tech');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ success: false, reason: 'method_not_allowed' }); return; }

  const { link, room, board, turnstileToken } = req.body || {};

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

  const cacheKey = cacheKeyFor(link, room, board || '');
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
    const rates = await getLiveRates();

    // 1) Schnelle Probe: DE + CO parallel
    let results = await Promise.all(
      PROBE_COUNTRIES.map((c) => fetchPrice(c, link, proxyServer, userPrefix, password, room, board, rates))
    );

    console.log('[check-price] Probe-Ergebnis:', JSON.stringify(results.map((r) => ({ c: r.country, eur: r.priceEuro, raw: r.priceRaw }))));

    let summary = summarize(results);
    let partial = false;

    // 2) Nur erweitern, wenn die Probe keine klare Ersparnis zeigt
    const probeConclusive = summary.success && summary.recommendVpnCountry;
    if (!probeConclusive) {
      for (const country of EXPANSION_COUNTRIES) {
        if (Date.now() - startTime > TIME_BUDGET_MS) { partial = true; break; }
        const r = await fetchPrice(country, link, proxyServer, userPrefix, password, room, board, rates);
        results.push(r);
      }
      summary = summarize(results);
    }

    const payload = { ...summary, partial };
    if (summary.success) await cacheSet(cacheKey, summary);
    res.status(200).json(payload);
  } catch (err) {
    res.status(200).json({ success: false, reason: 'error', message: String((err && err.message) || err) });
  }
};
