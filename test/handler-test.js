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
  // Elftes Argument ist das Geraeteprofil. Der Smartphone-Abruf (MOBILE_CHECK) laeuft als eigener
  // Zaehler "<Land>-mobil", damit die Stichproben-Folgen der Desktop-Abrufe unberuehrt bleiben.
  fetchPrice: async (country, ...rest) => {
    const device = rest[9] || 'windows';
    const mobil = device === 'android' || device === 'iphone';
    const key = mobil ? country + '-mobil' : country;
    aufrufe[key] = (aufrufe[key] || 0) + 1;
    const folge = PREIS_FOLGE[key];
    const preis = folge ? folge[Math.min(aufrufe[key] - 1, folge.length - 1)] : (mobil ? 900 : (PREISE[country] || null));
    return {
      country, priceRaw: 'stub', currency: country === 'DE' ? 'EUR' : 'USD',
      priceLocal: preis, priceEuro: preis, transferBytes: 1024 * 1024,
      deals: mobil ? ['mobile'] : (country === 'CO' ? ['online_payment'] : []),
      device: mobil ? 'Android/Smartphone' : 'Windows/Desktop', mobile: mobil || undefined,
      pageTitle: 'Hotel Beispiel, Beispielstadt (aktualisierte Preise)',
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
process.env.MOBILE_CHECK = '1';         // Smartphone-Abruf im Ausgangsland mitpruefen

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
  ok('Seitentitel nicht in der Antwort', r.body.results.every((x) => x.pageTitle === undefined));
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
  ok('Stream: kein Seitentitel in den Zeilen', zeilen.every((z) => !z.result || z.result.pageTitle === undefined));
  ok('Stream: NDJSON-Header gesetzt', /ndjson/.test(r.headers['content-type']));
  ok('Stream: Smartphone-Zeile als Typ mobile (Abruf + Bestaetigung)', zeilen.filter((z) => z.type === 'mobile').length === 2 && zeilen.find((z) => z.type === 'mobile').result.mobile === true);

  // ---- Smartphone-Preis (MOBILE_CHECK) ------------------------------------------------------
  // Standard-Stub: Desktop DE 1000, Smartphone 900 -> 10 % guenstiger, aber CO (890) bleibt bestes Land.
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  ok('Smartphone: 900 gegen 1000 = 10 %, relevant', r.body.mobile && r.body.mobile.priceEuro === 900 && r.body.mobile.savingsPct === 10 && r.body.mobile.relevant === true, JSON.stringify(r.body.mobile));
  ok('Smartphone: Laendertabelle bleibt ohne Geraetezeile', r.body.results.every((x) => !x.mobile) && r.body.results.length === 15);
  ok('Smartphone: schlaegt bestes Land NICHT (890 < 900)', r.body.mobile.beatsBestCountry === false);
  ok('Smartphone: Fund einmal bestaetigt, stabil', aufrufe['DE-mobil'] === 2 && r.body.mobile.confirmation && r.body.mobile.confirmation.stable === true, JSON.stringify(r.body.mobile.confirmation));
  ok('Smartphone: Deal-Plakette mobile', JSON.stringify(r.body.mobile.deals) === '["mobile"]');
  // Smartphone schlaegt alle Laender
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];
  PREIS_FOLGE = { 'DE-mobil': [850] };
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  ok('Smartphone: 850 schlaegt bestes Land (890)', r.body.mobile.beatsBestCountry === true && r.body.mobile.savingsPct === 15 && r.body.best.country === 'CO', JSON.stringify(r.body.mobile));
  // Los: zweiter Mobil-Abruf zeigt 1000 -> konservativ 1000, nicht stabil
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];
  PREIS_FOLGE = { 'DE-mobil': [850, 1000] };
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  ok('Smartphone: Los wird erkannt (850 -> 1000, nicht stabil)', r.body.mobile.priceEuro === 1000 && r.body.mobile.relevant === false && r.body.mobile.confirmation.stable === false && JSON.stringify(r.body.mobile.samples) === '[850,1000]', JSON.stringify(r.body.mobile));
  // Unplausibel: 100 statt ~1000 -> verworfen, kein zweiter Abruf
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];
  PREIS_FOLGE = { 'DE-mobil': [100] };
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  ok('Smartphone: 100 gegen 1000 ist unplausibel -> verworfen', r.body.mobile.implausible === true && r.body.mobile.priceEuro === null && aufrufe['DE-mobil'] === 1, JSON.stringify(r.body.mobile));
  // Nutzerpreis 950: Smartphone 900 -> 5,3 % gegen 950
  for (const k of Object.keys(aufrufe)) delete aufrufe[k];
  PREIS_FOLGE = {};
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', userPrice: '950' });
  ok('Smartphone: gegen den Nutzerpreis gerechnet (900 vs 950 = 5,3 %)', r.body.mobile.savingsPct === 5.3, r.body.mobile.savingsPct);

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

  // Permalink ist oeffentlich: keine Booking-Adresse, auch nicht verschachtelt (24.09.2026)
  const store = require('../lib/store');
  const mitLinks = { results: [{ country: 'DE', priceEuro: 100, finalUrl: LINK }], best: { country: 'DE', finalUrl: LINK }, hotelName: 'Beispiel' };
  const bereinigt = store.ohneLinks(mitLinks);
  ok('Permalink: finalUrl entfernt, Rest bleibt', !/booking\.com/.test(JSON.stringify(bereinigt)) && bereinigt.results[0].priceEuro === 100 && bereinigt.hotelName === 'Beispiel');
  ok('Permalink: Eingabe bleibt unveraendert', mitLinks.results[0].finalUrl === LINK);

  // Permalink ohne Nutzerpreis (24.09.2026): Die Kurz-ID ist fuer dieselbe Suche bei allen gleich,
  // der eingetippte Preis des ersten Suchenden darf dort nicht landen.
  stubBrowser.getLiveRates = async () => ({ EUR: 1, USD: 0.9, COP: 0.00022, JPY: 0.006 });
  const gespeichert = [];
  const origSpeichern = store.resultSpeichern;
  store.resultSpeichern = async (id, payload) => { gespeichert.push(payload); };
  r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher', userPrice: '950,00 €' });
  store.resultSpeichern = origSpeichern;
  ok('Antwort an den Suchenden rechnet mit seinem Preis', r.body.baselineUsedEuro === 950 && r.body.userPriceEuro === 950);
  ok('Permalink gespeichert ohne Nutzerpreis, gegen eigenen Messwert', gespeichert.length === 1 && gespeichert[0].userPriceEuro == null && !gespeichert[0].userPriceDiffers && gespeichert[0].baselineUsedEuro === 1000, JSON.stringify({ u: gespeichert[0] && gespeichert[0].userPriceEuro, b: gespeichert[0] && gespeichert[0].baselineUsedEuro }));
  const { ohneNutzerpreis } = require('../api/result');
  const alt = ohneNutzerpreis({ success: true, baselineCountry: 'DE', userPriceEuro: 950, userPriceDiffers: true, baselineUsedEuro: 950,
    results: [{ country: 'DE', priceEuro: 1000, currency: 'EUR' }, { country: 'CO', priceEuro: 890, currency: 'USD' }], confirmation: { done: true, stable: true } });
  ok('alter Permalink: fremder Nutzerpreis entfernt, neu gerechnet', alt.userPriceEuro === undefined && alt.userPriceDiffers === undefined && alt.baselineUsedEuro === 1000 && alt.savingsPct === 11 && alt.confirmation.stable === true, JSON.stringify({ b: alt.baselineUsedEuro, s: alt.savingsPct }));

  // Ausgangsland aus dem Herkunftsland des Besuchers (25.09.2026)
  {
    const cfg = require('../lib/config');
    const faelle = [
      ['FR', 'FR'], ['CH', 'CH'], ['GB', 'GB'], ['AT', 'AT'], ['UK', 'GB'], ['RE', 'FR'], ['TR', 'DE'], ['', 'DE'], ['XX', 'DE'],
    ];
    const falsch = faelle.filter(([ein, soll]) => cfg.ausgangslandFuerBesucher(ein, LINK) !== soll);
    ok('Ausgangsland aus Herkunft: FR/CH/GB/AT, UK->GB, Reunion->FR, TR/leer/unbekannt->Link (DE)', !falsch.length, JSON.stringify(falsch));
    r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' }, { 'x-vercel-ip-country': 'FR' });
    ok('Besucher aus Frankreich: Ausgangsland FR, FR in der Laenderliste, DE weiter verglichen', r.body.baselineCountry === 'FR' && r.body.countries[0] === 'FR' && r.body.results.some((x) => x.country === 'FR') && r.body.results.some((x) => x.country === 'DE'), JSON.stringify(r.body.countries));
    r = await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' }, { 'x-vercel-ip-country': 'DE' });
    ok('Besucher aus Deutschland: wie bisher', r.body.baselineCountry === 'DE' && r.body.countries.length === 15);
    r = await call({ mode: 'rooms', link: LINK }, { 'x-vercel-ip-country': 'CH' });
    ok('Zimmer-Abruf nutzt ebenfalls das Herkunftsland', r.body.success === true && r.body.baselineCountry === 'CH');
  }

  // Gesamtzaehler: jede Suche mit Ergebnis zaehlt einmal (25.09.2026)
  let gezaehlt = 0;
  const origZaehlen = store.sucheZaehlen;
  store.sucheZaehlen = async () => { gezaehlt++; };
  await call({ link: LINK, room: 'Doppelzimmer', board: 'egal', cancel: 'unsicher' });
  await call({ link: 'https://example.com/x', room: 'Doppelzimmer' });
  store.sucheZaehlen = origZaehlen;
  ok('Zaehler: erfolgreiche Suche zaehlt, ungueltiger Link nicht', gezaehlt === 1, gezaehlt);
  const bestof = require('../api/best-of');
  const bres = fakeRes();
  await bestof({ method: 'GET', headers: {} }, bres);
  ok('Best-of liefert suchenGesamt ab 212', bres.body && bres.body.suchenGesamt === 212, bres.body && bres.body.suchenGesamt);

  const res = fakeRes();
  await handler({ method: 'GET', headers: {} }, res);
  ok('GET wird abgelehnt', res.statusCode === 405);

  console.log(fehler ? '\n' + fehler + ' FEHLER' : '\nalle Handler-Tests bestanden');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
