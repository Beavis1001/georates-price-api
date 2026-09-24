// Parser-Regressionstest ohne Netzwerk und ohne Browser: zieht die reinen Textfunktionen
// aus api/check-price.js und prueft sie gegen gespeicherte Seitenausschnitte.
//
// Aufruf:  node test/parser-test.js
//
// Die Vorlage in test/seite-genius.txt ist ein ECHTER Booking-Seitenausschnitt (Tarifstruktur
// mit Genius-Rabatt), aber mit erfundenen Zimmer- und Hotelnamen - Suchen von Besuchern
// gehoeren nicht in ein oeffentliches Repository.

const fs=require('fs');
// Seit der Aufteilung in Module werden die Funktionen normal importiert. Vorher zog der Test sie
// per Regex aus api/check-price.js heraus - das brach bei jeder Umbenennung und prueft im Zweifel
// die eigene Kopie statt den echten Code.
const { findRoomPrice, findRoomPriceMobile, mobilBewerten, computeRoomOptions, summarize } = require('../lib/parser');
const { ALL_COUNTRIES, alleLaenderFuersLog, hotelLandAusLink, hotelNameAusLink, laenderFuerDieseSuche, linkFuersLog, normalisiereLinkFuerAbruf } = require('../lib/config');
const { cacheKeyFor } = require('../lib/store');
let fehler=0;
function pruefe(name, bt, room, board, cancel, erwartetBetrag, erwartetGenius){
  const [amt,,cur,gen]=findRoomPrice(bt,room,board,cancel);
  const ok = String(amt)===String(erwartetBetrag) && String(gen)===String(erwartetGenius);
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' Betrag '+String(amt).padEnd(9)+' Genius '+String(gen));
}
const bt=fs.readFileSync(require('path').join(__dirname,'seite-genius.txt'),'utf8');
pruefe('Genius-Seite, Uebernachtung/egal', bt,'Superior Double Room with Harbour View','uebernachtung','unsicher','251,27',48.53);
pruefe('Genius-Seite, storno ja',           bt,'Superior Double Room with Harbour View','uebernachtung','ja','270,29',52.2);
pruefe('Zimmer ohne Genius',                bt,'Komfort-Doppelzimmer','fruehstueck','ja','300',null);

// Regression: der Fall vom 17.09. (1523 nicht stornierbar vs 1589 kostenlos stornierbar)
const alt = ['Studio mit Kingsize-Bett','Belegung: 2 Erwachsene','Vergleichen',
 'Preis € 1.523','Einschließlich Steuern und Gebühren','Nicht kostenlos stornierbar','Zimmer auswählen',
 'Preis € 1.589','Einschließlich Steuern und Gebühren','Kostenlose Stornierung','Zimmer auswählen'].join('\n');
pruefe('17.09.: Wunsch kostenlos stornierbar', alt,'Studio mit Kingsize-Bett','uebernachtung','ja','1.589',null);
pruefe('17.09.: Wunsch nicht stornierbar',     alt,'Studio mit Kingsize-Bett','uebernachtung','nein','1.523',null);

// --- 21.09.: Zimmername kommt mehrfach vor -----------------------------------------------
// Sechs Abrufe derselben Hotelseite (Horizon of Pattaya, deutsche Sitzung) lieferten
// abwechselnd 452,84 und 462,24 EUR - zwei Tarife DESSELBEN Zimmers, einmal nicht stornierbar,
// einmal kostenlos stornierbar. Ursache war nicht Booking: findRoomPrice ankerte auf der ERSTEN
// Zeile, die mit dem Zimmernamen beginnt, und die lag je nach Abruf vor oder hinter dem ersten
// Tarifblock. Seitdem werden die Stufen aus ALLEN Fundstellen vereinigt und nach Position
// sortiert - die Auswahl ist damit unabhaengig davon, wo der erste Namenstreffer lag.
//
// Zusaetzlich geprueft: die Tarifart, die findRoomPrice jetzt mitliefert (Stelle 5 und 6).
function pruefeTarif(name, bt, room, board, cancel, sollBetrag, sollStorno){
  const [amt,,,,storno]=findRoomPrice(bt,room,board,cancel);
  const ok = String(amt)===String(sollBetrag) && String(storno)===String(sollStorno);
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' Betrag '+String(amt).padEnd(9)+' Storno '+String(storno));
}
const zweiTarife = [
 'Deluxe Doppelzimmer mit Balkon','Belegung: 2 Erwachsene','28 m²',
 '€ 489','€ 453','€ 489,43','€ 452,84','Einschließlich Steuern und Gebühren','7% sparen','Nicht kostenlos stornierbar','Zimmer auswählen',
 '€ 544','€ 462','€ 543,81','€ 462,24','Einschließlich Steuern und Gebühren','15% sparen','Kostenlose Stornierung vor dem 20. Dezember 2026','Zimmer auswählen',
 // zweite Fundstelle des Namens (Auswahlliste am Seitenende)
 'Deluxe Doppelzimmer mit Balkon','Zimmer auswählen','0','1          (€ 452)'].join('\n');
