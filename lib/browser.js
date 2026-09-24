// Browser-Schicht von GeoRates: Chromium starten, Booking-Seite ueber Proxy laden, Preis je Land.

const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');
const { ROOM_NAME_MAX_LEN, MIN_LOADED_LINES, MAX_ATTEMPTS, BLOCK_BOOKING_SCRIPTS, BLOCKED_RESOURCE_TYPES, ALLOWED_HOST_RE, TRACKER_HOST_RE, DEFAULT_CURRENCY_BY_COUNTRY } = require('./config');
const { findRoomPrice, findRoomPriceMobile, parseAmount, extractExclusiveTaxPct, extractAbsoluteExtraTax, normalizeCurrency, detectSessionCurrency, listRooms, enrichRoomOptions } = require('./parser');


// Vollstaendiges Chromium-Paket (inkl. Shared Libraries wie libnss3.so) wird zur Laufzeit
// aus dem passenden GitHub-Release geladen. So entfaellt das fragile Mitbundeln der Libs
// durch Vercel, das zuvor den Fehler "libnss3.so: cannot open shared object file" ausloeste.
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';


// ---- Live-Wechselkurse (tagesaktuell, EUR-Basis, kostenlos ohne API-Key) -----------------
// Wichtig: Der Vergleich ist nur so verlaesslich wie der Wechselkurs. Deshalb werden zwei
// unabhaengige Live-Quellen versucht. Liefert KEINE Quelle aktuelle Kurse, wird KEIN Preis
// umgerechnet (getLiveRates gibt null zurueck) und die Anfrage bricht sauber ab, statt mit
// veralteten/falschen Kursen zu rechnen.
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getLiveRates() {
  // Quelle 1: open.er-api.com (deckt alle hier genutzten Waehrungen ab).
  try {
    const json = await fetchJson('https://open.er-api.com/v6/latest/EUR', 6000);
    if (json && json.result === 'success' && json.rates) {
      const inverse = { EUR: 1.0 };
      for (const [cur, rate] of Object.entries(json.rates)) {
        if (rate) inverse[cur] = 1 / rate; // EUR-Gegenwert von 1 Einheit `cur`
      }
      return inverse;
    }
  } catch (e) { /* naechste Quelle versuchen */ }

  // Quelle 2: fawazahmed0 currency-api (freie ECB-/Marktdaten, ebenfalls alle Waehrungen).
  try {
    const json = await fetchJson('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json', 6000);
    if (json && json.eur) {
      const inverse = { EUR: 1.0 };
      for (const [cur, rate] of Object.entries(json.eur)) {
        if (rate) inverse[cur.toUpperCase()] = 1 / rate;
      }
      return inverse;
    }
  } catch (e) { /* beide Quellen fehlgeschlagen */ }

  return null; // keine verlaesslichen Live-Kurse -> Aufrufer bricht ab
}


