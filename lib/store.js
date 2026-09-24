// Speicher-Schicht von GeoRates: Upstash-Cache, Zaehlbremsen, Tagesdeckel, Abfrage-Log, Best-of,
// Ergebnis-Permalinks. Alles optional: ohne Upstash laeuft der Check ohne Cache und ohne Bremsen,
// ohne Webhook ohne Log. Fehler hier duerfen den Preis-Check niemals kippen.

const crypto = require('crypto');
const { CACHE_TTL_SECONDS, linkFuersLog, normalisiereLinkFuerAbruf } = require('./config');

// ---- Upstash REST (ein Aufruf, ein Kommando) ----------------------------------------------

// Die Zugangsdaten stehen je nach Anlageweg unter ZWEI verschiedenen Namen in Vercel:
//   - ueber den Vercel-Marketplace ("Storage -> Upstash for Redis"): KV_REST_API_URL / KV_REST_API_TOKEN
//   - bei Anlage direkt bei Upstash und Eintrag von Hand:  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// Dieser Code kannte nur die zweite Schreibweise. Am 20.09. kam dadurch heraus, dass Upstash
// NIE angebunden war: 155 Logzeilen ohne einen einzigen Cache-Treffer, ein Best-of, das sich
// nicht fuellen konnte, und - am teuersten - eine Zaehlbremse und ein Tagesdeckel, die bei
// nicht erreichbarem Speicher stillschweigend "erlaubt" antworten. Der Kostenschutz war eine
// Attrappe, ohne dass es irgendwo sichtbar wurde. Deshalb jetzt beide Namen.
let upstashWarnungGezeigt = false;
function upstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    // Einmal pro Funktionsinstanz laut werden. Der Fehler selbst war harmlos zu beheben -
    // unbemerkt blieb er nur, weil ihn nichts gemeldet hat. Ein Ausfall dieser Tragweite
    // gehoert ins Log, auch wenn der Preis-Check ohne Speicher weiterlaeuft.
    if (!upstashWarnungGezeigt) {
      upstashWarnungGezeigt = true;
      console.error('[store] WARNUNG: Kein Upstash konfiguriert (weder UPSTASH_REDIS_REST_URL/_TOKEN '
        + 'noch KV_REST_API_URL/_TOKEN gesetzt). Cache, Best-of, Permalinks, Zaehlbremse und '
        + 'Tagesdeckel sind damit AUSSER BETRIEB - jede Suche kostet vollen Proxy-Traffic.');
    }
    return null;
  }
  return { url, headers: { Authorization: `Bearer ${token}` } };
}

// Kommando als Pfad, z.B. cmd('incr', key) oder cmd('set', key, value, 'EX', 3600).
// Werte werden URL-kodiert; fuer JSON-Bodies gibt es cmdBody.
async function cmd(...teile) {
  const u = upstash();
  if (!u) return null;
  try {
    const res = await fetch(`${u.url}/${teile.map((t) => encodeURIComponent(String(t))).join('/')}`, { headers: u.headers });
    const json = await res.json();
    return json && Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : null;
  } catch (e) { return null; }
}
async function cmdBody(pfad, body) {
  const u = upstash();
  if (!u) return null;
  try {
    const res = await fetch(`${u.url}/${pfad}`, { method: 'POST', headers: u.headers, body });
    const json = await res.json();
    return json && Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : null;
  } catch (e) { return null; }
}

// ---- Ergebnis-Cache ----------------------------------------------------------------------

