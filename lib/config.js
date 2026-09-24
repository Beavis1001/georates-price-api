// Konfiguration und Laenderlogik von GeoRates: alle Konstanten, die WAS gemessen wird bestimmen,
// plus die reinen Link-Funktionen (Ausgangsland, Hotelland, Normalisierung, Log-Bereinigung).

// ---- Konfiguration -----------------------------------------------------------------------

// Alle Laender, ueber die wir per Proxy einen Preis abfragen koennen. Reihenfolge = Prioritaet
// bei der Erweiterung: erfahrungsgemaess guenstige Laender (schwache Waehrung/hohe Inflation)
// zuerst, damit ein evtl. durch das Zeitlimit gekuerztes Ergebnis trotzdem die relevanten
// Kandidaten enthaelt. Teure Maerkte (USA, Japan) ganz am Ende.
// Hinweis: Tuerkei (TR) bewusst NICHT enthalten - von dort sind aktuell keine internationalen
// Buchungen moeglich, daher waere eine Abfrage nur verschwendeter Proxy-Traffic.
const ALL_COUNTRIES = ['DE', 'CO', 'AR', 'EG', 'IN', 'VN', 'ID', 'PK', 'LK', 'PE', 'MX', 'PH', 'TH', 'US', 'JP'];
// "Guenstig-Kandidat" fuer die schnelle Probe (neben dem Ausgangsland).
const CHEAP_PROBE_COUNTRY = 'CO';
// Ausgangsland (Referenzpreis), falls es sich nicht aus dem Link ableiten laesst.
const DEFAULT_BASELINE_COUNTRY = 'DE';
// Ab dieser Ersparnis empfehlen wir aktiv einen Laenderwechsel per VPN.
const PROBE_CONFIDENCE_THRESHOLD_PCT = 10.0;
// Unterhalb dieser Schwelle ist ein Preisunterschied blosses Rauschen (Wechselkurs-Rundung,
// Nachkommastellen). Solche Treffer werden NICHT als "guenstigeres Land" verkauft - weder im
// Ergebnis noch im Deal-Log. Sonst wirkt das Tool, als wolle es um jeden Preis etwas finden.
const RELEVANT_SAVINGS_PCT = 1.0;
// Musste der Preis eines Landes von UNS umgerechnet werden (Booking zeigte dort eine andere
// Waehrung als im Ausgangsland), gilt eine hoehere Schwelle. Grund: Booking verkauft in einer
// fremden Sitzung mit eigenem Kurs und Aufschlag; die Rueckrechnung zum Marktkurs erzeugt dann
// einen Vorteil von rund 2 %, den es nie gab (OFFEN.md, Punkt 1: Three House Hotel, 19.09.2026,
// auf den Cent identisch, Tool meldete 2,2 %). Ab 3 % ist ein Unterschied auch mit Kursaufschlag
// noch echt.
const RELEVANT_SAVINGS_PCT_CONVERTED = 3.0;
// Eingabegrenzen: ein Booking-Link ist selten laenger als 1.000 Zeichen, ein Zimmername nie
// laenger als ROOM_NAME_MAX_LEN. Alles darueber ist kein Nutzer, sondern ein Skript.
const MAX_LINK_LEN = 2048;
const MAX_ROOM_LEN = 200;
// Optionaler Preis, den der Nutzer selbst sieht (Euro). Obergrenze nur als Plausibilitaetsbremse.
const MAX_USER_PRICE_EUR = 1000000;
// Preisstreuung: Booking teilt Preise pro Sitzung zu (A/B-Experimente, Mobile Rate, Zahlungsart-
// Rabatte). Gegenmittel, beide per Env-Var abschaltbar:
//  - Das Ausgangsland wird ZWEIMAL parallel abgerufen, gerechnet wird gegen den niedrigeren Preis.
//    Kostet eine Seite (~2 MB von ~30). Die Ersparnis ist so im Zweifel unter-, nie ueberschaetzt.
//  - Ein Fund ueber der Schwelle wird EINMAL bestaetigt: Siegerland und Ausgangsland noch einmal.
//    Bleibt der Vorsprung, ist es ein Fund; verschwindet er, war es ein Los ("nicht stabil").
const BASELINE_SAMPLES = process.env.BASELINE_SAMPLES !== undefined ? Math.max(1, Number(process.env.BASELINE_SAMPLES) || 1) : 2;
const CONFIRM_FINDS = process.env.CONFIRM_FINDS !== '0';
// Smartphone-Preis (Experiment, seit 21.09.2026, Standard AUS): Booking zeigt Mobilgeraeten eigene
// Tarife ("Preis nur fuer Mobilgeraetnutzer"). Beobachtet am 21.09.: 1.709 statt 1.899 EUR, also
// 10 % unter dem Desktop-Preis ALLER 16 Laender - ohne VPN. Mit MOBILE_CHECK=1 wird das
// Ausgangsland zusaetzlich einmal mit Smartphone-Profil abgerufen (eine Seite mehr, ~2 MB) und
// als eigene Zeile neben den Laendern ausgewertet (lib/parser.js: findRoomPriceMobile,
// mobilBewerten). Der Mobil-Parser ist aus einem Screenshot abgeleitet und gegen die echte Seite
// noch nicht geprueft - deshalb aus, bis der Betreiber ihn mit device=android im Debug validiert hat.
const MOBILE_CHECK = process.env.MOBILE_CHECK === '1';
const MOBILE_DEVICE = (process.env.MOBILE_DEVICE || 'android').toLowerCase();
const BOARD_VALUES = ['uebernachtung', 'fruehstueck', 'halbpension', 'vollpension', 'allinclusive', 'egal', ''];
const CANCEL_VALUES = ['ja', 'nein', 'teilweise', 'unsicher', ''];
// Ausgangsland + Kolumbien: 2 Versuche (der Referenzpreis MUSS verlaesslich sein).
// Die zusaetzlichen Laender bekommen nur 1 Versuch (Tempo; ein verpasstes Land ist unkritisch).
const MAX_ATTEMPTS = 2;
const EXPANSION_ATTEMPTS = 1;
// Wie viele Laender in der Erweiterungsphase gleichzeitig geprueft werden. Seit der Umstellung
// auf 2 GB (vercel.json) ist genug Arbeitsspeicher fuer mehrere Chromium-Instanzen da; das
// halbiert die Laufzeit eines vollstaendigen Scans. Hoeher als 4 bringt wenig: der Hobby-Plan
// hat nur 1 vCPU, ab da warten die Instanzen nur noch aufeinander.
const EXPANSION_BATCH_SIZE = 4;
const MIN_LOADED_LINES = 300;
// Obergrenze fuer die Laenge eines Zimmernamens. Das ist eine Plausibilitaetsbremse gegen
// versehentlich mitgelesene Textabsaetze - KEIN inhaltliches Kriterium. Frueher standen hier
// 55 bis 70 Zeichen, und das hat echte Zimmer verschluckt: Booking haengt Unterscheidungen
// hinten an ("... - kleinere Villa"), und solche Namen kommen leicht auf ueber 70 Zeichen.
// Ausgerechnet die guenstigste Kategorie eines Hotels fiel dadurch aus der Auswahl.
const ROOM_NAME_MAX_LEN = 140;
// Zeitsteuerung der Erweiterungsphase: vorausschauend statt mit starrem Budget. Wir messen,
// wie lange die letzte Gruppe wirklich gedauert hat, und starten die naechste nur, wenn sie
// nach dieser Erfahrung noch vor HARD_DEADLINE_MS fertig wird. Das nutzt das Zeitfenster
// besser aus als eine feste Schranke und kann das Limit nicht ueberfahren.
//
// Mit Vercel "Fluid Compute" (im Projekt aktiv) erlaubt auch der kostenlose Hobby-Plan bis zu
// 300s pro Funktion. Wir nehmen NICHT das Maximum: 15 Laender brauchen erfahrungsgemaess
// ~100-120s, und jede Sekunde Laufzeit ist bezahlter Proxy-Traffic. 180s lassen genug Luft,
// begrenzen aber einen entgleisten Lauf.
// WICHTIG: Dieser Wert muss zu maxDuration in vercel.json passen.
const FUNCTION_LIMIT_MS = 180000;         // Vercel-Limit (siehe vercel.json)
const RESPONSE_RESERVE_MS = 10000;        // Puffer fuer Zusammenfassung, Cache-Write, Logging, Antwort
const HARD_DEADLINE_MS = FUNCTION_LIMIT_MS - RESPONSE_RESERVE_MS;
// Schaetzung fuer die erste Gruppe (noch kein Messwert vorhanden) - bewusst pessimistisch.
const FIRST_BATCH_ESTIMATE_MS = 14000;
// Sicherheitsaufschlag auf die gemessene Gruppendauer: die naechste Gruppe kann langsamer sein.
const BATCH_ESTIMATE_SAFETY = 1.25;
const CACHE_TTL_SECONDS = 24 * 3600;