// ---- Geraeteprofile -----------------------------------------------------------------------
// Mehrere Leute im Vielfliegertreff berichten, dass bei Booking das GERAET den groessten
// Preisunterschied macht - groesser als das Land. Messbar ist das nur, wenn wir mehr faelschen
// als den User-Agent-String.
//
// Der haeufigste Fehler dabei: nur den UA aendern. Aktuelles Chrome schickt zusaetzlich
// Client Hints (Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform). Bleiben die auf dem echten
// Wert der Lambda-Umgebung ("Linux", mobile: ?0), waehrend der UA "iPhone" behauptet, ist der
// Widerspruch fuer jede Bot-Erkennung offensichtlich - und Booking liefert dann womoeglich
// genau deshalb andere Preise, was wir faelschlich als Geraete-Effekt lesen wuerden.
// Deshalb wird pro Profil AUCH die Metadata gesetzt, plus passender Viewport und Touch.
const DEVICE_PROFILES = {
  // Der bisherige Standard - bleibt Default, damit alte Messungen vergleichbar bleiben.
  windows: {
    label: 'Windows/Desktop',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    meta: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64', mobile: false, model: '' },
  },
  mac: {
    label: 'macOS/Desktop',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
    meta: { platform: 'macOS', platformVersion: '14.4.0', architecture: 'arm', bitness: '64', mobile: false, model: '' },
  },
  android: {
    label: 'Android/Smartphone',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
    meta: { platform: 'Android', platformVersion: '14.0.0', architecture: '', bitness: '', mobile: true, model: 'Pixel 8' },
  },
  // iPhone laeuft mit Safari-Kennung. Client Hints schickt Safari nicht, deshalb hier keine
  // Metadata - das ist bei einem echten iPhone genauso und faellt daher nicht auf.
  iphone: {
    label: 'iOS/iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    meta: null,
  },
};
const DEFAULT_DEVICE = 'windows';
// Messung vom 17.09.: Die Emulation greift - Booking liefert einer Android-Kennung eine andere
// Seite aus. Der Parser versteht diese Seite aber NICHT. Er findet dort 11 "Zimmer" namens
// "Zimmer", "Nichtraucherzimmer", "Familienzimmer" - das sind Filterbezeichnungen des mobilen
// Layouts, keine Zimmerkategorien. Ergebnis waere also nicht "kein Preis", sondern ein
// falscher Preis, der plausibel aussieht. Solche Zahlen sind schlimmer als keine.
//
// Deshalb: mobile Profile nur im Debug-Modus. Erst wenn das mobile Layout eigenstaendig
// geparst wird, duerfen sie fuer echte Abfragen frei.
//
// Seit 21.09.2026 gibt es einen eigenen Mobil-Parser (parser.findRoomPriceMobile), den fetchPrice
// automatisch nimmt, wenn das Profil mobil ist. Er ist aus einem Screenshot abgeleitet und noch
// nicht gegen die echte Seite geprueft. MOBILE_READY bleibt deshalb false: Es steuert nur, ob ein
// Nutzer ALLE Laender mit Mobilprofil messen darf. Der Smartphone-Abruf im Ausgangsland
// (MOBILE_CHECK in config.js) laeuft daran vorbei, weil er das Profil direkt an fetchPrice gibt.
const MOBILE_READY = false;
function deviceProfile(name) {
  return DEVICE_PROFILES[String(name || '').toLowerCase()] || DEVICE_PROFILES[DEFAULT_DEVICE];
}
// Gibt das tatsaechlich zu verwendende Profil zurueck - und faellt bei noch nicht
// unterstuetzten Mobilprofilen sichtbar auf Desktop zurueck, statt stillschweigend Unsinn
// zu messen.
function resolveDevice(wunsch, debugErlaubt) {
  const name = String(wunsch || DEFAULT_DEVICE).toLowerCase();
  const prof = DEVICE_PROFILES[name];
  if (!prof) return DEFAULT_DEVICE;
  if (prof.viewport.isMobile && !MOBILE_READY && !debugErlaubt) {
    console.log(`[device] "${name}" angefragt, aber das mobile Layout wird noch nicht geparst - nutze ${DEFAULT_DEVICE}.`);
    return DEFAULT_DEVICE;
  }
  return name;
}

// ---- Ein Land pruefen (Proxy + Headless-Chrome, Bilder/Fonts/Stylesheets geblockt) --------

