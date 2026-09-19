/**
 * GeoRates – Abfrage-Log für Google Sheets
 * -----------------------------------------
 * Dieses Skript nimmt jede Preisabfrage von GeoRates entgegen und schreibt sie
 * als neue Zeile in DIESE Google-Tabelle. So sammelst du automatisch alle Deals.
 *
 * Einrichtung: siehe Anleitung (google-sheet-log-anleitung).
 */

// Muss identisch zum Vercel-Env-Var LOG_WEBHOOK_TOKEN sein. Leer lassen = keine Prüfung.
const SECRET = 'HIER-EIN-GEHEIMES-WORT-EINTRAGEN';

const HEADERS = [
  'Datum/Uhrzeit',
  'Hotel-Link',
  'Zimmer',
  'Verpflegung',
  'Storno',
  'Ausgangsland',
  'Ausgangs-Preis (€)',
  'Bestes Land',
  'Bester Preis (€)',
  'Bester Preis vor Ort',
  'Ersparnis %',
  'Ersparnis (€)',
  // Ab hier neu – bei einer bestehenden Tabelle diese vier Überschriften einmalig
  // in die Spalten M bis P schreiben.
  'Herkunftsland',
  'Relevant',
  'VPN empfohlen',
  'Status',
  // Spalte Q: alle geprüften Länder einer Suche, nicht nur der Sieger.
  // Format: DE:1292.06:EUR|JP:1264:JPY|US:-:USD
  'Alle Länder',
  // Spalte R: Land der Unterkunft (ISO-Kürzel aus dem Booking-Link).
  // Erst damit lässt sich fragen, ob ein Land bei Hotels IN diesem Land besser abschneidet.
  'Hotel-Land'
];

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);

    // Einfacher Schutz: nur Anfragen mit dem richtigen Token annehmen.
    if (SECRET && d.token !== SECRET) {
      return ContentService.createTextOutput('unauthorized');
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    // Kopfzeile automatisch anlegen, falls die Tabelle noch leer ist.
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
    }

    sheet.appendRow([
      new Date(),
      d.hotelLink || '',
      d.room || '',
      d.board || '',
      d.cancel || '',
      d.baselineLand || '',
      d.baselinePreisEuro,
      d.bestesLand || '',
      d.bestPreisEuro,
      d.bestPreisVorOrt || '',
      d.ersparnisProzent,
      d.ersparnisEuro,
      d.herkunftsland || '',
      d.relevant || '',
      d.empfehlung || '',
      d.status || '',
      d.alleLaender || '',
      d.hotelLand || ''
    ]);

    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error: ' + err);
  }
}
