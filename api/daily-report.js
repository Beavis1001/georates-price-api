// GET /api/daily-report - Tagesbericht, einmal am Tag per Vercel Cron (vercel.json).
//
// Schreibt eine Zeile in die bestehende Google-Tabelle (ueber denselben Webhook wie das
// Abfrage-Log): Anfragen, Erfolge, Funde, Proxy-Megabyte des Vortags und eine Warnung, wenn
// die Erfolgsquote einbricht. Das ist das einfachste Monitoring, das ohne neuen Dienst
// auskommt: Faellt der Parser aus, weil Booking die Seite umbaut, steht am naechsten Morgen
// "WARNUNG" in der Tabelle statt dass es wochenlang niemand merkt.
//
// Vercel schickt beim Cron-Aufruf "Authorization: Bearer <CRON_SECRET>". Ohne passendes
// Secret wird der Aufruf abgelehnt, damit niemand die Tabelle mit Berichten fuellen kann.

const store = require('../lib/store');

const WARN_ERFOLGSQUOTE = 0.5;   // unter 50 % Erfolg bei mindestens ...
const WARN_MIN_ANFRAGEN = 5;     // ... 5 Anfragen gilt als Ausfall

// Das Abfrage-Log hat feste Spalten. Ein Bericht fuellt nur "status", der Rest bleibt leer.
const LEERE_ZEILE = {
  hotelLink: '', room: '', board: '', cancel: '', baselineLand: '', baselinePreisEuro: '',
  bestesLand: '', bestPreisEuro: '', bestPreisVorOrt: '', ersparnisProzent: '', ersparnisEuro: '',
  herkunftsland: '', relevant: '', empfehlung: '', alleLaender: '', hotelLand: '',
};

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ success: false, reason: 'unauthorized' });
    return;
  }

  // Zuerst die Quelle pruefen, dann die Zahlen. Saemtliche Zaehler liegen in Upstash: Fehlt es,
  // liest dieser Bericht ueberall Null und meldet jeden Tag zufrieden "0 Anfragen, 0 MB" -
  // also genau das Bild, das man auch bei einer stillen, ungenutzten Seite erwartet. So blieb
  // der Ausfall vom 16. bis 20.09.2026 unbemerkt: Das Monitoring war an dieselbe Stelle
  // angeschlossen, die ausgefallen war. Ohne Speicher gibt es deshalb keine Zahlen, sondern
  // eine Warnung.
  if (!store.upstashKonfiguriert()) {
    await store.logQuery({
      ...LEERE_ZEILE,
      status: 'WARNUNG TAGESBERICHT: Upstash nicht konfiguriert - Cache, Best-of, Permalinks, '
        + 'Zaehlbremse und Tagesdeckel sind ausser Betrieb. Keine Zahlen verfuegbar.',
    });
    res.status(200).json({ success: false, reason: 'upstash_not_configured' });
    return;
  }

  const gestern = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const s = await store.tagesstatistikLesen(gestern);
  const quote = s.anfragen ? s.erfolge / s.anfragen : null;
  const warnung = s.anfragen >= WARN_MIN_ANFRAGEN && quote !== null && quote < WARN_ERFOLGSQUOTE;
  const mb = Math.round(s.kb / 1024);
  const status = `${warnung ? 'WARNUNG ' : ''}TAGESBERICHT ${gestern}: ${s.anfragen} Anfragen, ${s.erfolge} mit Preis`
    + (quote !== null ? ` (${Math.round(quote * 100)} %)` : '') + `, ${s.funde} Funde, ${mb} MB Proxy`
    + (store.DAILY_MB_LIMIT ? ` von ${store.DAILY_MB_LIMIT} MB Deckel` : '');
  await store.logQuery({ ...LEERE_ZEILE, status });
  res.status(200).json({ success: true, tag: gestern, ...s, mb, quote, warnung });
};