// blockScripts: zusaetzlich zu Bildern/Fonts/CSS auch Bookings eigene JavaScript-Bundles
// verwerfen. Die machen den Loewenanteil des Proxy-Traffics aus, und die Zimmertabelle steht
// im ausgelieferten HTML - ob sie OHNE Skripte noch vollstaendig ist, muss aber gemessen
// werden, nicht angenommen. Deshalb als Schalter, nicht als fixe Aenderung.
// ---- Ein Browser fuer alle Laender (optional) ---------------------------------------------
// Bisher startet jedes Land sein eigenes Chromium: bis zu 16 Starts plus Wiederholungen pro
// Anfrage, jeder Start kostet zwei bis vier Sekunden und RAM. Puppeteer kann stattdessen pro
// Browser-Kontext einen eigenen Proxy setzen (createBrowserContext({ proxyServer })), dann
// reicht EIN Chromium fuer alle Laender - die Kontexte teilen keine Cookies und keinen Cache.
//
// Der Weg ist gegen Booking und Smartproxy noch nicht live gemessen, deshalb hinter einem
// Schalter: BROWSER_SHARED=1 in den Vercel-Umgebungsvariablen schaltet ihn ein. Faellt der
// gemeinsame Browser aus, greift automatisch der bisherige Weg mit eigenem Chromium.
const BROWSER_SHARED = process.env.BROWSER_SHARED === '1';
let sharedBrowserPromise = null;
async function sharedBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer.launch({
      args: [...chromium.args],
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless,
    }).catch((e) => { sharedBrowserPromise = null; throw e; });
  }
  return sharedBrowserPromise;
}
async function sharedBrowserSchliessen() {
  if (!sharedBrowserPromise) return;
  const p = sharedBrowserPromise;
  sharedBrowserPromise = null;
  try { const b = await p; await b.close(); } catch (e) { /* ignorieren */ }
}
// Chromium EINMAL vorab entpacken. Danach koennen mehrere Browser gefahrlos gleichzeitig
// starten (kein spawn ETXTBSY / libnss3.so-Race mehr) - so laeuft auch die Probe parallel.
async function chromiumVorbereiten() {
  try { await chromium.executablePath(CHROMIUM_PACK_URL); } catch (e) { /* Fehler taucht beim Launch erneut auf */ }
}