pruefeTarif('zwei Tarife, egal -> erste Stufe im Text', zweiTarife,'Deluxe Doppelzimmer mit Balkon','egal','unsicher','452,84','nein');
pruefeTarif('zwei Tarife, Wunsch stornierbar',          zweiTarife,'Deluxe Doppelzimmer mit Balkon','egal','ja','462,24','ja');
pruefeTarif('zwei Tarife, Wunsch nicht stornierbar',    zweiTarife,'Deluxe Doppelzimmer mit Balkon','egal','nein','452,84','nein');

// Dieselben zwei Tarife, aber die Fundstellen in umgekehrter Reihenfolge im Text. Frueher
// entschied allein die erste Fundstelle, welche Stufen ueberhaupt gesehen wurden - der nicht
// stornierbare Tarif war dann unsichtbar.
const zweiFundstellen = [
 'Deluxe Doppelzimmer mit Balkon','Belegung: 2 Erwachsene','28 m²',
 '€ 544','€ 462','€ 543,81','€ 462,24','Einschließlich Steuern und Gebühren','15% sparen','Kostenlose Stornierung vor dem 20. Dezember 2026','Zimmer auswählen',
 'Deluxe Doppelzimmer mit Balkon','Belegung: 2 Erwachsene','28 m²',
 '€ 489','€ 453','€ 489,43','€ 452,84','Einschließlich Steuern und Gebühren','7% sparen','Nicht kostenlos stornierbar','Zimmer auswählen'].join('\n');
pruefeTarif('beide Fundstellen werden vereinigt', zweiFundstellen,'Deluxe Doppelzimmer mit Balkon','egal','nein','452,84','nein');

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

// --- Laenderauswahl durch den Nutzer -----------------------------------------------------------
function pruefeAuswahl(name, auswahl, soll, link){
  const ist = laenderFuerDieseSuche(link || 'https://www.booking.com/hotel/de/beispiel.de.html', auswahl, 'DE').join(','); // leck-check-ok: erfundenes Hotel
  const ok = ist === soll; if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' '+ist);
}
pruefeAuswahl('nur JP und US, Ausgangsland kommt dazu', ['jp','US'], 'DE,US,JP');
pruefeAuswahl('unbekannte Kuerzel fallen weg', ['XX','JP'], 'DE,JP');
pruefeAuswahl('ein Land allein ist kein Vergleich', ['DE'], ALL_COUNTRIES.join(','));
pruefeAuswahl('leere Auswahl = alle', [], ALL_COUNTRIES.join(','));
pruefeAuswahl('Hotelland bleibt waehlbar', ['FR'], 'DE,FR', 'https://www.booking.com/hotel/fr/beispiel.de.html'); // leck-check-ok: erfundenes Hotel

// --- Schwelle: 1 % ohne Umrechnung, 3 % mit ---------------------------------------------------
function pruefeSchwelle(name, results, sollRelevant, sollSchwelle){
  const s = summarize(results.map((r)=>({...r})), 'DE');
  const ok = s.relevantSaving === sollRelevant && s.relevantThresholdPct === sollSchwelle; if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' relevant='+s.relevantSaving+' Schwelle='+s.relevantThresholdPct+' %='+s.savingsPct);
}
pruefeSchwelle('2,2 % in EUR gemessen = Fund',
  [{country:'DE',priceEuro:1292.06,currency:'EUR'},{country:'JP',priceEuro:1264,currency:'EUR'}], true, 1);
pruefeSchwelle('2,2 % aus USD umgerechnet = kein Fund',
  [{country:'DE',priceEuro:1292.06,currency:'EUR'},{country:'US',priceEuro:1264,currency:'USD'}], false, 3);
pruefeSchwelle('11 % aus COP umgerechnet = Fund',
  [{country:'DE',priceEuro:1000,currency:'EUR'},{country:'CO',priceEuro:890,currency:'COP'}], true, 3);

