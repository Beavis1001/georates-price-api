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
// Aufrufe pro Land zaehlen; ueber PREIS_FOLGE laesst sich je Land eine Folge von Preisen vorgeben
// (Stichprobe 1, 2, ...), um Streuung zu simulieren.
const aufrufe = {};
let PREIS_FOLGE = {};
const stubBrowser = {
  chromiumVorbereiten: async () => {},
  sharedBrowserSchliessen: async () => {},
  getLiveRates: async () => ({ EUR: 1, USD: 0.9, COP: 0.00022, JPY: 0.006 }),
  deviceProfile: () => ({ label: 'Windows/Desktop' }),
  resolveDevice: () => 'windows',
  attemptFetch: async () => ({ bodyText: 'Zimmerkategorie\nDoppelzimmer\nPreis € 100\nEinschließlich Steuern und Gebühren\n' + 'x\n'.repeat(100), rooms: [{ name: 'Doppelzimmer', boards: ['uebernachtung'], cancels: ['ja'] }], loadedOk: true, transferBytes: 2048, err: null }),
  fetchPrice: async (country) => {
    aufrufe[country] = (aufrufe[country] || 0) + 1;
    const folge = PREIS_FOLGE[country];
    const preis = folge ? folge[Math.min(aufrufe[country] - 1, folge.length - 1)] : (PREISE[country] || null);
    return {
      country, priceRaw: 'stub', currency: country === 'DE' ? 'EUR' : 'USD',
      priceLocal: preis, priceEuro: preis, transferBytes: 1024 * 1024,
      deals: country === 'CO' ? ['online_payment'] : [],
    };
  },
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
  // Preisstreuung: Ausgangsland zweimal, Fund einmal bestaetigt (Sieger + Ausgangsland je +1)
  ok('Ausgangsland 2 Stichproben + 1 Bestaetigung = 3 Abrufe', aufrufe.DE === 3, aufrufe.DE);
  ok('Siegerland 1 + 1 Bestaetigung = 2 Abrufe', aufrufe.CO === 2, aufrufe.CO);
  ok('andere Laender genau 1 Abruf', aufrufe.JP === 1 && aufrufe.US === 1);
  const deRow = r.body.results.find((x) => x.country === 'DE');
  ok('samples am Ausgangsland, Streuung 0 %', Array.isArray(deRow.samples) && deRow.samples.length === 3 && deRow.spreadPct === 0, JSON.stringify(deRow.samples));
  ok('Deals des Siegerlands in der Antwort', JSON.stringify(r.body.best.deals) === '["online_payment"]');
  ok('Bestaetigung stabil', r.body.confirmation && r.body.confirmation.done && r.body.confirmation.stable === true);
  ok('baselineSamples in der Zusammenfassung', Array.isArray(r.body.baselineSamples));
  ok('Sieger Kolumbien, 11 % aus USD umgerechnet = Fund (>= 3 %)', r.body.best.country === 'CO' && r.body.relevantSaving === true && r.body.relevantThresholdPct === 3, r.body.savingsPct + ' %');
  ok('VPN-Empfehlung ab 10 %', r.body.recommendVpnCountry === 'CO');
  ok('resultId und Laenderliste in der Antwort', /^[A-Za-z0-9_-]{12}$/.test(r.body.resultId) && Array.isArray(r.body.countries));

  // Streuung im Ausgangsland: zweite Stichprobe zeigt 900 -> gegen 900 gerechnet -> CO (890) unter 3 %
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];
  PREIS_FOLGE = { DE: [1000, 900] };
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  const de2 = r.body.results.find((x) => x.country === 'DE');
  ok('Ausgangsland konservativ auf den niedrigeren Preis', de2.priceEuro === 900 && de2.spreadPct === 11.1, de2.priceEuro + ' / ' + de2.spreadPct);
  ok('11 % Schein-Vorsprung wird kein Fund', r.body.relevantSaving === false, r.body.savingsPct + ' %');
  ok('keine Bestaetigung ohne Fund', aufrufe.CO === 1 && (!r.body.confirmation), aufrufe.CO);
  // Los beim Siegerland: Bestaetigung zeigt 990 statt 890 -> nicht stabil
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];
  PREIS_FOLGE = { CO: [890, 990] };
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  const co = r.body.results.find((x) => x.country === 'CO');
  ok('Siegerland konservativ auf den hoeheren Preis', co.priceEuro === 990 && JSON.stringify(co.samples) === '[890,990]', JSON.stringify(co.samples));
  ok('Bestaetigung meldet: nicht stabil', r.body.confirmation && r.body.confirmation.done && r.body.confirmation.stable === false, JSON.stringify(r.body.confirmation));
  PREIS_FOLGE = {};
  // Nutzerpreis: sieht 950 -> Ersparnis gegen 950
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', userPrice: '950,00 €' });
  ok('Nutzerpreis "950,00 €" wird gegen 950 gerechnet', r.body.baselineUsedEuro === 950 && r.body.userPriceDiffers === true && r.body.savingsPct === 6.3, r.body.savingsPct + ' %');
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', userPrice: 'abc' });
  ok('unsinniger Nutzerpreis wird abgelehnt', r.statusCode === 400 && r.body.reason === 'invalid_price');
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];

  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', countries: ['JP', 'US'] });
  ok('Laenderauswahl: nur DE, US, JP', r.body.results.map((x) => x.country).sort().join(',') === 'DE,JP,US', r.body.results.map((x) => x.country).join(','));
  ok('Auswahl: 5 % ueber Japan aus USD = Fund, aber keine VPN-Empfehlung', r.body.best.country === 'JP' && r.body.relevantSaving === true && r.body.recommendVpnCountry === null, r.body.savingsPct + ' %');

  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', stream: true });
  const zeilen = r.chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
  ok('Stream: meta zuerst, summary zuletzt', zeilen[0].type === 'meta' && zeilen[zeilen.length - 1].type === 'summary');
  ok('Stream: 15 Laenderzeilen (Ausgangsland nur einmal)', zeilen.filter((z) => z.type === 'country').length === 15);
  ok('Stream: Bestaetigung als update-Zeilen', zeilen.filter((z) => z.type === 'update').length === 2);
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