// Landeswaehrung als RUECKFALL - die Waehrung wird zuerst aus der Preiszeile der Seite gelesen.
// Gebraucht wird der Eintrag vor allem bei mehrdeutigen Zeichen: Ein nacktes "$" steht in
// Argentinien, Mexiko, Chile und Kolumbien fuer die Landeswaehrung, nicht fuer US-Dollar.
//
// Die Tabelle geht ueber die 15 festen Laender hinaus, seit es den dynamischen Platz fuer das
// Land der Unterkunft gibt (siehe laenderFuerDieseSuche). Sie ist zugleich die Freigabeliste:
// Nur fuer ein Land, dessen Waehrung wir kennen, starten wir eine zusaetzliche Sitzung. Lieber
// ein Land weniger pruefen als einen Betrag in einer geratenen Waehrung in die Tabelle schreiben.
const DEFAULT_CURRENCY_BY_COUNTRY = {
  // Die 15 festen Laender
  DE: 'EUR', US: 'USD', CO: 'COP', TH: 'THB', IN: 'INR', EG: 'EGP', AR: 'ARS',
  LK: 'LKR', VN: 'VND', ID: 'IDR', PK: 'PKR', PE: 'PEN',
  MX: 'MXN', PH: 'PHP', JP: 'JPY',
  // Europa
  FR: 'EUR', IT: 'EUR', ES: 'EUR', PT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', IE: 'EUR',
  GR: 'EUR', FI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', SK: 'EUR', SI: 'EUR', LU: 'EUR',
  MT: 'EUR', CY: 'EUR', HR: 'EUR', ME: 'EUR', XK: 'EUR',
  GB: 'GBP', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
  RO: 'RON', BG: 'BGN', RS: 'RSD', UA: 'UAH', IS: 'ISK', AL: 'ALL', BA: 'BAM', MK: 'MKD',
  MD: 'MDL', GE: 'GEL', AM: 'AMD', AZ: 'AZN',
  // Tuerkei: bei den festen Laendern bewusst ausgelassen (von dort sind keine internationalen
  // Buchungen moeglich). Fuer ein TUERKISCHES Hotel ist die tuerkische Sitzung aber genau der
  // Inlandsfall, um den es hier geht - deshalb auf dem dynamischen Platz erlaubt.
  TR: 'TRY',
  // Amerika
  CA: 'CAD', BR: 'BRL', CL: 'CLP', UY: 'UYU', PY: 'PYG', BO: 'BOB', EC: 'USD', PA: 'USD',
  CR: 'CRC', GT: 'GTQ', DO: 'DOP', JM: 'JMD', TT: 'TTD', BS: 'BSD', BB: 'BBD',
  // Asien
  CN: 'CNY', HK: 'HKD', TW: 'TWD', KR: 'KRW', SG: 'SGD', MY: 'MYR', BD: 'BDT', NP: 'NPR',
  KH: 'KHR', LA: 'LAK', MN: 'MNT', KZ: 'KZT', UZ: 'UZS', MV: 'MVR', BN: 'BND',
  // Naher Osten
  AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR', JO: 'JOD', IL: 'ILS',
  // Afrika
  MA: 'MAD', TN: 'TND', ZA: 'ZAR', KE: 'KES', TZ: 'TZS', UG: 'UGX', NG: 'NGN', GH: 'GHS',
  ET: 'ETB', MU: 'MUR', SC: 'SCR', NA: 'NAD', BW: 'BWP', ZM: 'ZMW',
  // Ozeanien
  AU: 'AUD', NZ: 'NZD', FJ: 'FJD', PG: 'PGK',
};