// --- Cache-Schluessel: Sitzungs-ID und Sprache aendern nichts -----------------------------------
function pruefeCache(name, a, b, sollGleich){
  const ka = cacheKeyFor(a,'Zimmer','egal','unsicher','windows',ALL_COUNTRIES);
  const kb = cacheKeyFor(b,'Zimmer','egal','unsicher','windows',ALL_COUNTRIES);
  const ok = (ka===kb)===sollGleich; if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' '+(ka===kb?'gleich':'verschieden'));
}
const basis='https://www.booking.com/hotel/de/beispiel.de.html?checkin=2027-03-01&checkout=2027-03-03'; // leck-check-ok: erfundenes Hotel und Datum
pruefeCache('gleiche Suche, andere sid/aid', basis+'&sid=abc&aid=1', basis+'&sid=xyz&aid=2&label=foo', true); // leck-check-ok: erfundene Platzhalterwerte, kein echter Link
pruefeCache('englischer Link derselben Suche', basis, basis.replace('.de.html','.en-gb.html')+'&lang=en-us', true);
pruefeCache('anderes Datum = andere Suche', basis, basis.replace('2027-03-03','2027-03-04'), false);
pruefeCache('andere Personenzahl = andere Suche', basis+'&group_adults=2', basis+'&group_adults=4', false);

// --- Hotelname fuers Best-of -------------------------------------------------------------------
function pruefeName(name, link, soll){
  const ist = hotelNameAusLink(link); const ok = ist===soll; if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' ['+ist+']');
}
pruefeName('Slug wird lesbar', 'https://www.booking.com/hotel/de/beispiel-hof-am-see.de.html?checkin=2027-01-01', 'Beispiel Hof Am See'); // leck-check-ok: erfundenes Hotel und Datum
pruefeName('ohne Sprachkuerzel', 'https://www.booking.com/hotel/th/beispiel-resort.html', 'Beispiel Resort'); // leck-check-ok: erfundenes Hotel
pruefeName('kein Hotel', 'https://www.booking.com/searchresults.de.html', '');

// --- Deal-Plaketten je Tarifstufe -------------------------------------------------------------
// Anlass 20.09.: Indien war nur wegen "Booking.com bezahlt -27.413 INR" guenstiger - ein
// Zahlungsart-Rabatt, kein Landespreis. Der Grund muss am Ergebnis stehen.
const dealText = ['Doppelzimmer Deluxe','Belegung: 2 Erwachsene',
 'Mobile Rate','Preis € 900','Einschließlich Steuern und Gebühren','Kostenlose Stornierung','Zimmer auswählen',
 'Preis € 1.000','Einschließlich Steuern und Gebühren','Nicht kostenlos stornierbar','Rabatt für Online-Zahlung','Zimmer auswählen'].join('\n');
function pruefeDeals(name, cancel, sollBetrag, sollDeals){
  const r = findRoomPrice(dealText,'Doppelzimmer Deluxe','egal',cancel);
  const ist = (r[6]||[]).slice().sort().join(',');
  const ok = String(r[0])===sollBetrag && ist===sollDeals; if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' Betrag '+r[0]+' Deals ['+ist+']');
}
pruefeDeals('Stufe 1 traegt Mobile Rate', 'ja', '900', 'mobile');
pruefeDeals('Stufe 2 traegt Online-Zahlungsrabatt', 'nein', '1.000', 'online_payment');
const ohneDeal = findRoomPrice(bt,'Komfort-Doppelzimmer','fruehstueck','ja');
{ const ok = Array.isArray(ohneDeal[6]) && ohneDeal[6].length===0; if(!ok) fehler++; console.log((ok?'OK  ':'FEHL')+' | '+'Zimmer ohne Plakette: leere Deal-Liste'.padEnd(44)+' ['+(ohneDeal[6]||[]).join(',')+']'); }

// --- Nutzerpreis als konservative Referenz ------------------------------------------------------
function pruefeNutzerpreis(name, userPrice, sollPct, sollBasis, sollDiffers){
  const s = summarize([{country:'DE',priceEuro:1000,currency:'EUR'},{country:'JP',priceEuro:900,currency:'EUR'}], 'DE', {userPriceEuro:userPrice});
  const ok = s.savingsPct===sollPct && s.baselineUsedEuro===sollBasis && s.userPriceDiffers===sollDiffers; if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' %='+s.savingsPct+' Basis='+s.baselineUsedEuro+' abweichend='+s.userPriceDiffers);
}
pruefeNutzerpreis('ohne Nutzerpreis: 10 % gegen DE', null, 10, 1000, false);
pruefeNutzerpreis('Nutzer sieht 950: gegen 950 gerechnet', 950, 5.3, 950, true);
pruefeNutzerpreis('Nutzer sieht 1100: unser DE bleibt Referenz', 1100, 10, 1000, true);
pruefeNutzerpreis('Nutzer sieht 1002 (0,2 %): keine Abweichung', 1002, 10, 1000, false);



