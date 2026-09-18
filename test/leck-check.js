// Leck-Check: durchsucht Dateien auf Dinge, die NIE in ein oeffentliches Repository gehoeren.
//
// Aufruf:  node test/leck-check.js [pfad ...]      (ohne Argument: das ganze Repo)
// Exit-Code 1, wenn etwas gefunden wurde - damit laesst sich das vor jedem Hochladen laufen.
//
// Anlass: Am 17.09.2026 landete die echte Hotelsuche eines Besuchers - inklusive Reisedaten
// und Session-ID - als "Beispiel" in einem Code-Kommentar und ging so live. Gefunden hat es
// nicht der Autor, sondern der Besucher selbst, der seine eigene Suche im Quelltext wiedererkannt
// hat. Genau dagegen ist dieses Skript da: Beispiele werden erfunden, nicht aus dem Log kopiert.

const fs = require('fs');
const path = require('path');

const MUSTER = [
  { name: 'Booking-Hotellink',        re: /https?:\/\/(?:www\.)?booking\.com\/hotel\//gi,
    hinweis: 'Beispiel-Links erfinden, nicht aus dem Log kopieren.' },
  { name: 'Booking-Partner-/Trackingparameter', re: /[?&](?:aid|label|sid|srpvid|highlighted_blocks|matching_block_id)=/gi,
    hinweis: 'Stammt fast sicher aus einer echten Besuchersuche.' },
  { name: 'Reisedaten im Link',       re: /[?&]check(?:in|out)(?:_year)?=/gi,
    hinweis: 'Reisezeitraum eines Besuchers.' },
  { name: 'Smartproxy-Zugangsdaten',  re: /smart-[a-z0-9]{8,}|proxy\.smartproxy\.net:\d+["'][^)\n]*:/gi,
    hinweis: 'Zugangsdaten gehoeren ausschliesslich in Vercel-Umgebungsvariablen.' },
  { name: 'Upstash-/Turnstile-Token', re: /A[A-Za-z0-9_-]{20,}=|0x4[A-Za-z0-9]{20,}/g,
    hinweis: 'Sieht nach einem Token aus - pruefen.' },
  { name: 'ID der Log-Tabelle',       re: /1clTIr0cwbHcixAuIsulJc5HrIHWuMw-Zhu6c9A8cQH4/g,
    hinweis: 'Die Google-Tabelle mit allen Abfragen - nicht oeffentlich verlinken.' },
  { name: 'E-Mail-Adresse (ausser info@)', re: /\b[A-Za-z0-9._%+-]+@(?!georates\.tech)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    hinweis: 'Fremde Adresse im Code?', nurIn: /\.(js|html|json|webmanifest)$/i },
];

// Dateien, die gar nicht erst geprueft werden (Binaerkram, Abhaengigkeiten).
const UEBERSPRINGEN = /(^|\/)(node_modules|\.git)(\/|$)|\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?)$/i;
// Zeilen, die eine Ausnahme ausdruecklich erlauben. Wer hier etwas markiert, uebernimmt die
// Verantwortung dafuer - deshalb gehoert in dieselbe Zeile eine kurze Begruendung.
const AUSNAHME = /leck-check-ok/;
// Eingabefeld-Platzhalter sind per Definition erfundene Beispiele, keine echten Links.
const PLATZHALTER = /placeholder\s*=/;

function dateienUnter(p, raus = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      const voll = path.join(p, e);
      if (UEBERSPRINGEN.test(voll)) continue;
      dateienUnter(voll, raus);
    }
  } else if (!UEBERSPRINGEN.test(p)) {
    raus.push(p);
  }
  return raus;
}

const ziele = process.argv.slice(2);
const wurzel = path.resolve(__dirname, '..');
const dateien = (ziele.length ? ziele : [wurzel]).flatMap((z) => dateienUnter(path.resolve(z)));

let treffer = 0;
const selbst = path.resolve(__filename);
for (const datei of dateien) {
  if (path.resolve(datei) === selbst) continue; // sonst meldet das Skript seine eigenen Muster
  let text;
  try { text = fs.readFileSync(datei, 'utf8'); } catch (e) { continue; }
  const zeilen = text.split('\n');
  for (const m of MUSTER) {
    zeilen.forEach((zeile, i) => {
      if (AUSNAHME.test(zeile) || PLATZHALTER.test(zeile)) return;
      if (m.nurIn && !m.nurIn.test(datei)) return;
      m.re.lastIndex = 0;
      if (!m.re.test(zeile)) return;
      treffer++;
      console.log(`FUND  ${path.relative(wurzel, datei)}:${i + 1}  [${m.name}]`);
      console.log(`      ${zeile.trim().slice(0, 110)}`);
      console.log(`      -> ${m.hinweis}`);
    });
  }
}

console.log(treffer
  ? `\n${treffer} Fund(e) - NICHT hochladen, bevor das geklaert ist.`
  : `\nSauber: ${dateien.length} Dateien geprueft, nichts gefunden.`);
process.exit(treffer ? 1 : 0);
