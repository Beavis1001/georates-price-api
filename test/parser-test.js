// Parser-Regressionstest ohne Netzwerk und ohne Browser: zieht die reinen Textfunktionen
// aus api/check-price.js und prueft sie gegen gespeicherte Seitenausschnitte.
//
// Aufruf:  node test/parser-test.js
//
// Die Vorlage in test/seite-genius.txt ist ein ECHTER Booking-Seitenausschnitt (Tarifstruktur
// mit Genius-Rabatt), aber mit erfundenen Zimmer- und Hotelnamen - Suchen von Besuchern
// gehoeren nicht in ein oeffentliches Repository.

const fs=require('fs');
const crypto=require('crypto');
const src=fs.readFileSync('api/check-price.js','utf8');
const teile=[/const TAX_LINE_RE[\s\S]*?const NEG_AMOUNT_RE = [^\n]*\n/,/function extractExclusiveTaxPct[\s\S]*?\n}\n/,/const ABS_EXTRA_TAX_RE[\s\S]*?\nfunction extractAbsoluteExtraTax[\s\S]*?\n}\n/,/function looksLikeNewRoomHeading[\s\S]*?\n}\n/,/function tarifstufen[\s\S]*?\n}\n/,/function boardOfLine[\s\S]*?\n}\n/,/function cancelOfLine[\s\S]*?\n}\n/,/function findRoomPrice[\s\S]*?\n}\n/,/function parseAmount[\s\S]*?\n}\n/,/function boardsFromText[\s\S]*?\n}\n/,/function cancelsFromText[\s\S]*?\n}\n/,/function computeRoomOptions[\s\S]*?\n}\n/,/const ALL_COUNTRIES = [^\n]*\n/,/function alleLaenderFuersLog[\s\S]*?\n}\n/,/function hotelLandAusLink[\s\S]*?\n}\n/,/const DEFAULT_CURRENCY_BY_COUNTRY = \{[\s\S]*?\n\};\n/,/const HOTEL_LAND_ALIAS = [^\n]*\n/,/const HOTEL_LAND_MUTTERLAND = \{[\s\S]*?\n\};\n/,/function proxyLandFuerHotel[\s\S]*?\n}\n/,/function laenderFuerDieseSuche[\s\S]*?\n}\n/,/const WAEHRUNGS_PARAMS = [^\n]*\n/,/function normalisiereLinkFuerAbruf[\s\S]*?\n}\n/,/const DEFAULT_DEVICE = [^\n]*\n/,/const LOG_STRIP_PARAMS = new Set\(\[[\s\S]*?\]\);\n/,/function linkFuersLog[\s\S]*?\n}\n/,/const CACHE_VERSION = [^\n]*\n/,/function cacheKeyFor[\s\S]*?\n}\n/];
let code='const ROOM_NAME_MAX_LEN = 140;\nconst BACKSCAN_LINES = 6;\n'; for(const re of teile){const m=src.match(re); if(!m){console.error('FEHLT',re);process.exit(1);} code+=m[0]+'\n';}
// Mit `const` deklarierte Werte bleiben im eval-Geltungsbereich und waeren hier draussen nicht
// sichtbar - die Funktionen dagegen schon. Deshalb die benoetigten Konstanten ausdruecklich
// herausreichen, statt sie im Test ein zweites Mal zu pflegen (sonst prueft der Test am Ende
// seine eigene Kopie und nicht den echten Code).
code += 'globalThis.ALL_COUNTRIES = ALL_COUNTRIES;\nglobalThis.DEFAULT_DEVICE = DEFAULT_DEVICE;\nglobalThis.cacheKeyFor = cacheKeyFor;\n';
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
function pruefeLog(name, results, soll, laender){
  const ist = alleLaenderFuersLog(results, laender);
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

// --- Dynamischer Platz fuer das Land der Unterkunft -------------------------------------
// Anlass: Ein Hotel auf Réunion (RE) wurde gegen 13 aussereuropaeische Laender verglichen und
// gegen keine einzige andere europaeische Sitzung. Alle Links hier sind erfunden.
function pruefeListe(name, link, sollZusatz){
  const liste = laenderFuerDieseSuche(link);
  const zusatz = liste.filter((c) => !ALL_COUNTRIES.includes(c));
  const ok = zusatz.join(',') === sollZusatz
    // Das Zusatzland muss VORNE stehen, sonst kuerzt das Zeitlimit genau es weg.
    && (!sollZusatz || liste[1] === sollZusatz)
    // Kein Land darf doppelt vorkommen - sonst zahlen wir eine Abfrage zweimal.
    && new Set(liste).size === liste.length;
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' +['+zusatz.join(',')+'] n='+liste.length);
}
pruefeListe('Réunion -> Frankreich (Mutterland)', 'https://www.booking.com/hotel/re/beispiel.de.html', 'FR');  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log
pruefeListe('Grossbritannien: Booking schreibt /uk/', 'https://www.booking.com/hotel/uk/beispiel.de.html', 'GB');  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log
pruefeListe('deutsches Hotel: kein Zusatz, keine Kosten', 'https://www.booking.com/hotel/de/beispiel.de.html', '');  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log
pruefeListe('Japan steht schon in der festen Liste', 'https://www.booking.com/hotel/jp/beispiel.de.html', '');  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log
pruefeListe('Tuerkei nur ueber den dynamischen Platz', 'https://www.booking.com/hotel/tr/beispiel.de.html', 'TR');  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log
pruefeListe('Puerto Rico -> USA (schon in der Liste)', 'https://www.booking.com/hotel/pr/beispiel.de.html', '');  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log
pruefeListe('unbekanntes Land: lieber gar nicht pruefen', 'https://www.booking.com/hotel/zz/beispiel.de.html', '');  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log
pruefeListe('kein Hotellink', 'https://www.booking.com/searchresults.de.html', '');

