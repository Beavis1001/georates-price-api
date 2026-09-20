// GET /api/best-of - die groessten echten Funde der letzten Wochen, anonymisiert.
//
// Quelle ist die Best-of-Liste in Upstash (lib/store.js), die der Preis-Check bei jedem
// relevanten Fund fortschreibt. Enthalten sind Hotelname, Hotelland, Siegerland, Ersparnis und
// Messtag - KEIN Link und KEIN Reisezeitraum (OFFEN.md, Punkt 6). Umgerechnete Funde unter der
// hoeheren Schwelle sind schon beim Schreiben ausgesiebt (summarize).

const store = require('../lib/store');
const { setCors } = require('../lib/http');

const TAGE = 45;       // Zeitraum
const ANZAHL = 8;      // Eintraege in der Antwort

module.exports = async (req, res) => {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ success: false, reason: 'method_not_allowed' }); return; }

  const alle = await store.bestofLesen();
  const seit = new Date(Date.now() - TAGE * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Pro Hotel nur der beste Eintrag, sonst steht ein beliebtes Hotel achtmal in der Liste.
  const proHotel = new Map();
  for (const e of alle) {
    if (!e || !e.datum || e.datum < seit || !(e.pct > 0)) continue;
    const key = `${e.hotelLand}|${e.hotel}`;
    if (!proHotel.has(key) || proHotel.get(key).pct < e.pct) proHotel.set(key, e);
  }
  const top = [...proHotel.values()].sort((a, b) => b.pct - a.pct).slice(0, ANZAHL)
    .map((e) => ({ hotel: e.hotel, hotelLand: e.hotelLand, land: e.land, baseline: e.baseline, pct: e.pct, euro: e.euro, datum: e.datum, resultId: e.resultId || null }));

  // Eine Stunde am Edge cachen: Die Liste aendert sich selten, die Startseite ruft sie oft ab.
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).json({ success: true, seit, eintraege: top, gesamt: alle.length });
};
