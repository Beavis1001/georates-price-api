# Offene Punkte

Stand: 20.09.2026. Reihenfolge = Wichtigkeit.

## 1. Alte Proxy-Kennung steht in der Git-Historie

**Nur der Betreiber kann das erledigen — es geht um Zugangsdaten.**

Im Commit `b98d564` (18.09.) wurde die echte Smartproxy-Sub-User-Kennung aus einem
Code-Kommentar entfernt, wo sie als Beispiel stand. Im aktuellen Stand findet der Leck-Check
sie nicht mehr, aber **jeder Commit davor liegt weiter oeffentlich auf GitHub**. Das Passwort
war nie dabei, die Kennung ist aber die halbe Zugangsinformation.

Richtige Reihenfolge:

1. Beim Proxy-Anbieter einen neuen Sub-User anlegen.
2. `SMARTPROXY_USER_PREFIX` und `SMARTPROXY_PASSWORD` in Vercel auf den neuen tauschen.
3. Pruefen, dass eine Suche noch laeuft.
4. Erst dann den alten Sub-User loeschen.

Danach ist die Kennung in der Historie wertlos. Ein History-Rewrite lohnt sich nicht: Er ist
aufwendig, und Forks, Caches und Mirrors erreicht er ohnehin nicht.

## 2. Eigene Waehrungsumrechnung erzeugt Scheinfunde (~2 %)

**Belegt am 19.09. am Three House Hotel, Funchal, 14.–21.12.2026.**

Booking rechnet ein Hotel in der Waehrung der Unterkunft aus und verkauft es in einer
fremden Laendersitzung in deren Waehrung — mit eigenem Kurs und Aufschlag. Wir lesen den
Fremdwaehrungsbetrag und rechnen ihn mit dem Marktkurs zurueck. Das ergibt einen zu
niedrigen Euro-Betrag und damit einen Vorteil, den es nicht gibt.

| | Deutschland | USA |
|---|---|---|
| Ursprungspreis | 1.292,06 € | US$ 1.480,96 |
| Genius-Rabatt | − 126,42 € | − US$ 144,90 |
| Gesamt | **1.165,64 €** | US$ 1.336,06 = **1.165,64 €** |

Auf den Cent identisch, also kein Laenderunterschied. Unser Tool hatte 2,2 % gemeldet
(1.292 € gegen 1.264 €). Die 28 € gab es nie. Im Log erklaert das den USA-Klumpen bei
2,2 / 2,2 / 2,2 / 2,3 %.

Zwei Reparaturen:

- **Richtig:** Bookings eigene Zeile „In der Waehrung der Unterkunft: € X" auslesen statt
  selbst umzurechnen. Ungeprueft ist, ob diese Zeile auch auf der Zimmerliste steht oder
  nur im Buchungsvorgang.
- **Schnell und sicher:** Musste fuer ein Land umgerechnet werden, gilt die 1-%-Schwelle
  nicht. Dann erst ab ca. 3 % als Fund melden.

Nicht betroffen sind Funde, bei denen Booking selbst Euro ausgewiesen hat — z. B. Emanuel
Derag Muenchen (477,40 € gegen 423,86 € ueber Japan, per VPN bis in die Buchungsmaske
geprueft) und Le Nid Douillet (9,1 %).

## 3. Tarifzeilen einer Zimmerkarte werden nicht gefunden

**Ruby Lilly Muenchen, Zimmer „Rubys Choice – Zimmer mit Upgrade", 26.–27.09.2026.**

Das Zimmer hat zwei Tarife (539 € ohne, 583 € mit Fruehstueck, beide kostenlos
stornierbar), der Parser findet keinen davon. Ursache liegt nicht im Link.

Beim Vergleich zweier Seitenabrufe: Die Ueberschrift der Karte stand einmal 42 Zeilen
hinter der Karte eines anderen Zimmers, beim zweiten Abruf gar nicht im 160-Zeilen-Fenster.
Die Position im ausgelesenen Text ist also nicht stabil. Die Grundannahme des Parsers
— Ueberschrift, darunter die Tarifzeilen, bis zur naechsten Ueberschrift — bricht hier.