// Booking schreibt das Vereinigte Koenigreich im Pfad als "uk", der ISO-Code ist "gb".
const HOTEL_LAND_ALIAS = { UK: 'GB' };

// Gebiete ohne eigenen Booking-Markt und ohne eigene Waehrung: Dort ist die Sitzung des
// Mutterlandes der richtige Inlandstest. Anlass war ein Hotel auf Réunion (RE) - franzoesisches
// Ueberseedepartement, Euro, EU-Recht. Die passende Sitzung waere Frankreich gewesen; geprueft
// haben wir Deutschland gegen dreizehn aussereuropaeische Laender und Frankreich nie.
const HOTEL_LAND_MUTTERLAND = {
  GP: 'FR', MQ: 'FR', GF: 'FR', RE: 'FR', YT: 'FR', PM: 'FR', BL: 'FR', MF: 'FR',
  WF: 'FR', PF: 'FR', NC: 'FR', MC: 'FR', AD: 'ES', SM: 'IT', VA: 'IT', LI: 'CH',
  PR: 'US', VI: 'US', GU: 'US', AS: 'US', MP: 'US',
  AW: 'NL', CW: 'NL', SX: 'NL', BQ: 'NL',
  GI: 'GB', IM: 'GB', JE: 'GB', GG: 'GB', BM: 'GB', VG: 'GB', KY: 'GB', TC: 'GB',
  AI: 'GB', MS: 'GB', FK: 'GB', SH: 'GB',
  FO: 'DK', GL: 'DK', SJ: 'NO', AX: 'FI',
  NF: 'AU', CX: 'AU', CC: 'AU', CK: 'NZ', NU: 'NZ', TK: 'NZ',
};

