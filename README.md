# georates-price-api

Kostenloser Serverless-Endpunkt, der versucht, den Gesamtpreis einer Booking.com-Seite fuer
gegebene Reisedaten automatisch auszulesen (Headless-Chrome-Rendering). Wird von georates.tech
per fetch() aufgerufen. Schlaegt die automatische Pruefung fehl (Bot-Schutz, geaenderte
Seitenstruktur etc.), faellt die Website automatisch auf die manuelle Pruefung per E-Mail zurueck.

## Deployment (kostenlos, ca. 10 Minuten)

1. Auf vercel.com mit GitHub-Account registrieren (kostenloser "Hobby"-Plan reicht).
2. Neues GitHub-Repo anlegen, z. B. `georates-price-api` (wie bei georates: leeres Repo,
   dann diese drei Dateien ueber "Add file -> Upload files" hochladen: `package.json`,
   `vercel.json`, `api/check-price.js`).
3. In Vercel: "Add New..." -> "Project" -> das eben erstellte GitHub-Repo importieren.
   Framework Preset: "Other" lassen, Root Directory: `.` (Standard). Deploy klicken.
4. Nach dem Deploy zeigt Vercel eine URL wie `https://georates-price-api.vercel.app`.
   Die Funktion ist erreichbar unter `https://georates-price-api.vercel.app/api/check-price`.
5. Diese URL mir schicken, dann trage ich sie im Frontend (`index.html`, Konstante
   `PRICE_API_URL`) ein und deploye georates.tech neu.

## Bekannte Grenzen (bewusst so gebaut, kein Bug)

- Booking.com blockt Bot-Traffic teils komplett (Cloudflare-Schutz) - dann liefert die
  Funktion `{ success: false, reason: "blocked_or_timeout" }` zurueck, die Website faellt
  automatisch auf die manuelle E-Mail-Pruefung zurueck.
- Die Preis-Selektoren in `check-price.js` koennen brechen, wenn Booking.com sein Frontend
  aendert - gleiches Fallback-Verhalten.
- Vercels kostenloser Plan begrenzt die Ausfuehrungszeit pro Funktionsaufruf. Falls Deploys
  wegen `maxDuration` in `vercel.json` fehlschlagen, den Wert dort auf 10 senken.
- Der Endpunkt liest den allgemein auf der Seite angezeigten (meist guenstigsten) Preis fuer
  die uebergebenen Daten aus, prueft aber nicht automatisch, ob es exakt das vom Kunden
  gewuenschte Zimmer/die Verpflegung ist - das bleibt Teil der manuellen Endkontrolle.
