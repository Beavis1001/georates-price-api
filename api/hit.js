// GET|POST /api/hit - Besucherzaehler. Ein Aufruf je Seitenansicht, ausgeloest von pwa.js.
//
// Warum ueberhaupt: Bis zum 05.11.2026 mass GeoRates nur Preis-Checks. Wer einen Ratgeber las
// und wieder ging, tauchte nirgends auf - und genau danach fragt jeder Affiliate-Partner als
// Erstes. Warum selbst gebaut statt Google Analytics oder Plausible: keine Daten an Dritte,
// kein Cookie, kein Einwilligungsbanner, und die Zahlen stehen im selben Tagesbericht wie
// alles andere.
//
// Was NICHT gespeichert wird: IP, Browserkennung, Verweildauer, Klickpfad, Wiedererkennung
// ueber den Tag hinaus. Die Tageskennung ist ein gesalzener Hash aus IP und Browserkennung,
// der um Mitternacht wertlos wird (lib/store.js). Gespeichert bleiben je Tag: Zahl der
// Aufrufe, Zahl der Einzelbesucher, Land, Seite, verweisende Domain.
//
// Dieser Endpunkt beruehrt den Tagesdeckel NICHT. Der schuetzt vor Proxy-Kosten; ein
// Seitenaufruf kostet keinen Proxy-Traffic, und ein ausgeschoepftes Suchbudget darf nicht
// dazu fuehren, dass die Reichweitenmessung aufhoert zu zaehlen.

const store = require('../lib/store');
const { setCors, clientIp } = require('../lib/http');

// Bots zaehlen nicht mit. Die Liste faengt die ehrlichen Crawler (die sich zu erkennen geben)
// und die ueblichen Vorschau-Abrufe von Messengern. Getarnte Bots bleiben drin - dagegen hilft
// nichts, was den Aufwand wert waere.
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|node-fetch|monitor/i;

const MAX_SEITE = 60;
const MAX_QUELLE = 50;

// Nur die eigenen Seiten zaehlen, und nur als Pfad. Alles Unerwartete wird zu "andere"
// zusammengefasst, statt beliebige Zeichenketten als Schluessel in Redis zu schreiben.
function seiteSaeubern(roh) {
  let p = String(roh || '/').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > MAX_SEITE) return 'andere';
  if (!/^\/[a-z0-9/_.-]*$/i.test(p)) return 'andere';
  return p;
}

// Aus dem Verweis nur den Hostnamen behalten - nie die volle Adresse, die kann Suchbegriffe
// oder eine Profilseite enthalten. Eigene Seiten und leere Verweise zaehlen als Direktaufruf.
function quelleSaeubern(roh) {
  const s = String(roh || '').trim();
  if (!s) return '';
  let host = '';
  try { host = new URL(s).hostname.toLowerCase(); } catch (e) { return ''; }
  if (!host || host.length > MAX_QUELLE) return '';
  if (host === 'georates.tech' || host.endsWith('.georates.tech')) return '';
  return host.replace(/^www\./, '');
}

module.exports = async (req, res) => {
  setCors(res, 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ success: false, reason: 'method_not_allowed' });
    return;
  }

  // Der Zaehler darf unter keinen Umstaenden eine Fehlerseite produzieren oder den Besucher
  // warten lassen. Jeder Fehler endet still in 204.
  try {
    const ua = String(req.headers['user-agent'] || '');
    if (BOT.test(ua)) { res.status(204).end(); return; }

    const query = req.query || {};
    const body = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : {};
    const seite = seiteSaeubern(body.p || query.p);
    const quelle = quelleSaeubern(body.r || query.r);
    const land = String(req.headers['x-vercel-ip-country'] || '').toUpperCase().slice(0, 2) || 'unbekannt';
    const datum = new Date().toISOString().slice(0, 10);
    const kennung = store.besucherKennung(clientIp(req), ua, datum);

    await store.besuchZaehlen({ land, seite, quelle, kennung, datum });
  } catch (e) {
    console.error('[hit] Zaehlen fehlgeschlagen:', (e && e.message) || e);
  }
  res.status(204).end();
};
