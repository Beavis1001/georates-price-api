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
// Eintraege, die keine echten Besucher-Funde sind, per Ergebnis-ID ausblenden. Die Liste in
// Upstash bleibt unangetastet (dort schreibt nur der Preis-Check).
// A6b4UgmrL0KM: Gegenprobe des Betreibers fuer den Smartphone-Preis am 24.09.2026, kein Besucher.
const AUSGEBLENDET = new Set(['A6b4UgmrL0KM']);
// Ganze Hotels ausblenden (hotelLand|hotel), wenn eine Nachmessung gezeigt hat, dass die
// gespeicherten Funde Messfehler waren. Per Ergebnis-ID reicht hier nicht: ein Hotel kann an
// einem Tag mehrfach geprueft worden sein, dann rueckt nach dem Ausblenden einfach der
// naechstbeste Fehltreffer nach.
// US|Hyatt House New York/Chelsea: alle Funde (19.11.2026, bis -14,9 % / 437 EUR) stammen aus dem
//   Steuer-Lesefehler vor v11. Booking schrieb dort "plus INR 43.906,76 Steuern" ohne "und
//   Gebuehren", das alte Muster traf nicht, gelesen wurde nur der Nettopreis. Die Nachmessung nach
//   dem Fix ergab 2.924,51 EUR gegen 2.925,00 EUR in Deutschland - 49 Cent ueber 15 Laender.
const HOTEL_AUSGEBLENDET = new Set(['US|Hyatt House New York/Chelsea']);
// Suchen vor Einfuehrung des Gesamtzaehlers (25.09.2026), laut Log-Tabelle. Die Startseite zeigt
// SUCHEN_BASIS + Zaehlerstand, damit der Zaehler nicht bei null anfaengt.
const SUCHEN_BASIS = 212;

module.exports = async (req, res) => {
  setCors(res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ success: false, reason: 'method_not_allowed' }); return; }

  const alle = await store.bestofLesen();
  const seit = new Date(Date.now() - TAGE * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Pro Hotel nur der beste Eintrag, sonst steht ein beliebtes Hotel achtmal in der Liste.
  const proHotel = new Map();
  for (const e of alle) {
    if (!e || !e.datum || e.datum < seit || !(e.pct > 0) || AUSGEBLENDET.has(e.resultId)) continue;
    const key = `${e.hotelLand}|${e.hotel}`;
    if (HOTEL_AUSGEBLENDET.has(key)) continue;
    if (!proHotel.has(key) || proHotel.get(key).pct < e.pct) proHotel.set(key, e);
  }
  const top = [...proHotel.values()].sort((a, b) => b.pct - a.pct).slice(0, ANZAHL)
    .map((e) => ({ hotel: e.hotel, hotelLand: e.hotelLand, land: e.land, baseline: e.baseline, pct: e.pct, euro: e.euro, basisEuro: e.basisEuro != null ? e.basisEuro : null, datum: e.datum, resultId: e.resultId || null }));

  // Eine Stunde am Edge cachen: Die Liste aendert sich selten, die Startseite ruft sie oft ab.
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  const suchenGesamt = SUCHEN_BASIS + await store.suchenGesamt();
  res.status(200).json({ success: true, seit, eintraege: top, gesamt: alle.length, suchenGesamt });
};
