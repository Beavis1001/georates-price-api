# CLAUDE.md – georates-price-api

> **ENTWURF (21.09.2026)** aus einer Session ohne Live-Zugang zu Vercel, Proxy und Booking. Christophers
> Claude-Session: bitte jede Aussage gegen den Code pruefen, Fehlendes ergaenzen (vor allem alles, was nur
> der Betreiber weiss: Deploy-Ablauf, Vercel-Einstellungen, Umgang mit dem Proxy-Account, Auswertung der
> Log-Tabelle), Falsches streichen - und danach diesen Kasten entfernen.

Arbeitsregeln fuer Claude-Code-Sessions in diesem Repo. Wird bei jedem Sessionstart gelesen.
Historie und offene Punkte stehen NICHT hier, sondern in `OFFEN.md` und den Commit-Nachrichten.

## Was das ist

Serverless-Endpunkt hinter georates.tech (Vercel, Node 20, `puppeteer-core` + headless Chromium).
Liest den Preis eines Booking.com-Zimmers ueber Proxy-Sitzungen aus 15 Laendern plus dem Land der
Unterkunft und meldet, ob ein Land guenstiger ist. Betreiber: Christopher (GitHub Beavis1001).

| Datei | Aufgabe |
|---|---|
| `api/check-price.js` | Ablauf einer Anfrage: Modus `rooms` (Zimmerliste) und Preis-Check, NDJSON-Streaming |
| `api/best-of.js`, `api/result.js`, `api/daily-report.js` | Anonymisierte Funde, Ergebnis-Permalink, Tagesbericht (Cron) |
| `lib/config.js` | Konstanten, Laenderlisten, Schwellen, Link-Funktionen |
| `lib/parser.js` | Seitentext -> Preis, Tarifstufen, Zimmerliste, `summarize` |
| `lib/browser.js` | Chromium, Proxy, Geraeteprofile, Seite laden, Wechselkurse |
| `lib/store.js` | Upstash: Cache, Zaehlbremsen, Tagesdeckel, Best-of, Permalinks; Log-Webhook |
| `lib/http.js` | CORS, Client-IP, Turnstile, Debug-Freigabe |
| `google-sheet-log.gs` | Apps Script der Log-Tabelle (Spalten A–R) |

## Befehle

```bash
npm ci
npm test                    # Parser-Regression, Handler-Ablauf (Browser-Stub), Leck-Check
node test/leck-check.js     # allein, vor JEDEM Push
```

Alle drei laufen auch als GitHub Action. Rot = nicht mergen. Es gibt keine lokale Moeglichkeit,
den Endpunkt gegen Booking zu testen; dafuer braucht es Vercel und den Proxy-Account.

## Regeln, die nicht verhandelbar sind

1. **Keine echten Suchen im Repo.** Beispiel-Links, Hotelnamen, Reisedaten in Code, Tests und
   Kommentaren werden erfunden, nie aus dem Log kopiert. Am 17.09.2026 hat ein Besucher seine
   eigene Suche im Quelltext wiedererkannt. Der Leck-Check findet Booking-Links, Tracking-Parameter,
   Reisedaten und Token-Muster; eine bewusste Ausnahme braucht `// leck-check-ok: <Begruendung>` in
   derselben Zeile. Gilt auch fuer `OFFEN.md`, README und Commit-Nachrichten: Ein Befund wird als
   "ein Hotel in Muenchen, eine Nacht Ende September" notiert, Hotelname plus genauer Reisezeitraum
   steht nur im Log. Am 21.09.2026 standen drei solche Suchen in `OFFEN.md`.
2. **Keine Zugangsdaten im Code**, auch nicht als Beispiel. Alles ueber Vercel-Umgebungsvariablen
   (Tabelle im README). Das Repo ist oeffentlich, die Historie auch.
3. **Keine Live-Abrufe gegen Booking aus einer Session** ohne ausdruckliche Freigabe des Betreibers.
   Jede Suche kostet rund 30 MB bezahlten Residential-Traffic. Zum Pruefen den Handler-Test mit
   Browser-Stub erweitern, nicht den Endpunkt aufrufen.