async function attemptFetch(targetUrl, proxyServer, proxyAuth, blockScripts, device) {
  let browser;   // eigener Browser (klassischer Weg) - wird am Ende geschlossen
  let context;   // Kontext im gemeinsamen Browser - wird am Ende geschlossen
  // Ausserhalb des try, damit der bis zum Abbruch verbrauchte Traffic auch im Fehlerfall
  // zurueckgegeben werden kann.
  let transferBytes = 0;
  const prof = deviceProfile(device);
  try {
    let page;
    if (BROWSER_SHARED) {
      try {
        const b = await sharedBrowser();
        context = await b.createBrowserContext(proxyServer ? { proxyServer } : {});
        page = await context.newPage();
      } catch (e) {
        console.log('[attemptFetch] gemeinsamer Browser nicht verfuegbar, starte eigenen:', (e && e.message) || e);
        context = null;
      }
    }
    if (!page) {
      const launchArgs = proxyServer ? [...chromium.args, `--proxy-server=${proxyServer}`] : [...chromium.args];
      browser = await puppeteer.launch({
        args: launchArgs,
        defaultViewport: prof.viewport,
        executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
        headless: chromium.headless,
      });
      page = await browser.newPage();
    }
    if (proxyServer && proxyAuth) await page.authenticate(proxyAuth);
    await page.setViewport(prof.viewport);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        const typ = req.resourceType();
        if (BLOCKED_RESOURCE_TYPES.has(typ)) return req.abort();
        if (blockScripts && typ === 'script') return req.abort();
        const host = new URL(req.url()).hostname;
        if (TRACKER_HOST_RE.test(host)) return req.abort();
        if (!ALLOWED_HOST_RE.test(host)) return req.abort(); // alle Drittanbieter-Domains
        return req.continue();
      } catch (e) {
        try { return req.continue(); } catch (e2) { /* Request bereits behandelt */ }
      }
    });

    // Tatsaechlich uebertragene Bytes zaehlen - das ist exakt das, was Smartproxy abrechnet.
    //
    // Frueher wurde hier der content-length-Header aufsummiert. Das war praktisch wertlos:
    // Booking liefert fast alles chunked aus, also ganz ohne content-length, und komprimiert
    // zusaetzlich. Gemessen wurden dadurch 7 KB fuer eine Seite mit zwei Dutzend Zimmern -
    // eine Zahl, mit der man keine Entscheidung ueber Proxy-Kosten treffen kann.
    //
    // Network.loadingFinished liefert encodedDataLength: die real ueber die Leitung gegangene,
    // komprimierte Byte-Zahl inklusive Header. Genau die richtige Groesse.
    try {
      const cdp = await page.target().createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.loadingFinished', (e) => { transferBytes += (e && e.encodedDataLength) || 0; });

      // Geraeteprofil setzen: User-Agent UND Client Hints in einem Zug. Ueber CDP, weil nur so
      // die userAgentMetadata mitgeht - mit page.setUserAgent() allein bliebe
      // Sec-CH-UA-Platform auf "Linux" und Sec-CH-UA-Mobile auf "?0" stehen. Ein UA, der
      // "iPhone" behauptet, waehrend die Client Hints "Linux, nicht mobil" sagen, ist fuer
      // Booking sofort als Faelschung erkennbar - und dann messen wir nicht den Geraete-Effekt,
      // sondern die Reaktion auf einen auffaelligen Bot.
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: prof.ua,
        acceptLanguage: 'de-DE,de;q=0.9',
        platform: prof.meta ? prof.meta.platform : 'iPhone',
        ...(prof.meta ? {
          userAgentMetadata: {
            brands: [
              { brand: 'Chromium', version: '123' },
              { brand: 'Google Chrome', version: '123' },
              { brand: 'Not:A-Brand', version: '99' },
            ],
            fullVersion: '123.0.0.0',
            platform: prof.meta.platform,
            platformVersion: prof.meta.platformVersion,
            architecture: prof.meta.architecture,
            bitness: prof.meta.bitness,
            model: prof.meta.model,
            mobile: prof.meta.mobile,
          },
        } : {}),
      });
      if (prof.viewport.hasTouch) {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      }
    } catch (e) {
      // Faellt CDP aus, laeuft alles weiter - aber dann OHNE korrekte Geraetekennung. Das muss
      // im Log stehen, sonst messen wir Desktop und schreiben "Mobil" in die Tabelle.
      console.log('[attemptFetch] CDP-Override fehlgeschlagen, Geraeteprofil evtl. unwirksam:', (e && e.message) || e);
      try { await page.setUserAgent(prof.ua); } catch (e2) { /* ignorieren */ }
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 13000 });

    for (const sel of ["button ::-p-text('Alle akzeptieren')", '#onetrust-accept-btn-handler']) {
      try {
        await page.click(sel, { timeout: 1200 });
        break;
      } catch (e) { /* kein Banner - ignorieren */ }
    }

    try {
      await page.waitForFunction(
        () => !!document.body && /Zimmerkategorie|Preis für|Art der Unterbringung/i.test(document.body.innerText),
        { timeout: 9000 }
      );
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    try {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await new Promise((r) => setTimeout(r, 1200));
    } catch (e) { /* ignorieren */ }

    // Null-sicher: unter Last kann document.body beim Auslesen noch fehlen - das darf den
    // gesamten Abruf nicht abbrechen lassen.
    const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '');

    // Die Adresse NACH allen Weiterleitungen. Der eingegebene Link ist nicht immer die
    // Hotelseite: Bookings Teilen-Funktion erzeugt kurze Adressen der Form booking.com/Share-xxx,
    // und die enthalten weder Hotelname noch Hotelland. Am 20.09. landete dadurch ein Best-of-
    // Eintrag ganz ohne Hotelnamen auf der Startseite - ein namenloser Kasten mit "38,1 %".
    // Nach dem Abruf kennt der Browser die echte Adresse, also nehmen wir sie mit.
    let finalUrl = null;
    try { finalUrl = page.url(); } catch (e) { /* nicht kritisch */ }
    // Seitentitel fuer den Hotelnamen ("Hotel Luetzow, Berlin (aktualisierte Preise ...)"). Die
    // Adresse taugt dafuer nicht: Booking kodiert Umlaute im Pfad um (am 24.09.2026 wurde aus
    // "Luetzow" im Best-of "La1 4tzow"), und Zusaetze wie "barcelona1" stehen nur dort.
    let pageTitle = null;
    try { pageTitle = await page.title(); } catch (e) { /* nicht kritisch */ }

    // Zimmer direkt aus dem DOM der Zimmertabelle lesen: pro Zeile der erste Link (= der blaue
    // Zimmername, exakt was der Nutzer sieht) plus die in DIESEM Zimmerblock real vorhandenen
    // Verpflegungs- und Storno-Optionen (ueber alle Tarifzeilen des Zimmers). Viel zuverlaessiger
    // als aus dem reinen Text zu raten.
    let roomData = [];
    let roomMeta = null;
    try {
      // ROOM_NAME_MAX_LEN wird hineingereicht: der Code unten laeuft im Browser, dort sind die
      // Konstanten dieser Datei nicht sichtbar.
      const ev = await page.evaluate((ROOM_NAME_MAX_LEN) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const boardsOf = (t) => {
          t = t.toLowerCase();
          const b = [];
          if (/all[-\s]?inclusive/.test(t)) b.push('allinclusive');
          if (/vollpension/.test(t)) b.push('vollpension');
          if (/halbpension|abendessen inbegriffen/.test(t)) b.push('halbpension');
          if (/fr(ü|ue)hst(ü|ue)ck/.test(t)) b.push('fruehstueck');
          if (/ohne (fr(ü|ue)hst(ü|ue)ck|mahlzeit)|nur (ü|ue)bernachtung|room only/.test(t)) b.push('uebernachtung');
          return [...new Set(b)];
        };
        const cancelsOf = (t) => {
          t = t.toLowerCase();
          const c = [];
          if (/kostenlose stornierung|kostenlos stornierbar/.test(t)) c.push('ja');
          if (/teilweise erstattbar/.test(t)) c.push('teilweise');
          if (/nicht erstattbar|nicht kostenlos stornierbar|keine kostenlose stornierung/.test(t)) c.push('nein');
          return [...new Set(c)];
        };
        const order = [];
        const map = {};
        const addRow = (name, txt) => {
          if (!map[name]) { map[name] = ''; order.push(name); }
          map[name] += ' ' + (txt || '');
        };
        let strategy = 0;
        let tablesTotal = document.querySelectorAll('table').length;
        // Strategie 1: klassische Zimmertabelle. Der Zimmername steht per rowspan nur in der ersten
        // Tarifzeile; Folgezeilen gehoeren zum selben (zuletzt gesehenen) Zimmer.
        for (const tbl of document.querySelectorAll('table')) {
          const ths = [...tbl.querySelectorAll('th')].map((th) => (th.innerText || '').toLowerCase());
          if (!ths.some((h) => /zimmerkategorie|unterkunftstyp|zimmertyp|art der unterbringung|unterbringungsart|room type|accommodation type/.test(h))) continue;
          let cur = null;
          for (const row of tbl.querySelectorAll('tr')) {
            // Zimmernamen stehen je nach Layout in TD ODER in einer TH-Zeilenkopfzelle.
            const firstTd = [...row.children].find((c) => c.tagName === 'TD' || c.tagName === 'TH');
            if (!firstTd) continue;
            const a = firstTd.querySelector('a');
            const nm = a ? clean(a.innerText) : '';
            // Laengenobergrenze nur als Schutz gegen versehentlich gegriffene Textabsaetze.
            // Sie war mit 70 viel zu knapp: Booking haengt an Zimmernamen gern Zusaetze an
            // ("... - kleinere Villa", "... mit Meerblick"), und genau die laengeren Namen
            // gehoeren oft zu den GUENSTIGSTEN Kategorien. Ein Name mit 71 Zeichen fiel so
            // lautlos raus - der Nutzer sah drei statt vier Zimmern und ausgerechnet das
            // billigste fehlte. Die eigentliche Absicherung ist hier ohnehin die Struktur
            // (erster Link in der Zimmerzeile der Zimmertabelle), nicht die Laenge.
            if (nm && nm.length >= 3 && nm.length <= ROOM_NAME_MAX_LEN) cur = nm;
            if (cur) addRow(cur, row.innerText);
          }
          if (order.length) { strategy = 1; break; }
        }
        // Strategie 2 (Fallback): nur Namen aus bekannten Zimmernamen-Links.
        if (!order.length) {
          const sel = 'a.hprt-roomtype-icon-link, .hprt-roomtype-link, [data-testid="room-name"], [data-testid="rt-title"], [data-component="room-type-name"]';
          for (const el of document.querySelectorAll(sel)) {
            const nm = clean(el.innerText || el.textContent);
            if (nm && nm.length >= 3 && nm.length <= ROOM_NAME_MAX_LEN) addRow(nm, '');
          }
          if (order.length) strategy = 2;
        }
        const rooms = order.map((name) => ({ name, boards: boardsOf(map[name]), cancels: cancelsOf(map[name]) }));
        const meta = {
          strategy,
          tablesTotal,
          firstOptSample: order.length ? (map[order[0]] || '').slice(0, 260) : '',
          bodyHasFruehstueck: /fr(ü|ue)hst(ü|ue)ck/i.test((document.body && document.body.innerText) || ''),
          bodyHasStorno: /stornier/i.test((document.body && document.body.innerText) || ''),
        };
        return { rooms, meta };
      }, ROOM_NAME_MAX_LEN);
      roomData = ev.rooms || [];
      roomMeta = ev.meta || null;
    } catch (e) { roomData = []; }

    if (browser) await browser.close();
    if (context) { try { await context.close(); } catch (e) { /* ignorieren */ } }
    // "Geladen" heisst: die Zimmer-/Preistabelle ist wirklich da. Eine starre Zeilenzahl hat
    // schwere Seiten faelschlich verworfen, obwohl Zimmer und Preise vorhanden waren.
    const lineCount = bodyText.split('\n').length;
    const hasRoomTable = /Zimmerkategorie|Art der Unterbringung|Unterkunftstyp|Zimmertyp|Preis für/i.test(bodyText);
    const loadedOk = hasRoomTable ? lineCount >= 80 : lineCount >= MIN_LOADED_LINES;
    console.log(`[attemptFetch] geladen: ${(transferBytes / 1024).toFixed(0)} KB (${lineCount} Zeilen)`);
    return { bodyText, rooms: roomData, roomMeta, loadedOk, transferBytes, finalUrl, pageTitle, err: null };
  } catch (err) {
    console.error('[attemptFetch] Fehler beim Laden/Chromium-Start:', (err && err.stack) || err);
    if (browser) { try { await browser.close(); } catch (e) { /* ignorieren */ } }
    if (context) { try { await context.close(); } catch (e) { /* ignorieren */ } }
    // Auch ein gescheiterter Versuch hat schon Traffic verbraucht - der muss mitgezaehlt
    // werden, sonst sieht die Kostenbilanz besser aus als sie ist.
    return { bodyText: null, rooms: [], loadedOk: false, transferBytes, finalUrl: null, err };
  }
}