// Das Geraet MUSS in den Cache-Schluessel. Sonst liefert eine Mobil-Abfrage das gecachte
// Desktop-Ergebnis zurueck - und genau der Unterschied, den wir messen wollen, waere
// wegdefiniert, ohne dass es jemand merkt.
// Hochzaehlen, wenn sich aendert WAS gemessen wird (nicht bei reinen Fehlerkorrekturen).
// Sonst liefert der Cache nach einem solchen Deploy bis zu 24 Stunden lang Ergebnisse nach
// altem Umfang zurueck - und man sucht den Fehler im neuen Code statt im Cache.
// v2: dynamischer Platz fuer das Land der Unterkunft (19.09.2026).
// v3: Link wird vor dem Hashen bereinigt, Laenderauswahl und Schwelle bei Umrechnung.
// v4: Genius wird nicht mehr herausgerechnet (20.09.2026) - die gemeldeten Betraege aendern
//     sich dadurch, alte Cache-Eintraege waeren sonst 24 Stunden lang nach altem Massstab.
// v5: Tarifstufen aus ALLEN Fundstellen des Zimmernamens (21.09.2026). Bei Zimmern mit
//     mehreren Tarifen kann dadurch eine andere Stufe gewaehlt werden als vorher - und genau
//     das ist der Zweck, also duerfen die alten Werte nicht nachwirken.
// v6: Ausgangsland doppelt, Bestaetigung bei Funden, Deals je Land (21.09.2026).
// v7: Guenstigster passender Tarif statt erster (24.09.2026, "egal" heisst "guenstigster").
// v8: Belegung (max. Personenzahl) und feste Abgaben ("€ 15 Umweltabgabe pro Nacht") beruecksichtigt (24.09.2026).
const CACHE_VERSION = 'v8';

// Der Link geht BEREINIGT in den Schluessel: ohne sid, aid, label, UTM und ohne Sprachendung.
// Vorher war dieselbe Suche zweier Besucher (oder desselben Besuchers in einem neuen Tab) ein
// Cache-Miss, weil Booking jedem Aufruf eine andere Sitzungs-ID in den Link schreibt - und jeder
// Miss kostet rund 35 MB Proxy-Traffic. Hotel und Reisezeitraum bleiben erhalten, die
// bestimmen den Preis.
function cacheLinkKey(link) {
  return linkFuersLog(normalisiereLinkFuerAbruf(link)) || String(link || '');
}
function cacheKeyFor(link, room, board, cancel, device, laender) {
  const l = (laender || []).join(',');
  return 'georates:' + crypto.createHash('sha256')
    .update(`${CACHE_VERSION}|${cacheLinkKey(link)}|${String(room || '').trim().toLowerCase()}|${board}|${cancel}|${device}|${l}`)
    .digest('hex').slice(0, 32);
}