// --- 21.09.: Mobiles Layout (MOBILE_CHECK) ------------------------------------------------
// Erfundenes Hotel, Struktur nach einem Screenshot der mobilen Booking-Seite (deutsche Sitzung).
// Kein "Preis € X" in einer Zeile, keine Steuern-Zeile unter dem Preis: Anker ist "Preis fuer N
// Naechte:", darunter Streichpreis und tatsaechlicher Preis. Der Desktop-Parser findet hier nichts.
const mobil = ['Doppelzimmer mit Balkon','Wir haben noch 4','22 m²','Stadtblick','Kostenfreies WLAN',
 'Preiswert + Frühstück','Preis für:','Sehr gutes Frühstück im Preis inbegriffen','Nicht kostenlos stornierbar','•','Online-Zahlung',
 'Preis nur für Mobilgerätnutzer','Preis für 5 Nächte:','€ 1.899','€ 1.709','Es können zusätzliche Gebühren anfallen.','Reservieren',
 'Flexibel + Frühstück','Preis für:','Sehr gutes Frühstück im Preis inbegriffen','Kostenlose Stornierung vor dem 1. März 2027',
 'Preis für 5 Nächte:','€ 1.958','Es können zusätzliche Gebühren anfallen.','Reservieren',
 'Suite mit Meerblick','28 m²','Nur Übernachtung','Preis für:','Nicht kostenlos stornierbar','Preis für 5 Nächte:','€ 2.400','Reservieren'].join('\n');
function pruefeMobil(name, bt, room, board, cancel, erwartetBetrag, erwartetDeals){
  const r = findRoomPriceMobile(bt, room, board, cancel);
  const [amt] = r; const deals = (r[6] || []).slice().sort().join(',');
  const ok = String(amt)===String(erwartetBetrag) && (erwartetDeals === undefined || deals === erwartetDeals);
  if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+name.padEnd(44)+' Betrag '+String(amt).padEnd(9)+' Deals '+deals);
}
pruefeMobil('Mobil: Fruehstueck, nicht stornierbar', mobil,'Doppelzimmer mit Balkon','fruehstueck','nein','1.709','mobile,online_payment');
pruefeMobil('Mobil: letzte Betragszeile, nicht der Streichpreis', mobil,'Doppelzimmer mit Balkon','egal','unsicher','1.709');
pruefeMobil('Mobil: kostenlos stornierbar -> zweite Karte', mobil,'Doppelzimmer mit Balkon','fruehstueck','ja','1.958','');
pruefeMobil('Mobil: naechstes Zimmer nicht vermischt', mobil,'Suite mit Meerblick','uebernachtung','unsicher','2.400','');
pruefeMobil('Mobil: Zimmer nicht auf der Seite -> null', mobil,'Penthouse','egal','unsicher','null');
pruefeMobil('Mobil-Parser auf Desktop-Seite -> null (nie raten)', bt,'Superior Double Room with Harbour View','uebernachtung','unsicher','null');