4. **`CACHE_VERSION` in `lib/store.js` hochzaehlen**, wenn sich aendert, WAS gemessen wird
   (Schwelle, Genius-Behandlung, Laenderliste, Parser-Auswahl). Nicht bei reinen Fehlerkorrekturen.
   Sonst liefert der Cache 24 Stunden alte Ergebnisse und man sucht den Fehler im neuen Code.
5. **Frontend und API gehoeren zusammen.** Aenderungen an Request-Feldern (`countries`,
   `turnstileToken`, `userPrice`, `mode`), Antwortgruenden (`reason`) oder der Stream-Struktur
   (`meta`, `country`, `update`, `summary`) brauchen den passenden Commit im Repo `georates`. Neue `reason`-Werte
   brauchen dort einen Schluessel `err_<reason>` in allen sechs Sprachen.
6. **Parser ist deutschsprachig.** Er sucht nach "Steuern und Gebuehren", "Kostenlose Stornierung",
   "Fruehstueck". Deshalb zwingt `normalisiereLinkFuerAbruf` jeden Link auf `.de.html` + `lang=de`,
   aber erst NACH `detectBaselineCountry` (die Sprachendung des Originals ist die einzige Information
   ueber das Herkunftsland). Diese Reihenfolge nicht vertauschen.
7. **Tests bleiben ohne Netz und ohne Chromium.** `test/handler-test.js` ersetzt `lib/browser` per
   `require.cache`; neue Ablaufregeln dort pruefen.

## Fachliche Entscheidungen, die man kennen muss

- **Genius wird NICHT herausgerechnet** (seit 20.09.2026). Level 1 hat jedes kostenlose Konto, und das
  Herausrechnen erzeugte Scheinfunde, wenn Sitzungen den Rabatt unterschiedlich ausweisen. Der erkannte
  Betrag bleibt als `geniusRabatt` im Ergebnis. Nicht wieder einfuehren ohne neue Messung.
  Betreiber-Entscheidung (24.09.2026): Buchen geht bei Booking nur mit Konto, also bekommt jeder
  Bucher Genius; der Preis mit Genius ist der, den er wirklich zahlt. Die Startseite sagt das so.
- **Permalinks und Best-of sind oeffentlich.** Die Startseite verlinkt beide. Dort darf nichts stehen,
  was eine Suche wiedererkennbar macht: kein Booking-Link, keine Reisedaten, keine sid/aid/label.
  `store.ohneLinks` entfernt Adressfelder (`finalUrl` u. a.) beim Speichern und beim Lesen eines
  Permalinks. Bis zum 24.09.2026 stand `finalUrl` jeder Laenderzeile oeffentlich im Permalink. Neue
  Felder mit Adressen in `LINK_FELDER` eintragen.
- **Schwellen:** Unterschied ab 1 % = Fund, ab 10 % = VPN-Empfehlung. Musste der Bestpreis von uns
  umgerechnet werden (andere Waehrung als das Ausgangsland), gilt 3 % statt 1 %, weil Booking mit
  eigenem Kurs verkauft (`RELEVANT_SAVINGS_PCT_CONVERTED`).
- **Es werden immer alle Laender geprueft.** Der fruehe Abbruch bei "Kolumbien 10 % guenstiger" wurde
  entfernt, er hat die eigene Statistik verzerrt. Einzige Ausnahme: Zimmer steht gar nicht auf der Seite.
- **Ein nacktes `$` ist nie USD** (`CURRENCY_SYMBOLS`). Argentinien, Mexiko, Kolumbien schreiben ihre
  Waehrung so; die Gleichsetzung hat einmal ein Zimmer fuer 2,4 Mio. EUR erzeugt.
- **Mobilprofile sind aus** (`MOBILE_READY = false`). Der Parser versteht das mobile Layout nicht und
  wuerde plausible, aber falsche Preise liefern.
- **Kostenschutz in dieser Reihenfolge:** Turnstile (entfaellt mit gueltigem Debug-Header) ->
  Eingabepruefung -> Cache -> Zaehlbremse pro IP -> Tagesdeckel (Suchen und MB) -> Proxy. Cache-Treffer
  kosten nichts und zaehlen nicht.