Naechster Schritt: einmal den vollstaendigen Seitentext dieses Hotels dumpen und nachsehen,
wo die Zeilen dieser Karte wirklich liegen. Dafuer waere ein `debugRoom`-Parameter
hilfreich, der den Ausschnitt an einem gewaehlten Zimmer verankert statt an rooms[0].

Die Fehlermeldung nennt seit dem 19.09. keinen erfundenen Grund mehr, der Fehler selbst
ist offen.

## 4. Relevanzschwelle pro Land

Auswertung ueber 110 Eintraege — alle vor dem 19.09. und damit nur Siegerlaender. Ab jetzt
steht in Spalte Q jede Suche vollstaendig, die Tabelle laesst sich also bald neu rechnen:

| Land | Siege | kleinster | Median | groesster |
|---|---|---|---|---|
| Japan | 30 | 0 % | 3,9 % | 29,9 % |
| Aegypten | 17 | 0,1 % | 0,1 % | 6,5 % |
| USA | 14 | 0 % | 3,3 % | 15,2 % |
| Indien | 10 | 3,7 % | 11,0 % | 19,3 % |
| Peru | 8 | 0,1 % | 0,1 % | 0,5 % |
| Kolumbien | 6 | 11,0 % | 11,0 % | 11,1 % |

Peru gewinnt achtmal und liegt nie ueber 0,5 % — reines Rauschen. Aegypten fast genauso.
Indien gewinnt nur, wenn es substanziell ist (kleinster Wert 3,7 %). Eine feste
1-%-Schwelle fuer alle Laender passt dazu nicht.

## 5. Proxy-Abdeckung des dynamischen Landes ungeprueft

Seit dem 19.09. laeuft zusaetzlich eine Sitzung im Land der Unterkunft (siehe Geklaert).
Ungeprueft ist, fuer welche dieser Laender Smartproxy ueberhaupt Ausgangs-IPs hat. Fehlt eines,
liefert die Abfrage schlicht keinen Preis - die Suche bleibt gueltig, kostet aber einen
Versuch. Ablesbar wird das an Spalte Q: Steht dort das Hotelland mit `-`, obwohl andere
Laender Preise haben, fehlt vermutlich der Proxy.

Nach ein paar Tagen auszaehlen, welche Laender systematisch leer bleiben, und die entweder aus
DEFAULT_CURRENCY_BY_COUNTRY streichen oder aufs Mutterland umbiegen.

## 6. Waehrungshinweis in der Ergebnisanzeige

Booking bietet an, in der Waehrung der Landessitzung abzurechnen. Gemessen am 18.09.:
423,86 € gegen 77.720 JPY, letzteres zum Tageskurs rund sieben Euro teurer. Das frisst
einen Teil des gefundenen Vorteils, bevor die Bank ueberhaupt eine Fremdwaehrungsgebuehr
berechnet.

In der Ergebnisanzeige steht bisher nur „Karte ohne Fremdwaehrungsgebuehr" — das zielt auf
die Bankgebuehr, nicht auf Bookings Umrechnung. Ergaenzen: immer in der Waehrung der
Unterkunft zahlen, nie in der angebotenen.

## 7. „Best of" auf der Startseite

Groesste Ersparnisse der letzten Suchen zeigen. Bedingungen:

- Nur Messungen ab dem 18.09.2026 — davor verzerren Kolumbien-Abbruch, falsche Tarifzeile
  und Genius die Zahlen.
- Ohne Datum und ohne vollstaendigen Link. Hotelname, Land, Ersparnis in % und € reichen;
  Hotel plus exakter Reisezeitraum ist eine Kombination, auf die selten mehr als eine
  Person passt.
- Die Datenschutzerklaerung nennt als Zweck bisher nur Verbesserung und Auswertung.
  Veroeffentlichung ist ein weiterer Zweck und gehoert dort benannt.

## 8. Mobiler Parser

`MOBILE_READY = false`. Geraeteprofile fuer Android und iPhone sind vorhanden, das mobile
Layout versteht der Parser aber nicht. Mobile Anfragen fallen auf Windows zurueck.