// Anzeige-/Sprachkuerzel aus dem Booking.com-Link (z.B. "grand-fasano.de.html") -> Ausgangsland.
// Nur Laender, fuer die wir auch einen Proxy haben, koennen als Baseline dienen; alles andere
// faellt auf DEFAULT_BASELINE_COUNTRY zurueck.
const LANG_TO_BASELINE_COUNTRY = {
  de: 'DE', 'de-de': 'DE', 'de-at': 'DE', 'de-ch': 'DE',
  'en-us': 'US',
  'es-co': 'CO', 'es-ar': 'AR', 'es-mx': 'MX', 'es-pe': 'PE',
  th: 'TH', hi: 'IN', ar: 'EG',
  vi: 'VN', id: 'ID', ja: 'JP',
};

// Leitet das Ausgangsland aus dem Anzeige-/Sprachkuerzel des Booking-Links ab. Booking-Hotel-
// URLs enden auf ".<lang>.html" (z.B. ".de.html", ".en-gb.html"). Nicht zuordenbar -> DE.
function detectBaselineCountry(link) {
  try {
    const path = new URL(link).pathname;
    const m = path.match(/\.([a-z]{2}(?:-[a-z]{2})?)\.html$/i);
    if (m) {
      const lang = m[1].toLowerCase();
      if (LANG_TO_BASELINE_COUNTRY[lang]) return LANG_TO_BASELINE_COUNTRY[lang];
      const two = lang.slice(0, 2).toUpperCase();
      if (ALL_COUNTRIES.includes(two)) return two;
    }
  } catch (e) { /* ungueltiger Link -> Default */ }
  return DEFAULT_BASELINE_COUNTRY;
}