- **Upstash-Variablen** heissen je nach Anlageweg `KV_REST_API_*` (Vercel Marketplace) oder
  `UPSTASH_REDIS_REST_*` (von Hand). Beide werden akzeptiert. Fehlen beide, laufen Cache, Bremsen und
  Best-of stumm ins Leere; genau das ist vom 16. bis 20.09.2026 passiert. Der Tagesbericht warnt jetzt.
- **Debug** (`debug`, `debugRoom`, `debugLines`, `noScripts`, Geraetewahl) nur mit Header
  `X-GeoRates-Debug: <DEBUG_SECRET>`. Ohne gesetztes Secret ist alles aus. Mit gueltigem
  Debug-Header entfaellt Turnstile (Zaehlbremse und Tagesdeckel bleiben).
- **Preisstreuung** (seit 21.09.2026): Booking teilt Preise pro Sitzung zu (Mobile Rate,
  Online-Zahlungsrabatt, Kurzfristig-Deal, Genius). Gegenmittel: Ausgangsland `BASELINE_SAMPLES`-mal
  parallel (Standard 2), zusammengefuehrt auf den NIEDRIGEREN Preis (`samples`, `spreadPct`);
  Fund ueber der Schwelle einmal bestaetigen (`CONFIRM_FINDS`), Siegerland auf den HOEHEREN Preis,
  Ergebnis in `confirmation.stable`; jede Stufe traegt `deals` (`DEAL_MUSTER` in lib/parser.js);
  optionaler `userPrice` als konservative Referenz (`baselineUsedEuro`). Aktualisierte Zeilen gehen
  als Stream-Typ `update`. Nicht stabile Funde landen nicht im Best-of. `STRIP_PARTNER_PARAMS=1`
  entfernt aid/label auch beim Abruf (Experiment). Sechs Abrufe je Land waren bewusst NICHT der Weg.
- **Smartphone-Preis** (Experiment `MOBILE_CHECK=1`, Standard aus, seit 21.09.2026): Booking zeigt
  Mobilgeraeten eigene Tarife ("Preis nur fuer Mobilgeraetnutzer"); beobachtet 1.709 statt 1.899 EUR,
  also 10 % unter ALLEN 16 Laendern, ohne VPN. Mit dem Flag laeuft das Ausgangsland einmal
  zusaetzlich mit `MOBILE_DEVICE` (android), geparst von `findRoomPriceMobile` (anderer Anker:
  "Preis fuer N Naechte:", letzte Betragszeile ist der Preis), bewertet von `mobilBewerten`
  (verwirft alles ausserhalb 50-105 % des Desktop-Preises), einmal bestaetigt wie ein Landesfund,
  Stream-Typ `mobile`, `summary.mobile`. Die Zeile steht NICHT in `results`: Laender gegen Laender,
  Geraet gegen Geraet. Der Mobil-Parser ist aus einem Screenshot abgeleitet und muss vor dem
  Einschalten mit einem Debug-Abruf (`device: 'android'`, `debugLines`) gegen die echte Seite
  geprueft werden; `MOBILE_READY` in lib/browser.js bleibt davon unberuehrt false.

## Stil

- Kommentare erklaeren das WARUM mit Datum und Anlass ("am 17.09. ist X passiert, deshalb ..."). Der
  Code ist die einzige Dokumentation der Booking-Eigenheiten, also lieber ein Absatz zu viel.
- Deutsch, im Code ohne Umlaute (ae, oe, ue, ss); in Texten fuer Nutzer mit Umlauten.
- Commit-Nachrichten: erste Zeile was, danach warum und was den Anlass gab. Keine Modellnamen in
  Commits, Kommentaren oder Doku.
- `OFFEN.md` ist die einzige Liste offener Punkte, nach Wichtigkeit sortiert, Erledigtes wandert nach
  "Geklaert" mit Datum. Wer einen Punkt erledigt, traegt es dort ein.

## Diese Datei pflegen

Wenn du in einer Session etwas gelernt hast, das einer neuen Session Zeit gespart oder einen Fehler
verhindert haette (eine Booking-Eigenheit, eine Vercel-Falle, eine Regel, die du verletzt hast),
ergaenze es hier im selben Commit. Kurz, mit dem Warum. Keine Chronik, keine Erledigt-Listen; dafuer
gibt es `OFFEN.md`. Streiche, was nicht mehr stimmt.
