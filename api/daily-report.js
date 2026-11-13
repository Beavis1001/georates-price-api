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

  // Aufschluesselung nach Verursacher. Die Gesamtsumme allein sagt nicht, wo gespart werden kann:
  // Zimmerlisten und Preis-Checks laufen beide ueber den bezahlten Proxy, haben aber voellig
  // unterschiedlichen Wert. Ein Zimmerabruf ohne folgende Pruefung kostet Geld und bringt nichts.
  const mbRooms = Math.round(s.kb_rooms / 1024);
  const mbCheck = Math.round(s.kb_check / 1024);
  // Durchschnitt pro bezahltem Abruf (Cache-Treffer kosten nichts und zaehlen hier nicht mit).
  const mbProCheck = s.anfragen_check ? Math.round((s.kb_check / 1024 / s.anfragen_check) * 10) / 10 : null;
  const mbProRoom = s.anfragen_rooms ? Math.round((s.kb_rooms / 1024 / s.anfragen_rooms) * 10) / 10 : null;
  // Wie oft wurde eine Zimmerliste geladen, ohne dass daraus eine Pruefung wurde? Negative Werte
  // sind moeglich (Pruefung ohne vorherigen Zimmerabruf, etwa ueber einen Permalink) und bleiben
  // bewusst stehen, statt auf 0 geschoent zu werden.
  const abbrueche = (s.anfragen_rooms + s.cache_rooms) - (s.anfragen_check + s.cache_check);
  const anteilRooms = s.kb ? Math.round((s.kb_rooms / s.kb) * 100) : 0;

  // Reichweite. Die Preis-Check-Zahlen oben sagen nichts darueber, wie viele Menschen die Seite
  // ueberhaupt gesehen haben - wer einen Ratgeber liest und geht, taucht dort nicht auf. Seit
  // dem 05.11.2026 zaehlt /api/hit das mit, cookiefrei (lib/store.js).
  const b = await store.besucherTag(gestern);
  const topLand = Object.entries(b.laender).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'keine';
  const topQuelle = Object.entries(b.quellen).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'nur Direktaufrufe';
  const topSeite = Object.entries(b.seiten).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'keine';
  const monat = gestern.slice(0, 7);
  const [besuchImMonat, besuchImMonatMensch] = await Promise.all([
    store.besucherImMonat(monat),
    store.besucherImMonat(monat, true),
  ]);
  // Beide Zahlen nennen, nie nur eine. Die Gesamtzahl allein ist wertlos (am 07.11. waren von
  // 24 Besuchern vermutlich fast alle Maschinen), die Menschenzahl allein waere eine
  // Schaetzung, die niemand mehr nachpruefen kann.
  const menschen = `${b.menschlich.besucher} Besucher, ${b.menschlich.aufrufe} Seitenaufrufe`;

  const status = `${warnung ? 'WARNUNG ' : ''}TAGESBERICHT ${gestern}: ${s.anfragen} Anfragen, ${s.erfolge} mit Preis`
    + (quote !== null ? ` (${Math.round(quote * 100)} %)` : '') + `, ${s.funde} Funde, ${mb} MB Proxy`
    + (store.DAILY_MB_LIMIT ? ` von ${store.DAILY_MB_LIMIT} MB Deckel` : '')
    + ` || Zimmerlisten: ${s.anfragen_rooms} geladen, ${mbRooms} MB`
    + (mbProRoom !== null ? ` (${mbProRoom} MB/Abruf)` : '') + `, ${s.cache_rooms} aus Cache`
    + ` || Preis-Checks: ${s.anfragen_check} gerechnet, ${mbCheck} MB`
    + (mbProCheck !== null ? ` (${mbProCheck} MB/Check)` : '') + `, ${s.cache_check} aus Cache`
    + ` || Zimmerlisten-Anteil am Traffic: ${anteilRooms} %, ohne folgende Pruefung: ${abbrueche}`
    + ` || Reichweite gesamt: ${b.besucher} Besucher, ${b.aufrufe} Seitenaufrufe`
    + ` (Monat ${monat}: ${besuchImMonat} Besucher)`
    + ` || davon echter Browser: ${menschen}`
    + ` (Monat ${monat}: ${besuchImMonatMensch} Besucher)`
    + ` || Laender: ${topLand} || Seiten: ${topSeite} || Verweise: ${topQuelle}`;
  await store.logQuery({ ...LEERE_ZEILE, status });
  res.status(200).json({
    success: true, tag: gestern, ...s, mb, quote, warnung,
    mbRooms, mbCheck, mbProRoom, mbProCheck, anteilRooms, abbrueche,
    besucher: b.besucher, aufrufe: b.aufrufe, laender: b.laender, seiten: b.seiten, quellen: b.quellen,
    menschlich: b.menschlich,
    monat, besucherImMonat: besuchImMonat, besucherImMonatMenschlich: besuchImMonatMensch,
  });
};
