// Test fuer den Besucherzaehler: api/hit.js und die Besucher-Funktionen in lib/store.js.
//
// Ohne Netzwerk: Upstash wird durch einen fetch-Stub ersetzt, der die Anfragen mitschreibt.
// Dadurch prueft der Test nicht nur "wurde gezaehlt", sondern auch WAS in Redis landen wuerde -
// und das ist hier der eigentliche Punkt. Ein Reichweitenzaehler, der versehentlich eine
// IP-Adresse oder eine volle Verweis-Adresse mitspeichert, waere genau das Tracking, das die
// Datenschutzerklaerung ausschliesst.
//
// Aufruf:  node test/hit-test.js

process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
process.env.BESUCH_SALT = 'test-salz';

let ANTWORT = { result: 1 };
const anfragen = [];
global.fetch = async (url, opts) => {
  anfragen.push({ url: String(url), body: (opts && opts.body) || '' });
  return { json: async () => ANTWORT };
};

const store = require('../lib/store');
const hit = require('../api/hit');

let fehler = 0;
function ok(name, bedingung, zusatz) {
  if (bedingung) { console.log('  ok  ' + name); return; }
  fehler += 1;
  console.log('FEHLER ' + name + (zusatz !== undefined ? '  -> ' + zusatz : ''));
}