// ---- Link fuer den Abruf auf Deutsch zwingen ---------------------------------------------
// Der gesamte Parser ist deutschsprachig: Er sucht nach "Steuern und Gebuehren", "kostenlos
// stornierbar", "Fruehstueck". Kommt die Seite in einer anderen Sprache zurueck, trifft davon
// nichts und die Anfrage endet mit "kein Preis gefunden" - ohne dass der Nutzer erfaehrt,
// warum. Genau das ist am 17.09. zwei Besuchern aus Oesterreich passiert, deren Link die
// englische Variante war (".html" ohne Sprachkuerzel plus lang=en-us).
//
// Accept-Language allein reicht nicht: Der lang-Parameter in der URL sticht den Header aus.
// Deshalb wird hier beides erzwungen - Pfadendung und Parameter.
//
// WICHTIG: Diese Funktion darf erst NACH detectBaselineCountry() angewendet werden. Die
// Sprachendung des Original-Links ist die einzige Information darueber, aus welchem Land der
// Nutzer kommt; wer sie vorher ueberschreibt, macht aus jedem Besucher einen Deutschen.
// Ins Log gehoert ebenfalls der Originallink, sonst faellt nie wieder auf, dass jemand mit
// einem fremdsprachigen Link kam.
const WAEHRUNGS_PARAMS = ['selected_currency', 'cur_currency', 'currency'];
const PARTNER_PARAMS = ['aid', 'label'];
const PARTNER_PARAMS_ENTFERNEN = process.env.STRIP_PARTNER_PARAMS === '1';
function normalisiereLinkFuerAbruf(link) {
  try {
    const u = new URL(link);
    // ".en-us.html" / ".es.html" -> ".de.html"; Links ohne Sprachkuerzel bleiben unangetastet,
    // die liefert Booking schon anhand des Accept-Language-Headers deutsch aus.
    u.pathname = u.pathname.replace(/\.([a-z]{2}(?:-[a-z]{2})?)\.html$/i, (treffer, lang) =>
      /^de(-[a-z]{2})?$/i.test(lang) ? treffer : '.de.html');
    u.searchParams.set('lang', 'de');
    // Eine im Link festgenagelte Waehrung wuerde jede Laender-Sitzung dieselbe Waehrung zeigen
    // lassen - dann ist die Spalte "Preis vor Ort" wertlos und der Vergleich misst nichts mehr.
    for (const p of WAEHRUNGS_PARAMS) u.searchParams.delete(p);
    // Experiment (STRIP_PARTNER_PARAMS=1): Partner-Kontext aus dem Link nehmen. aid und label
    // sagen Booking, ueber welchen Partner der Besucher kam, und der Partner-Kontext kann Deals
    // beeinflussen. Fuers Log werden sie laengst entfernt, beim Abruf gingen sie bisher mit.
    // Zehn Suchen mit und ohne, dann weiss man, ob ein Teil der Preisstreuung daran haengt.
    if (PARTNER_PARAMS_ENTFERNEN) for (const p of PARTNER_PARAMS) u.searchParams.delete(p);
    return u.toString();
  } catch (e) { return link; }
}

// ---- Proxy-Traffic sparen -----------------------------------------------------------------
// Jedes geladene Byte kostet Guthaben. Fuer die Preiserkennung brauchen wir nur das HTML der
// Hotelseite und Bookings eigene Skripte - Bilder, Schriften, Videos, Tracker und alle
// Drittanbieter-Domains werden hart geblockt.
const BLOCKED_RESOURCE_TYPES = new Set([
  'image', 'media', 'font', 'stylesheet', 'other',
  'texttrack', 'websocket', 'manifest', 'eventsource', 'ping', 'cspviolationreport',
]);
// Schalter fuer den Preis-Pfad: Bookings eigene JavaScript-Bundles mitblocken. Skripte sind
// der Grossteil der uebertragenen Bytes, das waere also der groesste Hebel beim Proxy-Verbrauch.
// Gemessen am 17.09.: Ohne Bookings JS liefert die Seite 0 Zimmer und praktisch keinen Text -
// die Zimmertabelle wird komplett per JavaScript aufgebaut. Der Schalter bleibt deshalb aus.
// Ueber den "rooms"-Modus laesst er sich mit noScripts:true jederzeit nachmessen.
const BLOCK_BOOKING_SCRIPTS = false;
// Nur Bookings eigene Domains duerfen laden (bstatic.com ist Bookings Asset-CDN).
const ALLOWED_HOST_RE = /(^|\.)booking\.com$|(^|\.)bstatic\.com$/i;
// Bekannte Tracker/Werbenetze - sicherheitshalber explizit, falls sie unter booking.com laufen.
const TRACKER_HOST_RE = /google-analytics|googletagmanager|doubleclick|googlesyndication|googleadservices|gstatic|connect\.facebook|facebook\.net|criteo|hotjar|segment\.(io|com)|newrelic|nr-data|sentry|adsrvr|taboola|outbrain|bat\.bing|clarity\.ms|amplitude|mixpanel|optimizely|quantserve|scorecardresearch|adnxs|pubmatic|rubiconproject|casalemedia|tiktok|snapchat|pinterest|twitter|cloudflareinsights|onetrust|cookielaw/i;