async function cacheGet(key) {
  const raw = await cmd('get', key);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

async function cacheSet(key, value, ttlSeconds) {
  await cmdBody(`set/${encodeURIComponent(key)}?EX=${ttlSeconds || CACHE_TTL_SECONDS}`, JSON.stringify(value));
}

// ---- Zaehlbremsen -----------------------------------------------------------------------

// Pro IP und Zeitfenster. Gedacht fuer den "rooms"-Modus (der laeuft ohne Turnstile) UND seit
// dem Audit auch fuer den Preis-Check selbst: Turnstile beweist nur, dass ein Mensch klickt -
// nicht, dass er es nicht dreissigmal tut. Ist Upstash nicht konfiguriert, wird nicht gebremst.
const ROOMS_RATE_LIMIT = Number(process.env.ROOMS_RATE_LIMIT) || 20;      // Abrufe pro IP und Stunde
const PRICE_RATE_LIMIT = Number(process.env.PRICE_RATE_LIMIT) || 12;      // Preis-Checks pro IP und Stunde
const RATE_WINDOW_SECONDS = 3600;
async function rateLimitUeberschritten(bucket, ip, limit, windowSeconds) {
  if (!upstash() || !ip) return false;
  const key = `rl:${bucket}:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24)}`;
  const count = Number(await cmd('incr', key));
  if (!Number.isFinite(count)) return false;
  if (count === 1) await cmd('expire', key, windowSeconds || RATE_WINDOW_SECONDS);
  return count > limit;
}

// ---- Tagesdeckel (Kostenschutz) ----------------------------------------------------------
// Jede echte Abfrage kostet bezahlten Proxy-Traffic. Turnstile und Per-IP-Bremse begrenzen den
// Einzelnen, aber nicht die Summe: hundert Besucher an einem Tag (ein Forenpost reicht) sind
// hundert mal 35 MB. Deshalb ein harter Deckel pro Kalendertag, in Anfragen UND Megabyte.
// Bei Ueberschreitung antwortet der Endpunkt ehrlich mit "heute ausgelastet", statt still
// Guthaben zu verbrennen. Beide Werte sind per Env-Var einstellbar; 0 schaltet den Deckel ab.
// TAGESBUDGET_SUCHEN ist der Name aus Christophers Umsetzung vom 20.09. und bleibt gueltig.
const DAILY_REQUEST_LIMIT = process.env.TAGESBUDGET_SUCHEN !== undefined ? Number(process.env.TAGESBUDGET_SUCHEN)
  : process.env.DAILY_REQUEST_LIMIT !== undefined ? Number(process.env.DAILY_REQUEST_LIMIT) : 300;
const DAILY_MB_LIMIT = process.env.DAILY_MB_LIMIT !== undefined ? Number(process.env.DAILY_MB_LIMIT) : 4000;
const TAG_TTL_SECONDS = 3 * 24 * 3600; // Zaehler drei Tage aufheben, damit der Tagesbericht sie noch liest

function tagKey(name, datum) {
  const d = datum || new Date().toISOString().slice(0, 10);
  return `georates:tag:${d}:${name}`;
}
async function tagesZaehler(name, delta, datum) {
  const key = tagKey(name, datum);
  const v = await cmd('incrby', key, Math.max(0, Math.round(delta || 0)));
  if (v === 1 || v === delta) await cmd('expire', key, TAG_TTL_SECONDS);
  return Number(v) || 0;
}
async function tagesWert(name, datum) {
  return Number(await cmd('get', tagKey(name, datum))) || 0;
}
// Vor dem Start pruefen: Sind Anfragen oder Traffic von heute schon ueber dem Deckel?
async function tagesdeckelErreicht() {
  if (!upstash()) return false;
  const [anfragen, kb] = await Promise.all([tagesWert('anfragen'), tagesWert('kb')]);
  if (DAILY_REQUEST_LIMIT > 0 && anfragen >= DAILY_REQUEST_LIMIT) return true;
  if (DAILY_MB_LIMIT > 0 && kb / 1024 >= DAILY_MB_LIMIT) return true;
  return false;
}
// Nach jeder Abfrage: Zaehler fortschreiben (Anfragen, Erfolge, Funde, KB).
async function tagesstatistikSchreiben({ erfolg, fund, bytes }) {
  if (!upstash()) return;
  await Promise.all([
    tagesZaehler('anfragen', 1),
    erfolg ? tagesZaehler('erfolge', 1) : null,
    fund ? tagesZaehler('funde', 1) : null,
    tagesZaehler('kb', Math.round((bytes || 0) / 1024)),
  ]);
}
async function tagesstatistikLesen(datum) {
  const namen = ['anfragen', 'erfolge', 'funde', 'kb'];
  const werte = await Promise.all(namen.map((n) => tagesWert(n, datum)));
  const out = {};
  namen.forEach((n, i) => { out[n] = werte[i]; });
  return out;
}

// ---- Abfrage-Log (optional, an eine Google-Tabelle via Apps-Script-Webhook) --------------

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

// ---- Best-of (anonymisierte Funde fuer die Startseite) -----------------------------------
// Gespeichert wird bewusst NICHT der Link und NICHT der Reisezeitraum: Hotel plus exaktes Datum
// ist eine Kombination, auf die selten mehr als eine Person passt. Hotelname, Hotelland,
// Siegerland, Ersparnis in Prozent und Euro sowie der Tag der Messung reichen fuer die Anzeige.
const BESTOF_KEY = 'georates:bestof';
const BESTOF_MAX = 300;
async function bestofSpeichern(eintrag) {
  if (!upstash()) return;
  // Ohne Hotelnamen ist ein Eintrag fuer Besucher wertlos: Auf der Startseite erscheint dann ein
  // namenloser Kasten mit einer Prozentzahl. Am 20.09.2026 ist genau das passiert - ein Link
  // ohne "/hotel/xx/" im Pfad (Bookings Teilen-Adresse der Form booking.com/Share-xxx) lieferte
  // weder Name noch Land, der Eintrag landete trotzdem in der Liste, mit "38,1 %" und sonst
  // nichts. Ein Fund weniger ist besser als ein unglaubwuerdiger.
  if (!eintrag || !String(eintrag.hotel || '').trim()) {
    console.log('[store] Best-of-Eintrag ohne Hotelnamen verworfen:', JSON.stringify(eintrag || {}));
    return;
  }
  await cmdBody(`lpush/${BESTOF_KEY}`, JSON.stringify(eintrag));
  await cmd('ltrim', BESTOF_KEY, 0, BESTOF_MAX - 1);
}
async function bestofLesen() {
  const raw = await cmd('lrange', BESTOF_KEY, 0, BESTOF_MAX - 1);
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) { try { out.push(JSON.parse(r)); } catch (e) { /* kaputter Eintrag */ } }
  return out;
}