## 9. Referrer-Experiment

Anregung von krabbs (Travel-Dealz): Zieht eine Weiterleitung von trivago oder Miles & More
eine andere Rate als der Direkteinstieg? Waere mit dem vorhandenen Aufbau messbar, weil der
Referrer gesetzt werden kann. Relevant, bevor jemals ein Affiliate-Link dazukommt — der
wuerde sonst die eigenen Messungen verzerren.

---

## Geklaert, nicht mehr offen

- **Genius-Rabatt ist in allen Laendersitzungen gleich hoch** (Three House, 19.09.:
  −144,90 USD entsprechen exakt −126,42 EUR). Ausgeloggte Messungen bleiben also
  aussagekraeftig, obwohl man zum Buchen eingeloggt sein muss.
- **Genius wird auch ausgeloggt von der Gesamtsumme abgezogen** (17.09.). Wird seit dem
  18.09. herausgerechnet.
- **Fremdsprachige Links** werden vor dem Abruf auf Deutsch gezwungen (18.09.).
- **Kolumbien-Abbruch** ersatzlos entfernt; er hatte die eigene Statistik erzeugt.
- **Externe Badges entfernt** (20.09.). OpenHunts, Fazier und Uneed wurden als Bilder
  eingebunden und uebertrugen bei JEDEM Seitenaufruf die Besucher-IP an drei fremde Server -
  im Widerspruch zu Abschnitt 6 der Datenschutzerklaerung. Jetzt Textlinks: Es geht erst etwas
  raus, wenn jemand klickt. Die "Preis anfragen"-Passage in der Datenschutzerklaerung beschrieb
  eine Mailto-Funktion, die es nie gab (der Knopf springt zum Formular) - in allen sechs
  Sprachen korrigiert.
- **Kostendeckel** (20.09.). Turnstile hielt Skripte ab, begrenzte aber nichts. Jetzt zwoelf
  Suchen pro IP und Stunde plus ein globaler Tagesdeckel (`TAGESBUDGET_SUCHEN`, Standard 300),
  gezaehlt erst kurz bevor Proxies anlaufen - Cache-Treffer kosten nichts und zaehlen nicht mit.
- **Cache-Schluessel bereinigt** (20.09.). Er entstand aus dem ROHEN Link. Booking haengt sid,
  aid und label pro Sitzung neu an, also war dieselbe Suche zweier Besucher nie derselbe
  Schluessel - jedes Mal 30 MB fuer eine Antwort, die schon dalag. Jetzt wird vor dem Hashen
  bereinigt und die Sprachfassung normalisiert.
- **Debug-Schalter gesperrt** (20.09.). `debug`, `debugLines`, `noScripts` und die freie
  Geraetewahl konnte jeder im Body setzen. Jetzt nur noch mit Header `x-georates-debug`, der zu
  `DEBUG_SECRET` passt; ohne gesetztes Secret sind sie ganz aus.
- **Das Land der Unterkunft wird mitgeprueft** (19.09.). Die feste Liste war eine weltweite
  Stichprobe und passte sich dem Hotel nie an: Fuer ein Hotel auf Réunion verglich sie die
  deutsche Sitzung gegen dreizehn aussereuropaeische - und gegen keine andere europaeische.
  Dabei lag dort der Befund: DE 125 EUR, alle dreizehn anderen 130,64 bis 131,25. Jetzt kommt
  pro Suche das Hotelland dazu (Spalte R), Uebersee-Gebiete ueber ihr Mutterland (RE → FR).
  Steht es schon in der Liste, kostet es nichts.
- **Das Log speichert alle geprueften Laender** (19.09.), nicht mehr nur das Siegerland.
  Spalte Q "Alle Laender", Format `DE:1292.06:EUR|JP:1264:JPY|US:-:USD` — feste Reihenfolge,
  `-` fuer "kein Preis". Kostet keinen zusaetzlichen Traffic, die Zahlen lagen ohnehin vor.
  Damit werden Punkt 1 und Punkt 3 aus Daten beantwortbar statt aus Einzelfaellen: an der
  Waehrung ist ablesbar, welche Werte wir selbst umgerechnet haben.