// --- 24.09.: Echte mobile Struktur (Hotelnamen, Preise und Daten erfunden) ----------------
// So sieht die Karte auf booking.com mit Android-Kennung wirklich aus. Ohne Rabatt steht der
// Preis zweimal ("€ X" und "Preis € X"); mit Mobile Rate stehen Streichpreis und Preis in EINER
// Zeile, darunter die Vorleser-Zeile "Originalpreis ... Aktueller Preis ...".
const mobilEcht = ['4 Ergebnisse','Kleines Doppelzimmer','Bett: 1 Doppelbett','14 m²','Kostenfreies WLAN',
 'Preiswert','Preis für:','max. Personenzahl: 2','Nicht kostenlos stornierbar','•','Online-Zahlung',
 'Preis für 3 Nächte:','€ 312','Preis € 312','Einschließlich Steuern und Gebühren','Reservieren',
 'Flexibel','Preis für:','max. Personenzahl: 2','Kostenlose Stornierung vor 12:00 Uhr am 3. März 2027',
 'Keine Vorauszahlung notwendig – Zahlen Sie in der Unterkunft',
 'Preis nur für Mobilgerätnutzer','Preis für 3 Nächte:','€ 366 € 281','Originalpreis € 366 Aktueller Preis € 281',
 'Einschließlich Steuern und Gebühren','Reservieren',
 'Wir haben noch 1','Melden Sie sich an, um zu sehen, ob Genius-Rabatte gelten',
 'Kleines Doppelzimmer mit Hofblick','Bett: 1 Doppelbett','16 m²',
 'Flexibel + Frühstück','Preis für:','max. Personenzahl: 2','Sehr gutes Frühstück im Preis inbegriffen',
 'Kostenlose Stornierung vor 12:00 Uhr am 3. März 2027','Preis nur für Mobilgerätnutzer','Preis für 3 Nächte:',
 '€ 1.402 € 1.078','Originalpreis € 1.402 Aktueller Preis € 1.078','Einschließlich Steuern und Gebühren','Reservieren',
 'Nachhaltigkeit'].join('\n');
pruefeMobil('Echt: ohne Rabatt, Preis doppelt', mobilEcht,'Kleines Doppelzimmer','uebernachtung','nein','312','online_payment');
pruefeMobil('Echt: Mobile Rate in einer Zeile -> aktueller Preis', mobilEcht,'Kleines Doppelzimmer','egal','ja','281','mobile');
pruefeMobil('Echt: Mobile Rate mit Tausenderpunkt', mobilEcht,'Kleines Doppelzimmer mit Hofblick','fruehstueck','ja','1.078','mobile');
pruefeMobil('Echt: Namensanfang gleich, Zimmer nicht vermischt', mobilEcht,'Kleines Doppelzimmer mit Hofblick','egal','unsicher','1.078','mobile');
// egal/unsicher heisst "guenstigster" (24.09.2026): die Flexibel-Karte mit Mobile Rate (281)
// schlaegt die Preiswert-Karte darueber (312), obwohl sie weiter unten steht.
pruefeMobil('Echt: egal/unsicher -> guenstigste Karte', mobilEcht,'Kleines Doppelzimmer','egal','unsicher','281','mobile');
pruefeMobil('Echt: Storno "nein" bleibt Preiswert, auch wenn Flexibel billiger', mobilEcht,'Kleines Doppelzimmer','egal','nein','312','online_payment');
{
  const [amt] = findRoomPrice(mobil,'Doppelzimmer mit Balkon','egal','unsicher');
  const ok = amt === null || amt === undefined; if(!ok) fehler++;
  console.log((ok?'OK  ':'FEHL')+' | '+'Desktop-Parser auf Mobil-Seite -> null'.padEnd(44)+' Betrag '+String(amt));
}
// Bewertung der Smartphone-Zeile gegen das Desktop-Ergebnis
{
  const sum = { success: true, baselineUsedEuro: 1899, best: { country: 'PE', priceEuro: 1891.24 } };
  const a = mobilBewerten({ country: 'DE', priceEuro: 1709, currency: 'EUR', deals: ['mobile'] }, sum);
  const b = mobilBewerten({ country: 'DE', priceEuro: 100 }, sum);
  const c = mobilBewerten({ country: 'DE', priceEuro: 1899 }, sum);
  const d = mobilBewerten({ country: 'DE', priceEuro: null, priceRaw: 'kein Preis' }, sum);
  const faelle = [
    ['mobilBewerten: 1709 vs 1899 = 10 %, schlaegt Peru', a.savingsPct === 10 && a.relevant && a.beatsBestCountry && !a.implausible],
    ['mobilBewerten: 100 ist unplausibel', b.implausible && b.priceEuro === null && b.savingsPct === null],
    ['mobilBewerten: gleicher Preis = kein Fund', c.savingsPct === 0 && !c.relevant && !c.beatsBestCountry],
    ['mobilBewerten: kein Preis -> keine Bewertung, kein Fehler', d.priceEuro === null && !d.implausible && d.relevant === false],
    ['mobilBewerten: ohne Zeile -> null', mobilBewerten(null, sum) === null],
  ];
  for (const [n, ok] of faelle) { if(!ok) fehler++; console.log((ok?'OK  ':'FEHL')+' | '+n); }
}

console.log(fehler? '\n'+fehler+' FEHLER' : '\nalle Tests bestanden');
process.exit(fehler?1:0);