async function fetchPrice(countryCode, targetUrl, proxyServer, userPrefix, password, room, board, cancel, rates, maxAttempts, device) {
  const attempts = maxAttempts || MAX_ATTEMPTS;
  const t0 = Date.now();
  const proxyAuth = { username: `${userPrefix}${countryCode}`, password };
  const expectedCurrency = DEFAULT_CURRENCY_BY_COUNTRY[countryCode];
  const result = { country: countryCode, priceRaw: null, currency: null, priceLocal: null, priceEuro: null };

  let bodyText = null;
  let loadedOk = false;
  let lastErr = null;
  // Zimmerliste aus dem DOM der Zimmertabelle - deutlich sauberer als die Text-Heuristik
  // (die faengt sonst "Zimmer auswaehlen", "Eigenes Badezimmer" oder Bewertungszeilen mit ein).
  let roomData = [];

  // Traffic ueber ALLE Versuche dieses Landes summieren - Fehlversuche kosten genauso.
  result.transferBytes = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await attemptFetch(targetUrl, proxyServer, proxyAuth, BLOCK_BOOKING_SCRIPTS, device);
    result.transferBytes += r.transferBytes || 0;
    bodyText = r.bodyText;
    loadedOk = r.loadedOk;
    lastErr = r.err;
    if (r.finalUrl) result.finalUrl = r.finalUrl;
    if (r.pageTitle) result.pageTitle = r.pageTitle;
    if (r.rooms && r.rooms.length) roomData = r.rooms;
    if (loadedOk && expectedCurrency) {
      const seen = detectSessionCurrency(bodyText);
      // Nur protokollieren, NICHT verwerfen: Booking zeigt z.B. bei US-Hotels auch in einer
      // deutschen Sitzung US-Dollar. Die Umrechnung erfolgt unten anhand der echten Waehrung.
      if (seen && seen !== expectedCurrency) {
        console.log(`[fetchPrice] ${countryCode}: Sitzungswaehrung ${seen} statt ${expectedCurrency}`);
      }
    }
    if (loadedOk) break;
  }

  console.log(`[fetchPrice] ${countryCode}: ${loadedOk ? 'ok' : 'kein Preis'} nach ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (!loadedOk) {
    result.priceRaw = lastErr ? `Fehler: ${lastErr.message || lastErr}` : 'Seite nicht vollständig geladen (Proxy-Exit instabil)';
    return result;
  }

  // Mobiles Profil -> mobiler Parser. Der Desktop-Parser wuerde auf der mobilen Seite plausible,
  // aber falsche Werte liefern (siehe MOBILE_READY oben); der mobile liefert lieber nichts.
  const prof = deviceProfile(device);
  const mobil = !!(prof.viewport && prof.viewport.isMobile);
  result.device = prof.label;
  if (mobil) result.mobile = true;
  const [rawAmt, ctx, curTok, geniusAbzug, stornoArt, verpflegungArt, deals] = mobil
    ? findRoomPriceMobile(bodyText, room, board, cancel)
    : findRoomPrice(bodyText, room, board, cancel);
  // Deal-Plaketten der gewaehlten Stufe - der Grund, warum eine Sitzung guenstiger sein kann.
  result.deals = Array.isArray(deals) ? deals : [];
  // Waehrung aus der tatsaechlichen Preiszeile ableiten (Fallback: Landeswaehrung).
  const currency = normalizeCurrency(curTok, expectedCurrency || 'EUR');
  if (rawAmt) {
    let val = parseAmount(rawAmt);
    const taxPct = extractExclusiveTaxPct(ctx);
    const absExtra = extractAbsoluteExtraTax(ctx);
    if (val !== null && taxPct !== null) {
      val = Math.round(val * (1 + taxPct / 100) * 100) / 100;
      result.priceRaw = `${rawAmt} (${currency}, zzgl. ${taxPct}% Steuer -> steuerinkl.: ${val})`;
    } else if (val !== null && absExtra !== null) {
      val = Math.round((val + absExtra) * 100) / 100;
      result.priceRaw = `${rawAmt} (${currency}, zzgl. ${absExtra} ${currency} Steuern -> steuerinkl.: ${val})`;
    } else {
      result.priceRaw = `${rawAmt} (${currency}, inkl. Steuern & Gebühren)`;
    }
    // Genius wird NICHT mehr herausgerechnet (20.09.2026).
    //
    // Die alte Begruendung lautete, der Rabatt sei "nur eingeloggt zahlbar" und der Nutzer
    // bekomme diesen Preis nicht. Das stimmt nicht: Genius Level 1 erhaelt jeder allein durch
    // die Registrierung eines kostenlosen Kontos - ohne eine einzige abgeschlossene Buchung -
    // und seine E-Mail-Adresse gibt beim Buchen ohnehin jeder an. Herausgerechnet meldete das
    // Tool also eine Zahl, die niemand zahlt: Am Jaz Amaluna standen 2.224,21 EUR in unserer
    // Tabelle, waehrend die Hotelseite 2.002 EUR auswies - ohne dass irgendwo erklaert wurde,
    // woher die Differenz kommt. Das steht ausserdem im Widerspruch zur eigenen Zusage auf der
    // Startseite, die genannte Zahl sei "der tatsaechliche Endpreis".
    //
    // Schwerer wog die Asymmetrie: Zurueckgerechnet wurde NUR dort, wo im Seitentext eine Zeile
    // "Genius-Rabatt" stand. Sitzungen, die denselben Nachlass anders ausweisen (Booking nennt
    // ihn je nach Land auch "Booking.com bezahlt" oder zeigt nur einen durchgestrichenen Preis),
    // blieben rabattiert. Der Laendervergleich mass dann nicht den Preis, sondern die Textform
    // der Rabattzeile.
    //
    // Der erkannte Betrag wird weiter mitgefuehrt, aber nur noch als HINWEIS: Er ist das Signal
    // dafuer, dass diese Sitzung ueberhaupt einen Rabatt gesehen hat. Ob zwei Laender darin
    // uebereinstimmen, muss spaeter darueber entscheiden, ob ihr Vergleich ueberhaupt gueltig ist.
    if (val !== null && geniusAbzug) {
      result.geniusRabatt = geniusAbzug;
      result.priceRaw += ` | Rabatt in dieser Sitzung sichtbar: ${geniusAbzug} (im Preis enthalten)`;
    }
    // WELCHEN Tarif haben wir genommen? Ein Zimmer hat oft mehrere Stufen, die sich nur in
    // Storno und Verpflegung unterscheiden - am 21.09.2026 beim Horizon of Pattaya 452,84 EUR
    // nicht stornierbar gegen 462,24 EUR kostenlos stornierbar, dasselbe Zimmer. Ohne diese
    // Angabe laesst sich im Ergebnis nicht erkennen, ob zwei Laender ueberhaupt dasselbe
    // verglichen haben - und genau daran haengt, ob eine gemeldete Ersparnis echt ist oder nur
    // zwei verschiedene Produkte nebeneinanderstellt.
    if (stornoArt) result.stornoArt = stornoArt;
    if (verpflegungArt) result.verpflegungArt = verpflegungArt;
    if (stornoArt || verpflegungArt) {
      result.priceRaw += ` | Tarif: ${verpflegungArt || 'Verpflegung unbekannt'}, Storno ${stornoArt || 'unbekannt'}`;
    }
    result.currency = currency;
    result.priceLocal = val; // Betrag in der Landeswaehrung (zur VPN-Kontrolle im Frontend)
    if (val !== null) {
      const rate = rates[currency];
      if (rate) result.priceEuro = Math.round(val * rate * 100) / 100;
    }
  } else {
    result.priceRaw = `Zimmer "${room}" auf dieser Landes-Session nicht gefunden/verfügbar`;
    // Diagnose statt Sackgasse: "kein Preis gefunden" ist die nutzloseste aller Antworten,
    // wenn der Grund schlicht ein Zimmername ist, den es auf der Seite nie gab. Genau das
    // ist am 17.09. passiert - jemand suchte "Superior Zimmer", das Hotel hatte aber nur
    // "Superior Double Room with Hagia Sophia View". Zwei Versuche, zweimal nichts, dabei
    // waeren ueber Japan 10,9 % drin gewesen. Deshalb sammeln wir hier, was wirklich auf der
    // Seite steht, damit das Frontend dem Nutzer den Weg zeigen kann statt ihn wegzuschicken.
    // Reine Textarbeit auf dem ohnehin geladenen bodyText, also kein zusaetzlicher Traffic.
    try {
      const basis = roomData.length
        ? roomData
        : listRooms(bodyText).map((n) => ({ name: n, boards: [], cancels: [] }));
      const opts = enrichRoomOptions(bodyText, basis);
      const gesucht = String(room || '').trim().toLowerCase();
      const treffer = opts.find((o) => o.name.trim().toLowerCase() === gesucht);
      // Dritter Fall neben "Zimmer gibt es nicht" und "Verpflegung passt nicht": Das Zimmer
      // steht auf der Seite, hat fuer diesen Zeitraum aber gar keine Tarifzeile - typischerweise
      // ausgebucht. Ohne diese Unterscheidung landet der Nutzer beim allgemeinen Text, der ihm
      // faelschlich fehlende Reisedaten unterstellt, obwohl sein Link welche hat.
      const hatTarife = (o) => !!o && ((o.boards || []).length > 0 || (o.cancels || []).length > 0);
      result.diagnose = {
        zimmerGefunden: !!treffer,
        ohneTarife: treffer ? !hatTarife(treffer) : null,
        verpflegungPasst: treffer
          ? (!board || board === 'egal' || !(treffer.boards || []).length || treffer.boards.includes(board))
          : null,
        zimmerAufSeite: opts.slice(0, 12).map((o) => ({
          name: o.name, boards: o.boards || [], cancels: o.cancels || [],
        })),
      };
    } catch (e) { /* Diagnose ist Zugabe - ein Fehler darf die Antwort nicht kippen */ }
  }
  return result;
}


module.exports = {
  CHROMIUM_PACK_URL, DEVICE_PROFILES, DEFAULT_DEVICE, MOBILE_READY, deviceProfile, resolveDevice,
  getLiveRates, attemptFetch, fetchPrice, chromiumVorbereiten, sharedBrowserSchliessen,
};
