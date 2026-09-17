# georates-price-api

Serverless-Endpunkt hinter [georates.tech](https://georates.tech). Er prueft den Preis eines
konkreten Booking.com-Zimmers aus Sitzungen in mehreren Laendern und meldet zurueck, ob ein
Land denselben Aufenthalt guenstiger anzeigt.

Node mit `puppeteer-core` und headless Chromium, ein einziger Handler in `api/check-price.js`.

## Was der Endpunkt macht

Eine Anfrage liefert Hotel-Link, Zimmerkategorie, Verpflegung und Stornowunsch. Daraufhin:

1. Bot-Schutz pruefen (Cloudflare Turnstile).
2. Cache pruefen (Upstash Redis, 24 h). Treffer heisst: sofort antworten, kein Proxy-Traffic.
3. Ausgangsland und Kolumbien parallel abfragen, je zwei Versuche.
4. Die uebrigen Laender in Vierergruppen nachziehen. Es werden immer alle Laender geprueft –
   einen Abbruch bei fruehem Treffer gibt es bewusst nicht mehr, der hat die Statistik verzerrt.
5. Jedes fertige Land sofort als NDJSON-Zeile rausschreiben, damit die Tabelle im Browser
   waehrend des Laufs waechst statt am Ende auf einen Schlag zu erscheinen.

Geprueft werden 15 Laender: DE, CO, AR, EG, IN, VN, ID, PK, LK, PE, MX, PH, TH, US, JP.
Wechselkurse kommen live von open.er-api.com, bei Ausfall greift ein statischer Notfallkurs.

## Zeitsteuerung

`maxDuration` steht auf 180 Sekunden, die interne Deadline auf 170. Nach jeder Gruppe wird
gemessen, wie lange sie gedauert hat; die naechste startet nur, wenn sie nach dieser Erfahrung
noch vor der Deadline fertig wird. Reicht die Zeit nicht, kommt die Antwort mit den bis dahin
geprueften Laendern und `partial: true` zurueck. Der Frontend-Timeout (190 s) muss immer ueber
`maxDuration` liegen.

## Zugangsdaten

Dieses Repo ist oeffentlich, Zugangsdaten stehen deshalb ausschliesslich in
Umgebungsvariablen und nie im Code:

`SMARTPROXY_USER_PREFIX`, `SMARTPROXY_PASSWORD`, `SMARTPROXY_SERVER`,
`TURNSTILE_SECRET_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

Ohne Turnstile-Key wird der Bot-Check uebersprungen, ohne Upstash laeuft alles ohne Cache.

## Logging

Jede Abfrage wird in einer Tabelle protokolliert: Zeitpunkt, Hotel-Link, Zimmer, Verpflegung,
Stornowunsch, ermittelte Preise und das aus der IP abgeleitete Herkunftsland als Laenderkuerzel.
Die IP selbst wird nicht gespeichert. Aus dem Hotel-Link werden vor dem Schreiben Session-ID
und saemtliche Tracking-Parameter entfernt (`aid`, `label`, `sid`, `srpvid`, UTM, gclid und
weitere); Hotel und Reisezeitraum bleiben stehen, weil sich ein Fund sonst nicht nachvollziehen
laesst. Details in der [Datenschutzerklaerung](https://georates.tech/datenschutz.html).

## Bekannte Grenzen

- Abgefragt wird ausgeloggt. Genius-Rabatte sind nicht enthalten, fuer Statusinhaber ist die
  ausgewiesene Ersparnis eher eine Obergrenze.
- Booking.com kann Proxy-Traffic blocken oder ein CAPTCHA zeigen. Betroffene Laender liefern
  dann keinen Preis, die uebrigen koennen trotzdem durchlaufen.
- Ein gekuerzter Lauf (`partial: true`) bedeutet nicht "kein guenstigeres Land gefunden",
  sondern nur "nicht alle Laender geprueft".
- Geraeteprofile fuer Windows, Mac, Android und iPhone sind vorhanden, Mobil ist aber
  abgeschaltet: Booking liefert mobil ein anderes Layout, das der Parser noch nicht versteht.
  Mobile Anfragen fallen auf das Windows-Profil zurueck.
- Eine Einzelmessung ist eine Momentaufnahme. Derselbe Vergleich kann morgen anders ausgehen.