// ---- Ergebnis-Permalinks ----------------------------------------------------------------
// Ein fertiges Ergebnis bekommt eine kurze ID, unter der es 30 Tage abrufbar bleibt - zum Teilen
// in Foren, ohne dass der Empfaenger den Check (und damit Proxy-Traffic) neu ausloesen muss.
// Die ID leitet sich vom Cache-Schluessel ab, ist also fuer dieselbe Suche stabil.
const RESULT_TTL_SECONDS = 30 * 24 * 3600;
function resultIdFor(cacheKey) {
  return crypto.createHash('sha256').update('result|' + cacheKey).digest('base64url').slice(0, 12);
}
// Ein Permalink ist oeffentlich: Die Startseite verlinkt ihn aus dem Best-of, jeder kann ihn
// aufrufen. Bis zum 24.09.2026 stand darin an jeder Laenderzeile `finalUrl` - die Booking-Adresse
// nach der Weiterleitung, also mit Reisedaten, sid, aid und label der Suche des Besuchers. Die
// Seite verspricht "ohne Reisedaten, ohne Link". Deshalb werden alle Adressfelder entfernt, egal
// wie tief sie stecken: beim Speichern UND beim Lesen, weil die alten Eintraege noch bis zu
// 30 Tage liegen.
const LINK_FELDER = new Set(['finalUrl', 'link', 'hotelLink', 'url', 'abrufLink']);
function ohneLinks(wert) {
  if (Array.isArray(wert)) return wert.map(ohneLinks);
  if (!wert || typeof wert !== 'object') return wert;
  const out = {};
  for (const [k, v] of Object.entries(wert)) {
    if (LINK_FELDER.has(k)) continue;
    out[k] = ohneLinks(v);
  }
  return out;
}
async function resultSpeichern(id, payload) {
  await cacheSet(`georates:result:${id}`, ohneLinks(payload), RESULT_TTL_SECONDS);
}
async function resultLesen(id) {
  if (!/^[A-Za-z0-9_-]{12}$/.test(String(id || ''))) return null;
  const payload = await cacheGet(`georates:result:${id}`);
  return payload ? ohneLinks(payload) : null;
}

module.exports = {
  upstashKonfiguriert: () => !!upstash(),
  CACHE_VERSION, cacheKeyFor, cacheGet, cacheSet,
  ROOMS_RATE_LIMIT, PRICE_RATE_LIMIT, RATE_WINDOW_SECONDS, rateLimitUeberschritten,
  DAILY_REQUEST_LIMIT, DAILY_MB_LIMIT, tagesdeckelErreicht, tagesstatistikSchreiben, tagesstatistikLesen,
  logQuery,
  bestofSpeichern, bestofLesen,
  resultIdFor, resultSpeichern, resultLesen, ohneLinks,
};
