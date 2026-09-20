# georates-price-api

Serverless-Endpunkt hinter [georates.tech](https://georates.tech). Er prueft den Preis eines
konkreten Booking.com-Zimmers aus Sitzungen in mehreren Laendern und meldet zurueck, ob ein
Land denselben Aufenthalt guenstiger anzeigt.

Node mit `puppeteer-core` und headless Chromium. Aufbau:

| Datei | Aufgabe |
|---|---|
| `api/check-price.js` | Ablauf einer Anfrage (Modi `rooms` und Preis-Check, Streaming) |
| `api/best-of.js` | GET: groesste anonymisierte Funde fuer die Startseite |
| `api/result.js` | GET: gespeichertes Ergebnis per Kurz-ID (Permalink zum Teilen) |
| `api/daily-report.js` | Cron: Tagesbericht als Zeile in die Log-Tabelle, Warnung bei Einbruch |
| `lib/config.js` | Konstanten, Laenderlisten, Link-Funktionen |
| `lib/parser.js` | Seitentext -> Preis, Tarifstufen, Zimmerliste, Zusammenfassung |
| `lib/browser.js` | Chromium, Proxy, Seite laden, Preis je Land, Wechselkurse |
| `lib/store.js` | Upstash: Cache, Zaehlbremsen, Tagesdeckel, Best-of, Permalinks; Log-Webhook |
| `lib/http.js` | CORS, Client-IP, Turnstile, Debug-Freigabe |

Tests: `npm test` (Parser-Regression, Handler-Ablauf mit Browser-Stub, Leck-Check). Laufen
per GitHub Action bei jedem Push.

## Was der Endpunkt macht

Eine Anfrage liefert Hotel-Link, Zimmerkategorie, Verpflegung und Stornowunsch. Daraufhin:

1. Bot-Schutz pruefen (Cloudflare Turnstile) - auch fuer den Zimmer-Abruf.
2. Cache pruefen (Upstash Redis, 24 h). Der Schluessel wird aus dem BEREINIGTEN Link gebildet
   (ohne `sid`, `aid`, Sprache, Tracking), dieselbe Suche zweier Besucher ist also ein Treffer.
   Treffer heisst: sofort antworten, kein Proxy-Traffic.
2a. Zaehlbremse pro IP (Preis-Check 12/h, Zimmer 20/h) und Tagesdeckel (Suchen und MB) pruefen.
3. Ausgangsland und Kolumbien parallel abfragen, je zwei Versuche.
4. Die uebrigen Laender in Vierergruppen nachziehen. Es werden immer alle Laender geprueft –
   einen Abbruch bei fruehem Treffer gibt es bewusst nicht mehr, der hat die Statistik verzerrt.
5. Jedes fertige Land sofort als NDJSON-Zeile rausschreiben, damit die Tabelle im Browser
   waehrend des Laufs waechst statt am Ende auf einen Schlag zu erscheinen.

Geprueft werden 15 Laender: DE, CO, AR, EG, IN, VN, ID, PK, LK, PE, MX, PH, TH, US, JP, plus das
Land der Unterkunft, falls es nicht in der Liste steht. Der Nutzer kann die Liste mit `countries`
einschraenken (z. B. nur die Laender, in denen sein VPN Server hat); das Ausgangsland ist immer
dabei. Wechselkurse kommen live von open.er-api.com, Ersatzquelle ist die currency-api auf jsDelivr.

Ein Unterschied gilt ab 1 % als Fund. Musste der Bestpreis von uns umgerechnet werden (Booking
zeigte dort eine andere Waehrung als im Ausgangsland), erst ab 3 % - siehe OFFEN.md, Punkt 1.

## Zeitsteuerung

`maxDuration` steht auf 180 Sekunden, die interne Deadline auf 170. Nach jeder Gruppe wird
gemessen, wie lange sie gedauert hat; die naechste startet nur, wenn sie nach dieser Erfahrung
noch vor der Deadline fertig wird. Reicht die Zeit nicht, kommt die Antwort mit den bis dahin
geprueften Laendern und `partial: true` zurueck. Der Frontend-Timeout (190 s) muss immer ueber
`maxDuration` liegen.

## Zugangsdaten

Dieses Repo ist oeffentlich, Zugangsdaten stehen deshalb ausschliesslich in
Umgebungsvariablen und nie im Code:

| Variable | Zweck |
|---|---|
| `SMARTPROXY_USER_PREFIX`, `SMARTPROXY_PASSWORD`, `SMARTPROXY_SERVER` | Proxy-Zugang |
| `TURNSTILE_SECRET_KEY` | Bot-Check; ohne Key wird er uebersprungen |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Cache, Zaehlbremsen, Tagesdeckel, Best-of, Permalinks; ohne Upstash laeuft alles ohne |
| `LOG_WEBHOOK_URL`, `LOG_WEBHOOK_TOKEN` | Apps-Script-Webhook der Log-Tabelle |
| `TAGESBUDGET_SUCHEN` (Standard 300), `DAILY_MB_LIMIT` (Standard 4000) | Tagesdeckel in Suchen und Megabyte; 0 schaltet ab |
| `PRICE_RATE_LIMIT` (12), `ROOMS_RATE_LIMIT` (20) | Abrufe pro IP und Stunde |
| `DEBUG_SECRET` | Debug-Antworten und freie Geraetewahl nur mit Header `X-GeoRates-Debug: <Secret>`; ohne Variable ist Debug aus |
| `CRON_SECRET` | schuetzt `/api/daily-report`; Vercel setzt den Header beim Cron-Aufruf selbst |
| `BROWSER_SHARED` | `1` = ein Chromium fuer alle Laender (Kontext je Proxy) statt ein Start je Land; noch nicht live gemessen |
| `ALLOWED_ORIGIN` | CORS-Origin, Standard `https://georates.tech` |

**Hinweis zur Historie:** In fruehen Commits stand die Smartproxy-Benutzerkennung als Beispiel in
README und Code. Der Leck-Check faengt das heute ab, die Historie bleibt aber oeffentlich - der
Sub-User sollte deshalb bei Decodo neu angelegt und der alte geloescht werden.

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