// ---- Abfrage-Log (optional, an eine Google-Tabelle via Apps-Script-Webhook) ----------------

const LOG_BOARD_LABEL = { uebernachtung: 'Nur Übernachtung', fruehstueck: 'Frühstück', halbpension: 'Halbpension', vollpension: 'Vollpension', allinclusive: 'All-Inclusive', egal: 'Egal' };
const LOG_CANCEL_LABEL = { ja: 'Kostenlos stornierbar', teilweise: 'Teilweise erstattbar', nein: 'Nicht kostenlos stornierbar', unsicher: 'Egal' };
const LOG_COUNTRY_LABEL = { DE: 'Deutschland', CO: 'Kolumbien', AR: 'Argentinien', EG: 'Ägypten', IN: 'Indien', VN: 'Vietnam', ID: 'Indonesien', PK: 'Pakistan', LK: 'Sri Lanka', PE: 'Peru', MX: 'Mexiko', PH: 'Philippinen', TH: 'Thailand', US: 'USA', JP: 'Japan' };

// Bisher stand in der Tabelle nur das Siegerland. Ein Land, das regelmaessig Zweiter wird,
// tauchte damit nie auf - und die Frage "liegt Land X systematisch daneben?" liess sich nicht
// beantworten, obwohl alle Zahlen vorliegen. Deshalb alle geprueften Laender in eine Zelle.
//
// Format: DE:1292.06:EUR|JP:1264:JPY|US:-:USD  - feste Reihenfolge, "-" fuer "kein Preis".
// Die Waehrung gehoert dazu: Nur an ihr laesst sich erkennen, welche Werte WIR umgerechnet
// haben (alles ausser EUR). Genau die stehen im Verdacht, Scheinfunde zu erzeugen, weil
// Booking mit eigenem Kurs verkauft (siehe OFFEN.md, Punkt 1).
function alleLaenderFuersLog(results, laender) {
  const nachLand = new Map(results.map((r) => [r.country, r]));
  return (laender || ALL_COUNTRIES)
    .filter((c) => nachLand.has(c))
    .map((c) => {
      const r = nachLand.get(c);
      return `${c}:${r.priceEuro != null ? r.priceEuro : '-'}:${r.currency || '-'}`;
    })
    .join('|');
}

