// GET /api/result?id=<12 Zeichen> - ein gespeichertes Ergebnis zum Teilen (Permalink).
//
// Der Preis-Check legt jedes erfolgreiche Ergebnis 30 Tage unter einer kurzen ID ab
// (lib/store.js). Wer den Link bekommt, sieht dieselbe Tabelle, ohne einen neuen Check und damit
// neuen Proxy-Traffic auszuloesen. Gespeichert ist kein Booking-Link, nur Hotelname, Hotelland,
// Zimmer, Verpflegung und die Laenderpreise.

const store = require('../lib/store');
const { setCors } = require('../lib/http');

module.exports = async (req, res) => {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ success: false, reason: 'method_not_allowed' }); return; }

  const id = String((req.query && req.query.id) || '').trim();
  if (!/^[A-Za-z0-9_-]{12}$/.test(id)) { res.status(400).json({ success: false, reason: 'invalid_id' }); return; }
  const payload = await store.resultLesen(id);
  if (!payload) { res.status(404).json({ success: false, reason: 'not_found' }); return; }
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  res.status(200).json({ ...payload, resultId: id, fromPermalink: true });
};
