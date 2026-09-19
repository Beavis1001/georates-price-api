// Parser-Regressionstest ohne Netzwerk und ohne Browser: zieht die reinen Textfunktionen
// aus api/check-price.js und prueft sie gegen gespeicherte Seitenausschnitte.
//
// Aufruf:  node test/parser-test.js
//
// Die Vorlage in test/seite-genius.txt ist ein ECHTER Booking-Seitenausschnitt (Tarifstruktur
// mit Genius-Rabatt), aber mit erfundenen Zimmer- und Hotelnamen - Suchen von Besuchern
// gehoeren nicht in ein oeffentliches Repository.

const fs=require('fs');
const src=fs.readFileSync('api/check-price.js','utf8');
const teile=[/const TAX_LINE_RE[\s\S]*?const NEG_AMOUNT_RE = [^\n]*\n/,/function extractExclusiveTaxPct[\s\S]*?\n}\n/,/const ABS_EXTRA_TAX_RE[\s\S]*?\nfunction extractAbsoluteExtraTax[\s\S]*?\n}\n/,/function looksLikeNewRoomHeading[\s\S]*?\n}\n/,/function tarifstufen[\s\S]*?\n}\n/,/function boardOfLine[\s\S]*?\n}\n/,/function cancelOfLine[\s\S]*?\n}\n/,/function findRoomPrice[\s\S]*?\n}\n/,/function parseAmount[\s\S]*?\n}\n/,/function boardsFromText[\s\S]*?\n}\n/,/function cancelsFromText[\s\S]*?\n}\n/,/function computeRoomOptions[\s\S]*?\n}\n/,/const ALL_COUNTRIES = [^\n]*\n/,/function alleLaenderFuersLog[\s\S]*?\n}\n/,/function hotelLandAusLink[\s\S]*?\n}\n/];
let code='const ROOM_NAME_MAX_LEN = 140;\nconst BACKSCAN_LINES = 6;\n'; for(const re of teile){const m=src.match(re); if(!m){console.error('FEHLT',re);process.exit(1);} code+=m[0]+'\n';}
eval(code);
let fehler=0;
function pruefe(name, bt, room, board, cancel, erwartetBetrag, erwartetGenius){
  const [amt,,cur,gen]=findRoomPrice(bt,room,board,cancel);
  const ok = String(amt)===String(erwartetBetrag) && String(gen)===String(erwartetGenius);
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' Betrag '+String(amt).padEnd(9)+' Genius '+String(gen));
}
const bt=fs.readFileSync('test/seite-genius.txt','utf8');
pruefe('Genius-Seite, Uebernachtung/egal', bt,'Superior Double Room with Harbour View','uebernachtung','unsicher','251,27',48.53);
pruefe('Genius-Seite, storno ja',           bt,'Superior Double Room with Harbour View','uebernachtung','ja','270,29',52.2);
pruefe('Zimmer ohne Genius',                bt,'Komfort-Doppelzimmer','fruehstueck','ja','300',null);

// Regression: der Fall vom 17.09. (1523 nicht stornierbar vs 1589 kostenlos stornierbar)
const alt = ['Studio mit Kingsize-Bett','Belegung: 2 Erwachsene','Vergleichen',
 'Preis € 1.523','Einschließlich Steuern und Gebühren','Nicht kostenlos stornierbar','Zimmer auswählen',
 'Preis € 1.589','Einschließlich Steuern und Gebühren','Kostenlose Stornierung','Zimmer auswählen'].join('\n');
pruefe('17.09.: Wunsch kostenlos stornierbar', alt,'Studio mit Kingsize-Bett','uebernachtung','ja','1.589',null);
pruefe('17.09.: Wunsch nicht stornierbar',     alt,'Studio mit Kingsize-Bett','uebernachtung','nein','1.523',null);

// --- Verpflegungs-/Storno-Optionen fuers Dropdown ---------------------------------------
function pruefeOptionen(name, bt, zimmer, erwarteteBoards){
  const o = computeRoomOptions(bt, [zimmer])[zimmer] || { boards: [], cancels: [] };
  const ist = [...o.boards].sort().join(',');
  const soll = [...erwarteteBoards].sort().join(',');
  const ok = ist === soll;
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' Verpflegung ['+ist+'] Storno ['+o.cancels.join(',')+']');
}
pruefeOptionen('Zimmer ohne Verpflegungszeile = Uebernachtung', bt,'Superior Double Room with Harbour View',['uebernachtung']);
pruefeOptionen('Zimmer mit Fruehstueck inbegriffen',            bt,'Komfort-Doppelzimmer',['fruehstueck']);

// --- Log-Zeile: alle geprueften Laender, nicht nur der Sieger ---------------------------
function pruefeLog(name, results, soll){
  const ist = alleLaenderFuersLog(results);
  const ok = ist === soll;
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' '+ist);
}
pruefeLog('Reihenfolge fest, kein Preis wird "-"',
  // absichtlich in falscher Reihenfolge uebergeben - die Ausgabe folgt ALL_COUNTRIES
  [{country:'JP',priceEuro:1264,currency:'JPY'},
   {country:'DE',priceEuro:1292.06,currency:'EUR'},
   {country:'US',priceEuro:null,currency:'USD'}],
  'DE:1292.06:EUR|US:-:USD|JP:1264:JPY');
pruefeLog('Nicht geprueftes Land faellt weg',
  [{country:'DE',priceEuro:100,currency:'EUR'}], 'DE:100:EUR');

// --- Land der Unterkunft aus dem Link ---------------------------------------------------
// Die Links hier sind erfunden; echte Besuchersuchen gehoeren nicht in ein oeffentliches Repo.
function pruefeHotelLand(name, link, soll){
  const ist = hotelLandAusLink(link);
  const ok = ist === soll;
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' ['+ist+']');
}
pruefeHotelLand('deutsches Hotel', 'https://www.booking.com/hotel/de/beispielhof.de.html?checkin=2027-01-02', 'DE'); // leck-check-ok: frei erfundenes Hotel und Datum, stammt nicht aus dem Log
pruefeHotelLand('thailaendisches Hotel, fremde Sprache', 'https://www.booking.com/hotel/th/beispiel-resort.th.html', 'TH'); // leck-check-ok: frei erfundenes Hotel, stammt nicht aus dem Log
pruefeHotelLand('Suchergebnisseite ohne Hotel', 'https://www.booking.com/searchresults.de.html?ss=Muenchen', '');
pruefeHotelLand('kaputter Link', 'kein-link', '');

console.log(fehler? '\n'+fehler+' FEHLER' : '\nalle Tests bestanden');
process.exit(fehler?1:0);