// Booking-Links enthalten neben Hotel und Reisedaten auch Kennungen, die nichts in einem
// Protokoll zu suchen haben - allen voran "sid", die Kennung der Booking-SITZUNG des Nutzers.
// Am 17.09. hat ein Forenmitglied seine eigene Hotelsuche in unserem Quelltext wiedererkannt;
// das war der Anlass, hier aufzuraeumen.
//
// Entfernt werden Sitzungs-, Partner- und Tracking-Parameter. Was fuer die Auswertung
// gebraucht wird - Hotel und Reisezeitraum - bleibt erhalten, sonst liesse sich ein alter
// Fund spaeter nicht mehr nachmessen.
const LOG_STRIP_PARAMS = new Set([
  'sid', 'aid', 'label', 'sb_price_type', 'srepoch', 'srpvid', 'lang', 'soz', 'lp', '_',
  'highlighted_blocks', 'matching_block_id', 'sr_pri_blocks', 'all_sr_blocks', 'hapos', 'hpos',
  'dest_id', 'dest_type', 'dist', 'sr_order', 'ucfs', 'atlas_src', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid',
]);
function linkFuersLog(link) {
  try {
    const u = new URL(link);
    for (const p of [...u.searchParams.keys()]) {
      if (LOG_STRIP_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    u.hash = '';
    return u.toString();
  } catch (e) {
    // Kein gueltiger Link (z.B. Tippfehler des Nutzers) - dann lieber gar nichts protokollieren
    // als einen unkontrollierten String.
    return '';
  }
}

// In welchem Land steht das Hotel? Booking verraet es im Pfad: /hotel/de/..., /hotel/th/...
//
// Warum das ins Log gehoert: Bisher laesst sich nur fragen "gewinnt Thailand ueberhaupt". Die
// interessantere Frage ist "gewinnt Thailand bei THAILAENDISCHEN Hotels" - regionale Preisstufen
// haengen vermutlich an der Lage der Unterkunft, nicht allein am Land der Sitzung. Ohne diese
// Spalte wuerden wir Laender aussortieren, die nur nie ein passendes Hotel zu sehen bekamen.
//
// Kostet keine zusaetzliche Anfrage: Die Angabe steht im Link, den wir ohnehin haben.
// Protokolliert wird das ISO-Kuerzel in Grossbuchstaben - dieselbe Schreibweise wie in
// "Alle Laender", damit sich beide Spalten direkt vergleichen lassen.
function hotelLandAusLink(link) {
  try {
    const treffer = new URL(link).pathname.match(/\/hotel\/([a-z]{2})\//i);
    return treffer ? treffer[1].toUpperCase() : '';
  } catch (e) {
    return ''; // kein gueltiger Link - lieber leer als geraten
  }
}

// Lesbarer Hotelname aus dem Pfad: /hotel/de/emanuel-derag-muenchen.de.html -> "Emanuel Derag Muenchen".
// Fuer das "Best of" auf der Startseite: Hotelname ohne Reisezeitraum und ohne vollstaendigen Link,
// damit sich kein Eintrag einer Person zuordnen laesst (OFFEN.md, Punkt 6).
// Hotelname aus dem Seitentitel: "<Name>, <Ort> (aktualisierte Preise fuer 2027)". Der Name darf
// selbst Kommas enthalten ("Bristol Berlin, Vignette Collection by IHG, Berlin (...)"), deshalb
// wird nur der LETZTE Abschnitt (der Ort) abgeschnitten. Liefert '' bei allem, was nicht so
// aussieht - dann gilt weiter der Name aus der Adresse.
function hotelNameAusTitel(titel) {
  let t = String(titel || '').replace(/\s+/g, ' ').trim();
  // Such-, Fehler- oder Pruefseiten ("Booking.com: Hotels in Berlin, Deutschland") sind keine Hotelseite.
  if (!t || /booking\.com/i.test(t)) return '';
  t = t.replace(/\s*\([^()]*\)\s*$/, '').trim();
  const teile = t.split(',').map((x) => x.trim()).filter(Boolean);
  if (teile.length < 2) return '';
  return teile.slice(0, -1).join(', ').slice(0, 80);
}
function hotelNameAusLink(link) {
  try {
    const m = new URL(link).pathname.match(/\/hotel\/[a-z]{2}\/([a-z0-9-]+?)(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.html$/i);
    if (!m) return '';
    return m[1].split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 80);
  } catch (e) { return ''; }
}

// Welche Landessitzung entspricht dem Standort des Hotels? Liefert '' , wenn wir es nicht
// verlaesslich sagen koennen - dann laeuft die Suche wie bisher mit den 15 festen Laendern.
function proxyLandFuerHotel(link) {
  let land = hotelLandAusLink(link);
  if (!land) return '';
  land = HOTEL_LAND_ALIAS[land] || land;
  land = HOTEL_LAND_MUTTERLAND[land] || land;
  // Ohne bekannte Landeswaehrung keine Sitzung: siehe Kommentar an DEFAULT_CURRENCY_BY_COUNTRY.
  return DEFAULT_CURRENCY_BY_COUNTRY[land] ? land : '';
}

// Die Laenderliste DIESER Suche: die 15 festen plus - falls noch nicht dabei - das Land der
// Unterkunft selbst.
//
// Warum das noetig war: Die feste Liste ist eine WELTWEITE Stichprobe, sie passt sich dem Hotel
// nie an. Fuer ein Hotel auf Réunion verglich sie die deutsche Sitzung gegen dreizehn
// aussereuropaeische - und gegen keine einzige andere europaeische. Dabei lag genau dort der
// Befund: Deutschland 125 EUR, alle dreizehn anderen 130,64 bis 131,25. Eine Kante von 4,8 %
// zwischen EU-Sitzung und Rest der Welt, bei einem Hotel, das rechtlich in Frankreich liegt.
// Welchen Preis die franzoesische Sitzung gezeigt haette, wissen wir nicht - wir haben nie gefragt.
//
// Kostet nur dann eine zusaetzliche Abfrage, wenn das Hotelland nicht ohnehin in der Liste steht.
// Bei deutschen Hotels also gar nichts.
//
// Optional darf der Nutzer die Liste einschraenken (auswahl = Array von Laenderkuerzeln): Wer nur
// in Japan und den USA einen VPN-Server hat, braucht die anderen dreizehn Laender nicht - und
// jedes gesparte Land sind rund 2 MB Proxy-Traffic. Erlaubt sind nur Laender aus der festen
// Liste plus das Hotelland; das Ausgangsland kommt immer dazu, sonst gibt es keinen Vergleich.
function laenderFuerDieseSuche(link, auswahl, baseline) {
  const eigen = proxyLandFuerHotel(link);
  let liste = ALL_COUNTRIES;
  if (eigen && !ALL_COUNTRIES.includes(eigen)) {
    // Nach vorn, nicht ans Ende: Bei knappem Zeitbudget wird die Liste von hinten gekuerzt.
    // Haengte man das Hotelland an, fiele ausgerechnet das interessanteste Land als Erstes weg.
    liste = [ALL_COUNTRIES[0], eigen, ...ALL_COUNTRIES.slice(1)];
  }
  if (Array.isArray(auswahl) && auswahl.length) {
    const gewuenscht = new Set(auswahl.map((c) => String(c || '').toUpperCase()));
    const gefiltert = liste.filter((c) => gewuenscht.has(c));
    const base = baseline || ALL_COUNTRIES[0];
    if (!gefiltert.includes(base)) gefiltert.unshift(base);
    // Weniger als zwei Laender ist kein Vergleich - dann wie ohne Auswahl.
    if (gefiltert.length >= 2) liste = gefiltert;
  }
  return liste;
}

// Schreibt EINE Zeile pro Abfrage in die Google-Tabelle. Fehler werden verschluckt - das Logging
// darf den Preis-Check niemals blockieren oder verzoegern.

module.exports = {
  ALL_COUNTRIES, CHEAP_PROBE_COUNTRY, DEFAULT_BASELINE_COUNTRY,
  PROBE_CONFIDENCE_THRESHOLD_PCT, RELEVANT_SAVINGS_PCT, RELEVANT_SAVINGS_PCT_CONVERTED,
  MAX_ATTEMPTS, EXPANSION_ATTEMPTS, EXPANSION_BATCH_SIZE, MIN_LOADED_LINES, ROOM_NAME_MAX_LEN,
  FUNCTION_LIMIT_MS, RESPONSE_RESERVE_MS, HARD_DEADLINE_MS, FIRST_BATCH_ESTIMATE_MS, BATCH_ESTIMATE_SAFETY,
  CACHE_TTL_SECONDS, DEFAULT_CURRENCY_BY_COUNTRY, HOTEL_LAND_ALIAS, HOTEL_LAND_MUTTERLAND, LANG_TO_BASELINE_COUNTRY,
  detectBaselineCountry, normalisiereLinkFuerAbruf,
  BLOCKED_RESOURCE_TYPES, BLOCK_BOOKING_SCRIPTS, ALLOWED_HOST_RE, TRACKER_HOST_RE,
  LOG_BOARD_LABEL, LOG_CANCEL_LABEL, LOG_COUNTRY_LABEL, alleLaenderFuersLog, linkFuersLog,
  hotelLandAusLink, hotelNameAusLink, hotelNameAusTitel, proxyLandFuerHotel, laenderFuerDieseSuche,
  MAX_LINK_LEN, MAX_ROOM_LEN, MAX_USER_PRICE_EUR, BOARD_VALUES, CANCEL_VALUES,
  PARTNER_PARAMS, PARTNER_PARAMS_ENTFERNEN, BASELINE_SAMPLES, CONFIRM_FINDS, MOBILE_CHECK, MOBILE_DEVICE,
};
