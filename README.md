# georates-price-api

Serverless-Endpunkt fuer den GeoRates Geo-Preisvergleich: prueft den Preis eines konkreten
Booking.com-Zimmers ueber Proxy-Sessions aus mehreren Laendern (Smartproxy) und meldet zurueck,
ob ein Laenderwechsel (VPN) eine relevante Ersparnis bringt. Portiert die bereits gehaertete
Parsing-Logik aus dem lokalen `hotel_compare.py`-Skript.

## Ablauf pro Anfrage

1. Cloudflare-Turnstile-Token pruefen (Bot-Schutz).
2. Cache pruefen (Upstash Redis, 24h) - bei Treffer sofort Antwort ohne Proxy-Traffic.
3. Schnelle Probe: Deutschland + Kolumbien parallel.
4. Zeigt die Probe keine klare Ersparnis (>= 3%), werden weitere Laender NACHEINANDER
   geprueft (Bilder/Fonts/Stylesheets werden dabei geblockt, um Traffic zu sparen) - begrenzt
   durch ein Zeitbudget (45s), damit die Funktion nicht am Vercel-Zeitlimit scheitert. Wird das
   Budget aufgebraucht, kommt die Antwort mit den bis dahin geprueften Laendern plus
   `partial: true` zurueck.
5. Ergebnis wird gecacht (24h) und zurueckgegeben.

Wechselkurse werden bei jeder (nicht gecachten) Anfrage live abgerufen (open.er-api.com,
kostenlos, kein Key noetig) - faellt die Abfrage aus, springt ein statischer Notfall-Kurs ein.

## Benoetigte Umgebungsvariablen (Vercel -> Project -> Settings -> Environment Variables)

Zugangsdaten stehen bewusst NICHT im Code (dieses Repo ist oeffentlich):

- `SMARTPROXY_USER_PREFIX` - z. B. `smart-ut1nl7crifne_area-` (Laender-Code wird automatisch angehaengt)
- `SMARTPROXY_PASSWORD` - das Proxy-Passwort
- `SMARTPROXY_SERVER` - optional, Default `http://proxy.smartproxy.net:3120`
- `TURNSTILE_SECRET_KEY` - Cloudflare-Turnstile Secret Key (Bot-Schutz). Ohne diese Variable
  wird der Bot-Check uebersprungen - vor Live-Betrieb setzen, sonst kann jeder beliebig oft
  die kostenpflichtigen Proxy-Anfragen ausloesen.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` - optional, aber empfohlen (Cache).
  Ohne diese Variablen funktioniert alles, nur ohne Cache - jede Anfrage kostet dann volle
  Proxy-Zeit, auch bei identischen Wiederholungen.

## Deployment

1. Auf vercel.com mit GitHub-Account registrieren (kostenloser "Hobby"-Plan).
2. "Add New..." -> "Project" -> dieses Repo (`georates-price-api`) importieren.
3. Vor dem ersten Deploy die Umgebungsvariablen oben eintragen.
4. Deploy klicken. Die Funktion ist danach erreichbar unter
   `https://<projekt>.vercel.app/api/check-price`.

## Cloudflare Turnstile einrichten (kostenlos, Bot-Schutz)

1. dash.cloudflare.com -> kostenlos registrieren.
2. Turnstile -> "Add Site" -> Domain `georates.tech` eintragen, Widget-Typ "Managed".
3. Site Key (fuer die Website, Frontend) und Secret Key (fuer diese Funktion, als
   `TURNSTILE_SECRET_KEY` in Vercel) kopieren.

## Upstash Redis einrichten (kostenlos, Cache)

1. upstash.com -> kostenlos registrieren (GitHub-Login moeglich).
2. "Create Database" -> Name frei waehlbar, Region moeglichst nah an Vercel-Region waehlen.
3. Im Datenbank-Dashboard unter "REST API" die Werte `UPSTASH_REDIS_REST_URL` und
   `UPSTASH_REDIS_REST_TOKEN` kopieren, in Vercel eintragen.

## Bekannte Grenzen

- Die Erweiterung auf weitere Laender ist zeitbudgetiert (45s) - bei sehr langsamen
  Proxy-Antworten werden ggf. nicht alle 14 zusaetzlichen Laender erreicht, dann kommt
  `partial: true` in der Antwort zurueck statt eines vollstaendigen Scans.
- Booking.com kann Proxy-Traffic trotzdem blocken/CAPTCHA zeigen - dann liefert die Funktion
  fuer das betroffene Land keinen Preis, andere Laender koennen trotzdem erfolgreich sein.
- Ohne Upstash-Variablen läuft alles, aber ohne Cache (jede Anfrage verbraucht volle
  Proxy-Zeit/-Kosten, auch bei Wiederholungen derselben Suche).
