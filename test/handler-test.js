// Ablauf-Test fuer den HTTP-Handler ohne Netzwerk, ohne Proxy, ohne Chromium.
//
// Die Browser-Schicht wird durch einen Stub ersetzt, der feste Preise liefert. Geprueft wird der
// Ablauf drumherum: Eingabepruefung, Modi, Streaming (NDJSON), Zusammenfassung, Schwellen,
// Laenderauswahl, generische Fehlermeldung. Genau dieser Teil hatte bisher keinen Test.
//
// Aufruf:  node test/handler-test.js

const path = require('path');
const Module = require('module');

// Stub fuer lib/browser: dieselbe Schnittstelle, aber ohne Puppeteer.
const PREISE = { DE: 1000, CO: 890, JP: 950, US: 980 };
const stubBrowser = {
  chromiumVorbereiten: async () => {},
  sharedBrowserSchliessen: async () => {},
  getLiveRates: async () => ({ EUR: 1, USD: 0.9, COP: 0.00022, JPY: 0.006 }),
  deviceProfile: () => ({ label: 'Windows/Desktop' }),
  resolveDevice: () => 'windows',
  attemptFetch: async () => ({ bodyText: 'Zimmerkategorie\nDoppelzimmer\nPreis € 100\nEinschließlich Steuern und Gebühren\n' + 'x\n'.repeat(100), rooms: [{ name: 'Doppelzimmer', boards: ['uebernachtung'], cancels: ['ja'] }], loadedOk: true, transferBytes: 2048, err: null }),
  fetchPrice: async (country) => ({
    country, priceRaw: 'stub', currency: country === 'DE' ? 'EUR' : 'USD',
    priceLocal: PREISE[country] || null, priceEuro: PREISE[country] || null, transferBytes: 1024 * 1024,
  }),
};
const browserPfad = require.resolve('../lib/browser');
require.cache[browserPfad] = { id: browserPfad, filename: browserPfad, loaded: true, exports: stubBrowser };

process.env.SMARTPROXY_USER_PREFIX = 'test_area-';
process.env.SMARTPROXY_PASSWORD = 'test';
delete process.env.TURNSTILE_SECRET_KEY;   // Bot-Check uebersprungen
delete process.env.UPSTASH_REDIS_REST_URL; // kein Cache, keine Bremsen
delete process.env.LOG_WEBHOOK_URL;
process.env.DEBUG_SECRET = 'geheim';

const handler = require('../api/check-price');

function fakeRes() {
  const r = { statusCode: 200, headers: {}, chunks: [] };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.ended = true; return r; };
  r.write = (s) => { r.chunks.push(s); };
  r.end = () => { r.ended = true; };
  return r;
}
async function call(body, headers) {
  const res = fakeRes();
  await handler({ method: 'POST', body, headers: headers || {} }, res);
  return res;
}
let fehler = 0;
function ok(name, cond, info) {
  if (!cond) fehler++;
  console.log((cond ? 'OK  ' : 'FEHL') + ' | ' + name.padEnd(56) + (info !== undefined ? ' ' + info : ''));
}
const LINK = 'https://www.booking.com/hotel/de/beispiel.de.html?checkin=2027-03-01&checkout=2027-03-03&sid=abc'; // leck-check-ok: erfundenes Hotel, Datum und Platzhalter

(async () => {
  let r = await call({ link: 'https://example.com/x', room: 'Doppelzimmer' });
  ok('fremder Link wird abgelehnt', r.statusCode === 400 && r.body.reason === 'invalid_link');

  r = await call({ link: LINK, room: '' });
  ok('fehlendes Zimmer wird gemeldet', r.statusCode === 400 && r.body.reason === 'missing_room');

  r = await call({ link: LINK, room: 'x'.repeat(500) });
  ok('ueberlanger Zimmername wird abgelehnt', r.statusCode === 400 && r.body.reason === 'invalid_room');

  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'kaviar' });
  ok('unbekannte Verpflegung wird abgelehnt', r.statusCode === 400 && r.body.reason === 'invalid_board');

  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  ok('voller Lauf: alle 15 Laender', r.body.success === true && r.body.results.length === 15, r.body.results.length);
  ok('Sieger Kolumbien, 11 % aus USD umgerechnet = Fund (>= 3 %)', r.body.best.country === 'CO' && r.body.relevantSaving === true && r.body.relevantThresholdPct === 3, r.body.savingsPct + ' %');
  ok('VPN-Empfehlung ab 10 %', r.body.recommendVpnCountry === 'CO');
  ok('resultId und Laenderliste in der Antwort', /^[A-Za-z0-9_-]{12}$/.test(r.body.resultId) && Array.isArray(r.body.countries));

  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', countries: ['JP', 'US'] });
  ok('Laenderauswahl: nur DE, US, JP', r.body.results.map((x) => x.country).sort().join(',') === 'DE,JP,US', r.body.results.map((x) => x.country).join(','));
  ok('Auswahl: 5 % ueber Japan aus USD = Fund, aber keine VPN-Empfehlung', r.body.best.country === 'JP' && r.body.relevantSaving === true && r.body.recommendVpnCountry === null, r.body.savingsPct + ' %');

  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', stream: true });
  const zeilen = r.chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
  ok('Stream: meta zuerst, summary zuletzt', zeilen[0].type === 'meta' && zeilen[zeilen.length - 1].type === 'summary');
  ok('Stream: 15 Laenderzeilen', zeilen.filter((z) => z.type === 'country').length === 15);
  ok('Stream: NDJSON-Header gesetzt', /ndjson/.test(r.headers['content-type']));

  r = await call({ mode: 'rooms', link: LINK });
  ok('rooms-Modus liefert Zimmer', r.body.success === true && r.body.rooms[0].name === 'Doppelzimmer');
  ok('rooms-Modus ohne Secret: kein dbg', r.body.dbg === undefined);
  r = await call({ mode: 'rooms', link: LINK, debug: true }, { 'x-georates-debug': 'falsch' });
  ok('rooms-Modus mit falschem Secret: kein dbg', r.body.dbg === undefined);
  r = await call({ mode: 'rooms', link: LINK, debug: true }, { 'x-georates-debug': 'geheim' });
  ok('rooms-Modus mit richtigem Secret: dbg vorhanden', r.body.dbg && typeof r.body.dbg.bodyLen === 'number');

  // Fehler in der Browser-Schicht -> generische Meldung, keine Interna
  stubBrowser.getLiveRates = async () => { throw new Error('proxy.smartproxy.net:3120 ECONNREFUSED'); };
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  ok('Fehlermeldung ohne Interna', r.body.success === false && r.body.reason === 'error' && !/smartproxy/.test(r.body.message), r.body.message);

  const res = fakeRes();
  await handler({ method: 'GET', headers: {} }, res);
  ok('GET wird abgelehnt', res.statusCode === 405);

  console.log(fehler ? '\n' + fehler + ' FEHLER' : '\nalle Handler-Tests bestanden');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