// Die Log-Spalte muss der Liste DIESER Suche folgen, nicht der festen.
pruefeLog('Zusatzland steht auch im Log',
  [{country:'FR',priceEuro:119,currency:'EUR'},{country:'DE',priceEuro:125,currency:'EUR'}],
  'DE:125:EUR|FR:119:EUR', laenderFuerDieseSuche('https://www.booking.com/hotel/re/beispiel.de.html'));  // leck-check-ok: frei erfundenes Hotel "beispiel", stammt nicht aus dem Log

// --- Cache-Schluessel: gleiche Suche muss gleich landen ----------------------------------
// Anlass: Der Schluessel wurde aus dem ROHEN Link gebildet. Booking haengt sid, aid und label
// pro Sitzung neu an - zwei Besucher mit derselben Suche hatten also nie denselben Schluessel,
// und jede Wiederholung kostete rund 30 MB bezahlten Traffic fuer eine Antwort, die schon dalag.
// Alle Links hier sind erfunden.
// Bewusst die ECHTE cacheKeyFor aus dem Produktivcode, nicht eine nachgebaute Kopie - sonst
// prueft der Test am Ende sich selbst. Sie faengt intern Fehler ab und faellt auf den Rohlink
// zurueck; genau deshalb muessen alle Bausteine oben mitextrahiert sein.
const schluessel = (l) => cacheKeyFor(l, 'Doppelzimmer', 'uebernachtung', 'egal', DEFAULT_DEVICE);
function pruefeSchluessel(name, a, b, sollGleich){
  const ok = (schluessel(a) === schluessel(b)) === sollGleich;
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' '+(sollGleich?'gleich':'verschieden'));
}
const basis = 'https://www.booking.com/hotel/de/beispielhof';  // leck-check-ok: frei erfundenes Hotel
const datum = 'checkin=2026-11-10&checkout=2026-11-11&group_adults=2';  // leck-check-ok: erfundene Testdaten fuer den Cache-Schluessel, stammen nicht aus dem Log
pruefeSchluessel('andere sid/aid/label = selbe Suche',
  `${basis}.de.html?${datum}&sid=aaaa1111&aid=304142&label=gen173nr-xyz`,  // leck-check-ok: erfundene Testdaten fuer den Cache-Schluessel, stammen nicht aus dem Log
  `${basis}.de.html?${datum}&sid=bbbb2222&aid=999999`, true);  // leck-check-ok: erfundene Testdaten fuer den Cache-Schluessel, stammen nicht aus dem Log
pruefeSchluessel('fremde Sprachfassung = selbe Suche',
  `${basis}.de.html?${datum}`, `${basis}.en-gb.html?${datum}`, true);
pruefeSchluessel('andere Reisedaten = andere Suche',
  `${basis}.de.html?${datum}`,
  `${basis}.de.html?checkin=2026-12-01&checkout=2026-12-02&group_adults=2`, false);  // leck-check-ok: erfundene Testdaten fuer den Cache-Schluessel, stammen nicht aus dem Log
pruefeSchluessel('andere Personenzahl = andere Suche',
  `${basis}.de.html?${datum}`,
  `${basis}.de.html?checkin=2026-11-10&checkout=2026-11-11&group_adults=4`, false);  // leck-check-ok: erfundene Testdaten fuer den Cache-Schluessel, stammen nicht aus dem Log

console.log(fehler? '\n'+fehler+' FEHLER' : '\nalle Tests bestanden');
process.exit(fehler?1:0);
