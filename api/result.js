// GET /api/result?id=<12 Zeichen> - ein gespeichertes Ergebnis zum Teilen (Permalink).
//
// Der Preis-Check legt jedes erfolgreiche Ergebnis 30 Tage unter einer kurzen ID ab
// (lib/store.js). Wer den Link bekommt, sieht dieselbe Tabelle, ohne einen neuen Check und damit
// neuen Proxy-Traffic auszuloesen. Gespeichert ist kein Booking-Link, nur Hotelname, Hotelland,
// Zimmer, Verpflegung und die Laenderpreise.
// Adressfelder (finalUrl u. a.) entfernt store.resultLesen, auch aus Eintraegen, die vor dem
// 24.09.2026 noch mit Link gespeichert wurden.

const store = require('../lib/store');
const parser = require('../lib/parser');
const { setCors } = require('../lib/http');

module.exports = async (req, res) => {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ success: false, reason: 'method_not_allowed' }); return; }

  const id = String((req.query && req.query.id) || '').trim();
  if (!/^[A-Za-z0-9_-]{12}$/.test(id)) { res.status(400).json({ success: false, reason: 'invalid_id' }); return; }
  const payload = await store.resultLesen(id);
  if (!payload) { res.status(404).json({ success: false, reason: 'not_found' }); return; }
  const neutral = ohneNutzerpreis(payload);
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  res.status(200).json({ ...neutral, resultId: id, fromPermalink: true });
};

// Eintraege von vor dem 24.09.2026 tragen noch den Preis, den der erste Suchende eingetippt hat
// (siehe check-price.js). Beim Ausliefern entfernen und die Auswertung neu gegen unseren eigenen
// Messwert rechnen - sonst liest jeder Empfaenger "Dein Preis" mit der Zahl eines Fremden.
function ohneNutzerpreis(payload) {
  if (payload.userPriceEuro == null || !Array.isArray(payload.results)) return payload;
  const { userPriceEuro: _u, userPriceDiffers: _d, ...rest } = payload;
  const neu = parser.summarize(rest.results, rest.baselineCountry, {});
  const out = { ...rest, ...neu };
  delete out.userPriceEuro; delete out.userPriceDiffers;
  if (rest.mobile) {
    const bestaetigung = rest.mobile.confirmation;
    out.mobile = parser.mobilBewerten(rest.mobile, out);
    if (out.mobile && bestaetigung) out.mobile.confirmation = bestaetigung;
  }
  return out;
}
module.exports.ohneNutzerpreis = ohneNutzerpreis;