function fakeRes() {
  const r = { statusCode: 200, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = o; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
async function treffer(query, headers, method) {
  anfragen.length = 0;
  const res = fakeRes();
  await hit({ method: method || 'GET', query: query || {}, headers: headers || {} }, res);
  return res;
}
// Die Kommandos aus dem letzten Pipeline-Aufruf, als Liste von Zeichenketten.
function kommandos() {
  const p = anfragen.find((a) => a.url.endsWith('/pipeline'));
  return p ? JSON.parse(p.body).map((k) => k.join(' ')) : [];
}

const IP = '203.0.113.47';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131';
// Ein echter Browser schickt beim Abruf einer fremden Domain Origin und Accept-Language mit.
const KOPF = {
  'user-agent': UA,
  'x-forwarded-for': IP + ', 10.0.0.1',
  'x-vercel-ip-country': 'DE',
  origin: 'https://georates.tech',
  'accept-language': 'de-DE,de;q=0.9',
};

(async () => {
  // ---- Grundfall -------------------------------------------------------------------------
  let r = await treffer({ p: '/ratgeber.html', r: 'https://news.ycombinator.com/item?id=4711' }, KOPF);
  let k = kommandos();
  ok('antwortet 204 ohne Inhalt', r.statusCode === 204 && r.ended, r.statusCode);
  ok('Antwort wird nicht zwischengespeichert', r.headers['cache-control'] === 'no-store', r.headers['cache-control']);
  ok('zaehlt Aufruf, Land und Seite', k.some((c) => c.endsWith('alle 1')) && k.some((c) => c.endsWith('land:DE 1')) && k.some((c) => c.endsWith('seite:/ratgeber.html 1')), JSON.stringify(k));
  ok('speichert vom Verweis nur den Hostnamen, ohne www und ohne Suchteil',
    k.some((c) => c.endsWith('quelle:news.ycombinator.com 1')) && !k.some((c) => c.includes('id=4711')), JSON.stringify(k));
  ok('setzt eine Ablauffrist auf jeden Schluessel', k.filter((c) => c.startsWith('expire ')).length >= 3, JSON.stringify(k));
  ok('zaehlt Einzelbesucher je Tag und je Monat',
    k.some((c) => c.startsWith('sadd') && /:\d{4}-\d{2}-\d{2}:ids /.test(c)) && k.some((c) => c.startsWith('sadd') && /:m:\d{4}-\d{2}:ids /.test(c)), JSON.stringify(k));

  // ---- Die wichtigste Zusicherung: nichts Personenbezogenes verlaesst den Server ----------
  const alles = anfragen.map((a) => a.url + ' ' + a.body).join('\n');
  ok('keine IP-Adresse in dem, was gespeichert wird', !alles.includes(IP) && !alles.includes('203.0.113'), 'IP gefunden');
  ok('keine Browserkennung in dem, was gespeichert wird', !alles.includes('Mozilla') && !alles.includes('AppleWebKit'), 'User-Agent gefunden');
  ok('keine vollstaendige Verweis-Adresse', !alles.includes('https%3A%2F%2Fnews') && !alles.includes('https://news'), 'volle URL gefunden');

  // ---- Kennung ---------------------------------------------------------------------------
  const heute = store.besucherKennung(IP, UA, '2026-11-05');
  const morgen = store.besucherKennung(IP, UA, '2026-11-06');
  const anderer = store.besucherKennung('198.51.100.9', UA, '2026-11-05');
  ok('Kennung ist stabil innerhalb eines Tages', heute === store.besucherKennung(IP, UA, '2026-11-05'));
  ok('Kennung wechselt mit dem Datum (keine Wiedererkennung ueber Tage)', heute !== morgen);
  ok('verschiedene Besucher bekommen verschiedene Kennungen', heute !== anderer);
  ok('Kennung enthaelt die Rohdaten nicht', !heute.includes('203') && /^[0-9a-f]{16}$/.test(heute), heute);

  // ---- Saeuberung der Eingaben -----------------------------------------------------------
  const faelle = [
    ['/', 'seite:/ 1', 'Startseite'],
    ['/en/budget.html', 'seite:/en/budget.html 1', 'Sprachfassung'],
    ['/suche?q=geheim', 'seite:/suche 1', 'Suchteil wird abgeschnitten'],
    ['/x<script>', 'seite:andere 1', 'unerwartete Zeichen werden zusammengefasst'],
    ['/' + 'a'.repeat(200), 'seite:andere 1', 'ueberlange Pfade werden zusammengefasst'],
  ];
  for (const [ein, soll, was] of faelle) {
    await treffer({ p: ein }, KOPF);
    ok('Pfad: ' + was, kommandos().some((c) => c.endsWith(soll)), JSON.stringify(kommandos()));
  }

  await treffer({ p: '/', r: 'https://www.georates.tech/ratgeber.html' }, KOPF);
  ok('eigene Seiten zaehlen nicht als Verweis', !kommandos().some((c) => c.includes('quelle:')), JSON.stringify(kommandos()));
  await treffer({ p: '/', r: 'kaputt' }, KOPF);
  ok('unlesbarer Verweis wird verworfen, der Rest zaehlt trotzdem',
    !kommandos().some((c) => c.includes('quelle:')) && kommandos().some((c) => c.endsWith('alle 1')), JSON.stringify(kommandos()));

  // ---- Land ------------------------------------------------------------------------------
  await treffer({ p: '/' }, { 'user-agent': UA });
  ok('ohne Laenderkennung von Vercel: unbekannt statt leer', kommandos().some((c) => c.endsWith('land:unbekannt 1')), JSON.stringify(kommandos()));

  // ---- Bots ------------------------------------------------------------------------------
  for (const bot of ['Googlebot/2.1', 'curl/8.4.0', 'facebookexternalhit/1.1', 'HeadlessChrome/120']) {
    r = await treffer({ p: '/' }, { 'user-agent': bot });
    ok('Bot zaehlt nicht mit: ' + bot.split('/')[0], r.statusCode === 204 && anfragen.length === 0, anfragen.length);
  }

  // ---- Getarnte Bots: zaehlen mit, aber getrennt (13.11.2026) -----------------------------
  // Die Bot-Liste faengt nur, wer sich zu erkennen gibt. Ein Skript mit unauffaelliger
  // Browserkennung faellt durch - erkennbar aber daran, dass Origin oder Accept-Language
  // fehlen. Entscheidend ist hier: Die Gesamtzahl bleibt in JEDEM Fall unveraendert.
  const ohne = (weg) => { const k = { ...KOPF }; delete k[weg]; return k; };
  const faelleBot = [
    ['ohne Origin (Skript baut die Adresse nach)', ohne('origin')],
    ['ohne Accept-Language', ohne('accept-language')],
    ['mit fremdem Origin', { ...KOPF, origin: 'https://beispiel.invalid' }],
    ['mit aehnlich aussehendem Origin', { ...KOPF, origin: 'https://georates.tech.boese.invalid' }],
  ];
  for (const [name, kopf] of faelleBot) {
    await treffer({ p: '/' }, kopf);
    const k = kommandos();
    const gesamtGezaehlt = k.some((c) => c.endsWith('alle 1'));
    const alsMensch = k.some((c) => c.endsWith('menschlich 1')) || k.some((c) => c.includes(':ids:mensch'));
    ok('verdaechtig, zaehlt aber mit: ' + name, gesamtGezaehlt && !alsMensch, JSON.stringify(k));
  }
  await treffer({ p: '/' }, KOPF);
  let km = kommandos();
  ok('echter Browser zaehlt zusaetzlich als Mensch',
    km.some((c) => c.endsWith('menschlich 1')) && km.some((c) => c.includes(':ids:mensch')), JSON.stringify(km));
  await treffer({ p: '/' }, { ...KOPF, origin: 'https://www.georates.tech' });
  ok('www-Schreibweise gilt auch als echter Browser',
    kommandos().some((c) => c.endsWith('menschlich 1')), JSON.stringify(kommandos()));

  // ---- Methoden --------------------------------------------------------------------------
  r = await treffer({}, KOPF, 'OPTIONS');
  ok('OPTIONS wird beantwortet (CORS-Vorabfrage)', r.statusCode === 200);
  r = await treffer({}, KOPF, 'DELETE');
  ok('andere Methoden werden abgelehnt', r.statusCode === 405);
  r = await treffer({}, KOPF, 'POST');
  ok('POST zaehlt ebenfalls', r.statusCode === 204 && kommandos().length > 0);

  // ---- Der Zaehler darf nie etwas kaputt machen -------------------------------------------
  const guteFetch = global.fetch;
  global.fetch = async () => { throw new Error('Upstash weg'); };
  r = await treffer({ p: '/' }, KOPF);
  ok('faellt Upstash aus, bekommt der Besucher trotzdem 204', r.statusCode === 204 && r.ended);
  global.fetch = guteFetch;

  // ---- Auslesen --------------------------------------------------------------------------
  // Upstash liefert HGETALL je nach Weg als Objekt oder als flache Liste. Beides muss gehen,
  // sonst steht im Tagesbericht stillschweigend ueberall null.
  ANTWORT = { result: ['alle', '42', 'menschlich', '9', 'land:DE', '30', 'land:AT', '12', 'seite:/', '20', 'quelle:t.co', '5'] };
  let tag = await store.besucherTag('2026-11-04');
  ok('Auslesen als flache Liste', tag.aufrufe === 42 && tag.laender.DE === 30 && tag.laender.AT === 12 && tag.seiten['/'] === 20 && tag.quellen['t.co'] === 5, JSON.stringify(tag));
  ok('menschliche Aufrufe werden getrennt gelesen', tag.menschlich.aufrufe === 9, JSON.stringify(tag.menschlich));
  ok('"menschlich" landet nicht faelschlich unter Seiten oder Laendern',
    !('menschlich' in tag.seiten) && !('menschlich' in tag.laender), JSON.stringify(tag));
  ANTWORT = { result: { alle: '7', 'land:ES': '7' } };
  tag = await store.besucherTag('2026-11-04');
  ok('Auslesen als Objekt', tag.aufrufe === 7 && tag.laender.ES === 7, JSON.stringify(tag));
  ANTWORT = { result: null };
  tag = await store.besucherTag('2000-01-01');
  ok('Tag ohne Daten liefert Nullen statt Fehler', tag.aufrufe === 0 && tag.besucher === 0 && Object.keys(tag.laender).length === 0, JSON.stringify(tag));

  ANTWORT = { result: 3 };
  const monat = await store.besucherImMonat('2026-11');
  ok('Monatsbesucher kommen aus der Monats-Menge (SCARD)', monat === 3 && anfragen.some((a) => a.url.includes('scard')), monat);

  console.log(fehler ? '\n' + fehler + ' FEHLER' : '\nalle Zaehler-Tests bestanden');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
