// Serverless Function: GeoRates Geo-Preisvergleich. Prueft den Preis eines konkreten
// Booking.com-Zimmers ueber Proxy-Sessions aus mehreren Laendern (Smartproxy) und meldet
// zurueck, ob ein Laenderwechsel (VPN) eine relevante Ersparnis bringt.
//
// Die Logik liegt in lib/: config (Konstanten, Laender, Links), parser (Text -> Preis),
// browser (Chromium, Proxy, Seite laden), store (Upstash, Log, Best-of), http (CORS, Turnstile).
// Diese Datei ist nur noch der Ablauf einer Anfrage.
//
// Kostenschutz (echter Proxy-Traffic kostet Geld, daher mehrfach abgesichert):
//   1. Cloudflare Turnstile Bot-Check vor JEDER Anfrage, die Proxy-Traffic ausloest - seit dem
//      Audit auch im "rooms"-Modus (siehe verifyTurnstile).
//   2. Zaehlbremse pro IP fuer beide Modi und ein harter Tagesdeckel in Anfragen und Megabyte
//      (lib/store.js). Turnstile beweist einen Menschen, nicht dessen Zurueckhaltung.
//   3. Ergebnis-Cache (Upstash Redis, 24h) mit bereinigtem Link - identische Suchen loesen
//      keinen neuen Proxy-Traffic aus, auch wenn Booking eine neue Sitzungs-ID in den Link schreibt.
//   4. Bilder/Fonts/Stylesheets werden beim Laden geblockt (nur Text noetig).
//   5. Erst DE+CO parallel als schnelle Probe, danach die uebrigen Laender in Gruppen.
//      Eine weitere Laendergruppe wird nur gestartet, wenn sie nach der bisher gemessenen
//      Gruppendauer noch vor dem Vercel-Zeitlimit fertig wird. Reicht die Zeit nicht,
//      liefert die Antwort die bis dahin geprueften Laender plus partial:true zurueck.
//   6. Debug-Schalter nur mit Geheimwort im Header (DEBUG_SECRET).

const cfg = require('../lib/config');
const parser = require('../lib/parser');
const browser = require('../lib/browser');
const store = require('../lib/store');
const { verifyTurnstile, setCors, clientIp, debugErlaubt } = require('../lib/http');

const {
  ALL_COUNTRIES, CHEAP_PROBE_COUNTRY, MAX_ATTEMPTS, EXPANSION_ATTEMPTS, EXPANSION_BATCH_SIZE,
  HARD_DEADLINE_MS, FIRST_BATCH_ESTIMATE_MS, BATCH_ESTIMATE_SAFETY, MIN_LOADED_LINES,
  DEFAULT_CURRENCY_BY_COUNTRY, LOG_BOARD_LABEL, LOG_CANCEL_LABEL, LOG_COUNTRY_LABEL,
  MAX_LINK_LEN, MAX_ROOM_LEN, BOARD_VALUES, CANCEL_VALUES,
} = cfg;

const BOOKING_LINK_RE = /^https?:\/\/([a-z0-9-]+\.)*booking\.com\//i;

// Eingaben auf das Erwartete begrenzen. Alles ist ein String aus dem Browser; Laenge und
// Wertebereich werden hier festgezogen, damit weder Cache-Schluessel noch Log noch Parser mit
// beliebig grossen oder fremden Werten arbeiten muessen.
function eingabenPruefen(body) {
  const b = body || {};
  const link = String(b.link || '').trim();
  const room = String(b.room || '').trim();
  const board = String(b.board || '').trim();
  const cancel = String(b.cancel || '').trim();
  if (!link || link.length > MAX_LINK_LEN || !BOOKING_LINK_RE.test(link)) return { fehler: 'invalid_link' };
  if (room.length > MAX_ROOM_LEN) return { fehler: 'invalid_room' };
  if (!BOARD_VALUES.includes(board)) return { fehler: 'invalid_board' };
  if (!CANCEL_VALUES.includes(cancel)) return { fehler: 'invalid_cancel' };
  // Laenderauswahl: nur Kuerzel, nur bekannte Laender, hoechstens die feste Liste plus Hotelland.
  let countries = null;
  if (Array.isArray(b.countries)) {
    countries = b.countries.map((c) => String(c || '').toUpperCase().slice(0, 2)).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 20);
  }
  return { link, room, board, cancel, countries };
}

// Fehlermeldungen an den Client sind generisch. Die Details (Stack, Proxy-Antworten) gehoeren
// ins Vercel-Log, nicht in die Antwort - dort kann sie jeder lesen, der den Endpunkt aufruft.
function fehlerAntwort(err) {
  console.error('[check-price] Fehler:', (err && err.stack) || err);
  return { success: false, reason: 'error', message: 'Der Check konnte gerade nicht ausgeführt werden.' };
}

module.exports = async (req, res) => {
  const startTime = Date.now();
  setCors(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ success: false, reason: 'method_not_allowed' }); return; }

  const body = req.body || {};
  const { mode, turnstileToken } = body;
  const debug = debugErlaubt(req);
  const remoteIp = clientIp(req);

  // ---- Streaming ---------------------------------------------------------------------------
  // Ein vollstaendiger Laendervergleich dauert etwa eine Minute. Frueher schwieg der Server
  // diese ganze Zeit und schickte am Ende alles auf einmal - der Nutzer sass vor einem
  // Spinner und wusste nicht, ob ueberhaupt etwas passiert. Viele brechen dann ab.
  //
  // Mit stream:true schicken wir stattdessen NDJSON: pro fertigem Land sofort eine Zeile,
  // ganz am Ende eine "summary"-Zeile mit dem Gesamtergebnis. Das Frontend fuellt die Tabelle
  // damit live. Die Gesamtdauer aendert sich dadurch nicht - die gefuehlte Wartezeit schon,
  // weil nach ~20s die ersten echten Zahlen dastehen.
  //
  // Wichtig: Turnstile-Pruefung, Vergleichslogik und Logging bleiben hier im Server. Die
  // Alternative (mehrere parallele Requests aus dem Browser) haette genau das in den Client
  // verlagert, wo es manipulierbar waere.
  const wantsStream = !!body.stream && mode !== 'rooms';
  let streamOpen = false;
  const streamSend = (obj) => {
    if (!streamOpen) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { /* Verbindung weg - egal */ }
  };
  const openStream = () => {
    if (streamOpen) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Ohne diese Header puffern manche Zwischenschichten die Antwort, bis sie komplett ist -
    // dann waere das Streaming wirkungslos.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    streamOpen = true;
  };
  // Antwortet je nach Modus als Stream-Abschluss oder als klassisches JSON, damit der restliche
  // Code sich nicht um den Unterschied kuemmern muss.
  const respond = (statusCode, payload) => {
    if (wantsStream) {
      openStream();
      streamSend({ type: 'summary', ...payload });
      res.end();
    } else {
      res.status(statusCode).json(payload);
    }
  };

  const eingabe = eingabenPruefen(body);

  // Bot-Check fuer BEIDE Modi. Der Zimmer-Abruf lief bisher ohne Turnstile, weil er "leicht" ist -
  // er loest aber genauso echten Proxy-Traffic aus und war damit der billigste Weg, Guthaben zu
  // verbrennen. Ohne konfigurierten Key wird der Check uebersprungen (verifyTurnstile).
  const humanOk = await verifyTurnstile(turnstileToken, remoteIp);
  if (!humanOk) {
    if (mode === 'rooms') { res.status(403).json({ success: false, reason: 'bot_check_failed' }); return; }
    respond(403, { success: false, reason: 'bot_check_failed' });
    return;
  }

  // Modus "rooms": nur die Zimmerliste des Hotels laden (fuer das Auswahl-Dropdown im Formular).
  // Ein einziger Seitenabruf ueber das Ausgangsland, kein Laendervergleich.
  if (mode === 'rooms') {
    if (eingabe.fehler === 'invalid_link') { res.status(400).json({ success: false, reason: 'invalid_link' }); return; }
    if (await store.rateLimitUeberschritten('rooms', remoteIp, store.ROOMS_RATE_LIMIT, store.RATE_WINDOW_SECONDS)) {
      res.status(429).json({ success: false, reason: 'rate_limited' });
      return;
    }
    if (await store.tagesdeckelErreicht()) { res.status(200).json({ success: false, reason: 'daily_budget_reached' }); return; }
    const up = process.env.SMARTPROXY_USER_PREFIX;
    const pw = process.env.SMARTPROXY_PASSWORD;
    const srv = process.env.SMARTPROXY_SERVER || 'http://proxy.smartproxy.net:3120';
    if (!up || !pw) { res.status(200).json({ success: false, reason: 'proxy_not_configured' }); return; }
    const link = eingabe.link;
    let bytes = 0;
    try {
      await browser.chromiumVorbereiten();
      const baselineCountry = cfg.detectBaselineCountry(link);
      // Reihenfolge beachten: erst Baseline aus dem Originallink lesen, dann auf Deutsch zwingen.
      const abrufLink = cfg.normalisiereLinkFuerAbruf(link);

      // Zimmer zuerst aus den DOM-Links der Zimmertabelle nehmen (r.rooms, inkl. Verpflegungs-/
      // Storno-Optionen); nur wenn leer, faellt es auf die Text-Heuristik (nur Namen) zurueck.
      const roomsFrom = (r) => {
        const base = r.rooms && r.rooms.length
          ? r.rooms
          : parser.listRooms(r.bodyText || '').map((name) => ({ name, boards: [], cancels: [] }));
        return parser.enrichRoomOptions(r.bodyText || '', base);
      };
      const hasOpts = (rl) => rl.some((x) => (x.boards && x.boards.length) || (x.cancels && x.cancels.length));

      let withOpts = null;   // Zimmer inkl. Verpflegungs-/Storno-Optionen (bevorzugt)
      let namesOnly = null;  // Zimmer nur mit Namen (Fallback)
      let lastR = null;

      // 1) Ueber den Baseline-Proxy laden: NUR mit echter (Residential-)Verfuegbarkeit liefert
      //    Booking die Tarifzeilen mit Verpflegung/Storno. Ein Datacenter-Direktabruf bekommt zwar
      //    die Zimmernamen, aber keine Optionen - daher hier Proxy zuerst.
      const proxyAuth = { username: `${up}${baselineCountry}`, password: pw };
      // Messmodus (nur mit Debug-Secret): Mit noScripts:true laesst sich derselbe Abruf einmal mit
      // und einmal ohne Bookings JavaScript fahren, um Traffic-Ersparnis und Trefferquote zu
      // vergleichen. Geraeteprofile ebenso - der billigste Weg zu sehen, ob der Parser die
      // mobile Seitenstruktur ueberhaupt versteht.
      const blockScripts = debug && !!body.noScripts;
      const device = browser.resolveDevice(debug ? body.device : null, debug);
      for (let a = 1; a <= 2 && !withOpts; a++) {
        const r = await browser.attemptFetch(abrufLink, srv, proxyAuth, blockScripts, device);
        bytes += r.transferBytes || 0;
        lastR = r;
        if (r.loadedOk) {
          const rl = roomsFrom(r);
          if (rl.length) { if (hasOpts(rl)) withOpts = rl; else if (!namesOnly) namesOnly = rl; }
        }
      }
      // 2) Falls der Proxy gar nichts brachte: kostenloser Direktabruf, wenigstens fuer die Namen.
      if (!withOpts && !namesOnly) {
        const r = await browser.attemptFetch(abrufLink, null, null, blockScripts, device);
        lastR = r;
        if (r.loadedOk) { const rl = roomsFrom(r); if (rl.length) namesOnly = rl; }
      }
      const rooms = withOpts || namesOnly;
      await store.tagesstatistikSchreiben({ erfolg: !!rooms, fund: false, bytes });
      if (!rooms) {
        const failPayload = { success: false, reason: 'rooms_not_loaded' };
        if (debug && lastR) failPayload.dbg = { roomMeta: lastR.roomMeta, loadedOk: lastR.loadedOk, bodyLen: (lastR.bodyText || '').length };
        res.status(200).json(failPayload);
        return;
      }
      const payload = { success: true, rooms, baselineCountry };
      if (debug && lastR) {
        payload.dbg = { roomMeta: lastR.roomMeta, bodyLen: (lastR.bodyText || '').length, loadedOk: lastR.loadedOk, transferKB: Math.round((lastR.transferBytes || 0) / 1024) };
        // Diagnose: die echte Preis-Erkennung gegen den vom Server geladenen Seitentext testen.
        try {
          const bt = lastR.bodyText || '';
          const ls = bt.split('\n').map((l) => l.trim()).filter(Boolean);
          payload.dbg.lineCount = ls.length;
          payload.dbg.minLines = MIN_LOADED_LINES;
          // debugRoom: den Ausschnitt an einem gewaehlten Zimmer verankern statt an rooms[0]
          // (OFFEN.md, Punkt 2 - dort war genau das der fehlende Handgriff).
          const rn = String(body.debugRoom || (rooms && rooms[0] && rooms[0].name) || '');
          const idx = ls.findIndex((l) => l.toLowerCase().startsWith(rn.toLowerCase()));
          const [amt] = rn ? parser.findRoomPrice(bt, rn, '', '') : [null];
          // Fensterbreite einstellbar (debugLines): 22 Zeilen reichen, um den ersten Preis zu
          // sehen, aber nicht, um die Tarifstufen eines Zimmers nachzuvollziehen - genau die
          // braucht man aber, wenn die Verpflegungs-Optionen unvollstaendig sind.
          const fenster = Math.min(Math.max(parseInt(body.debugLines, 10) || 22, 5), 160);
          payload.dbg.probe = { room: rn, roomLineIdx: idx, amount: amt, snippet: idx >= 0 ? ls.slice(idx, idx + fenster) : [] };
          // Mit debug:'price' den ECHTEN Preis-Pfad fuers Ausgangsland durchlaufen lassen.
          if (body.debug === 'price' && rn) {
            // Ohne zweiten Browserstart: die Preis-Kette auf dem BEREITS geladenen Seitentext pruefen.
            const rr = await browser.getLiveRates();
            const useRoom = body.room || rn;
            const [amt2, , curTok] = parser.findRoomPrice(bt, useRoom, body.board || '', body.cancel || '');
            const cur = parser.normalizeCurrency(curTok, DEFAULT_CURRENCY_BY_COUNTRY[baselineCountry] || 'EUR');
            const val = parser.parseAmount(amt2);
            const rate = rr && rr[cur];
            payload.dbg.pricePath = {
              ratesOk: !!rr, room: useRoom, rawAmount: amt2, currencyToken: curTok, currency: cur,
              value: val, rate: rate || null,
              priceEuro: (val !== null && rate) ? Math.round(val * rate * 100) / 100 : null,
            };
          }
        } catch (e) { payload.dbg.probeErr = String(e); }
      }
      res.status(200).json(payload);
    } catch (err) {
      res.status(200).json(fehlerAntwort(err));
    } finally {
      await browser.sharedBrowserSchliessen();
    }
    return;
  }

  // ---- Preis-Check -------------------------------------------------------------------------

  // Herkunftsland des Besuchers (setzt Vercel am Edge). Nur das Laenderkuerzel, keine IP.
  const visitorCountry = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
  const herkunftsland = LOG_COUNTRY_LABEL[visitorCountry] || visitorCountry || 'unbekannt';
  const { link, room, board, cancel } = eingabe.fehler ? { link: String(body.link || '').slice(0, MAX_LINK_LEN), room: '', board: '', cancel: '' } : eingabe;

  // Jede Abfrage protokollieren - auch die erfolglosen. Die zeigen Traffic und belegen, dass die
  // Seite benutzt wird; ausserdem sieht man an den Status-Werten sofort, wo es klemmt.
  const logAttempt = (status, extra) => store.logQuery({
    hotelLink: cfg.linkFuersLog(link),
    room: room || '',
    board: LOG_BOARD_LABEL[board] || board || '',
    cancel: LOG_CANCEL_LABEL[cancel] || cancel || '',
    baselineLand: '',
    baselinePreisEuro: '',
    bestesLand: '',
    bestPreisEuro: '',
    bestPreisVorOrt: '',
    ersparnisProzent: '',
    ersparnisEuro: '',
    herkunftsland,
    relevant: 'nein',
    empfehlung: 'nein',
    status,
    hotelLand: cfg.hotelLandAusLink(link),
    ...(extra || {}),
  });

  if (eingabe.fehler) {
    await logAttempt(eingabe.fehler === 'invalid_link' ? 'kein gültiger Booking-Link' : `ungültige Eingabe (${eingabe.fehler})`);
    respond(400, { success: false, reason: eingabe.fehler });
    return;
  }
  if (!room) {
    await logAttempt('kein Zimmer angegeben');
    respond(400, { success: false, reason: 'missing_room' });
    return;
  }

  // Die freie Geraetewahl ist ein Messwerkzeug: Sie veraendert das Ergebnis UND den Cache-Schluessel,
  // ein Fremder koennte damit am Cache vorbei immer neue Abrufe ausloesen. Ohne Debug-Header gilt
  // deshalb das Standardprofil (Entscheidung vom 20.09.).
  const device = browser.resolveDevice(debug ? body.device : null, false);
  const baselineCountry = cfg.detectBaselineCountry(link);
  // Laenderliste DIESER Suche - die 15 festen plus ggf. das Land der Unterkunft, optional vom
  // Nutzer eingeschraenkt.
  const laender = cfg.laenderFuerDieseSuche(link, eingabe.countries, baselineCountry);
  const cacheKey = store.cacheKeyFor(link, room, board, cancel, device, laender);
  const resultId = store.resultIdFor(cacheKey);
  const cached = await store.cacheGet(cacheKey);
  if (cached) {
    await logAttempt('aus Cache');
    // Aus dem Cache liegt alles sofort vor. Im Stream-Modus schicken wir die Laenderzeilen
    // trotzdem einzeln, damit das Frontend nur EINEN Darstellungsweg braucht.
    if (wantsStream) {
      openStream();
      streamSend({ type: 'meta', baselineCountry: cached.baselineCountry, fromCache: true, totalCountries: (cached.results || []).length });
      (cached.results || []).forEach((r) => streamSend({ type: 'country', result: r }));
    }
    respond(200, { ...cached, fromCache: true, resultId });
    return;
  }

  // Erst NACH dem Cache bremsen: eine Antwort aus dem Cache kostet nichts und soll niemanden
  // ausbremsen, der dasselbe Ergebnis zweimal ansieht.
  if (await store.rateLimitUeberschritten('price', remoteIp, store.PRICE_RATE_LIMIT, store.RATE_WINDOW_SECONDS)) {
    await logAttempt('Zählbremse (IP)');
    respond(429, { success: false, reason: 'rate_limited' });
    return;
  }
  if (await store.tagesdeckelErreicht()) {
    await logAttempt('Tagesdeckel erreicht');
    respond(200, { success: false, reason: 'daily_budget_reached' });
    return;
  }

  const userPrefix = process.env.SMARTPROXY_USER_PREFIX; // Form: "<konto>_area-", Landescode wird angehaengt
  const password = process.env.SMARTPROXY_PASSWORD;
  const proxyServer = process.env.SMARTPROXY_SERVER || 'http://proxy.smartproxy.net:3120';
  if (!userPrefix || !password) {
    respond(200, { success: false, reason: 'proxy_not_configured' });
    return;
  }

  let results = [];
  try {
    // Verlaessliche Live-Wechselkurse sind Pflicht - ohne sie waere der Laendervergleich
    // wertlos. Sind beide Quellen nicht erreichbar, brechen wir sauber ab.
    const rates = await browser.getLiveRates();
    if (!rates) {
      await logAttempt('Wechselkurse nicht erreichbar');
      respond(200, { success: false, reason: 'fx_unavailable' });
      return;
    }

    await browser.chromiumVorbereiten();

    // Erst danach den Link fuer den Abruf auf Deutsch zwingen (Parser ist deutschsprachig).
    // `link` bleibt unveraendert: er wird weiter fuers Log und fuer die Antwort gebraucht.
    const abrufLink = cfg.normalisiereLinkFuerAbruf(link);
    // Geraeteprofil gilt fuer ALLE Laender derselben Abfrage. Sonst waere der Vergleich wertlos:
    // Wir wollen den Laendereffekt messen, nicht Land gegen Geraet.
    const deviceLabel = browser.deviceProfile(device).label;

    if (laender !== ALL_COUNTRIES) {
      console.log(`[check-price] Laenderliste dieser Suche: ${laender.join(',')} (${laender.length})`);
    }

    // Probe: Ausgangsland + Guenstig-Kandidat (Kolumbien) PARALLEL, je 2 Versuche (Genauigkeit).
    const probeCountries = [baselineCountry];
    if (!probeCountries.includes(CHEAP_PROBE_COUNTRY) && laender.includes(CHEAP_PROBE_COUNTRY)) probeCountries.push(CHEAP_PROBE_COUNTRY);

    if (wantsStream) {
      openStream();
      streamSend({ type: 'meta', baselineCountry, totalCountries: laender.length, resultId });
    }
    // Im Stream-Modus geht jedes Land raus, SOBALD es fertig ist - nicht erst, wenn die ganze
    // Gruppe durch ist. Deshalb haengt der Versand am einzelnen Promise, nicht am Promise.all.
    // Sobald der Ausgangspreis feststeht, wird jeder weitere Landespreis schon VOR dem Senden
    // gegen ihn plausibilisiert. Sonst blitzt ein kaputter Wert (2,4 Mio. EUR) kurz in der
    // Live-Tabelle auf und verschwindet erst mit der Endauswertung wieder - das sieht aus,
    // als wuerde das Tool raten.
    let basePriceForGuard = null;
    const fetchAndStream = (c, attempts) =>
      browser.fetchPrice(c, abrufLink, proxyServer, userPrefix, password, room, board, cancel, rates, attempts, device)
        .then((r) => {
          if (c !== baselineCountry && parser.implausibleVsBaseline(r.priceEuro, basePriceForGuard)) {
            r.priceEuro = null;
            r.priceLocal = null;
            r.priceRaw = 'Preis nicht verlässlich erkannt';
            r.implausible = true;
          }
          // Die Diagnose (Zimmerliste der Seite) bleibt im Ergebnis, wird aber nicht pro Land
          // gestreamt - sonst schickt ein Fehlschlag 15x dieselbe Liste durch die Leitung.
          const { diagnose, ...fuerDieTabelle } = r;
          streamSend({ type: 'country', result: fuerDieTabelle });
          return r;
        });

    results = await Promise.all(probeCountries.map((c) => fetchAndStream(c, MAX_ATTEMPTS)));
    // Ab hier kennen wir den Referenzpreis - alle folgenden Laender laufen durch die Pruefung.
    const probeBase = results.find((r) => r.country === baselineCountry);
    basePriceForGuard = probeBase && probeBase.priceEuro != null ? probeBase.priceEuro : null;

    console.log('[check-price] Baseline:', baselineCountry, '| Probe-Ergebnis:',
      JSON.stringify(results.map((r) => ({ c: r.country, eur: r.priceEuro, raw: r.priceRaw }))));

    let summary = parser.summarize(results, baselineCountry);
    let partial = false;

    // Hier wurde die Suche frueher abgebrochen, sobald Kolumbien mindestens 10% guenstiger war
    // als das Ausgangsland ("gut genug gefunden, Rest sparen"). Das ist ersatzlos raus: Am 17.09.
    // lag bei derselben Suite Kolumbien bei 11%, Indien aber bei 19,3% - die alte Regel haette
    // 8 Prozentpunkte liegen lassen und dabei behauptet, das guenstigste Land gefunden zu haben.
    // Sie hat ausserdem die eigene Statistik verzerrt, weil kein anderes Land je gewinnen konnte.
    // Es werden deshalb immer alle Laender geprueft; der zusaetzliche Proxy-Traffic ist der Preis.
    //
    // EINE Ausnahme gibt es, und die kostet nichts an Aussagekraft: Steht das gesuchte Zimmer
    // auf der Hotelseite ueberhaupt nicht, wird es auch kein anderes Land finden. Solche Suchen
    // liefen bisher trotzdem durch alle 15 Laender - rund 35 MB Proxy-Traffic fuer ein Ergebnis,
    // das nach dem ersten Land feststand. Am 17.09. ist das zweimal hintereinander passiert.
    const zimmerFehltAufDerSeite = !!(probeBase && probeBase.diagnose && probeBase.diagnose.zimmerGefunden === false);
    if (zimmerFehltAufDerSeite) {
      console.log(`[check-price] Zimmer "${room}" steht nicht auf der Hotelseite - Erweiterung uebersprungen.`);
    }
    if (!zimmerFehltAufDerSeite) {
      // Die restlichen Laender in PARALLELEN Gruppen pruefen (je 1 Versuch, damit's schnell
      // bleibt). Chromium ist bereits entpackt, daher ist Parallelitaet gefahrlos; die
      // Gruppengroesse begrenzt den Arbeitsspeicher.
      //
      // Die naechste Gruppe wird nur gestartet, wenn sie nach der bisher gemessenen Dauer
      // auch noch fertig wird. So laeuft die Funktion weder ins Vercel-Limit noch bricht sie
      // ab, obwohl noch Zeit fuer eine weitere Gruppe waere.
      const remaining = laender.filter((c) => !probeCountries.includes(c));
      let batchEstimateMs = FIRST_BATCH_ESTIMATE_MS;
      for (let i = 0; i < remaining.length; i += EXPANSION_BATCH_SIZE) {
        const elapsed = Date.now() - startTime;
        if (elapsed + batchEstimateMs > HARD_DEADLINE_MS) {
          partial = true;
          console.log(`[check-price] Erweiterung gestoppt nach ${(elapsed / 1000).toFixed(1)}s: ` +
            `naechste Gruppe braucht geschaetzt ${(batchEstimateMs / 1000).toFixed(1)}s, ` +
            `Deadline ${(HARD_DEADLINE_MS / 1000).toFixed(0)}s. ` +
            `${remaining.length - i} Land/Laender ungeprueft.`);
          break;
        }
        const batch = remaining.slice(i, i + EXPANSION_BATCH_SIZE);
        const batchStart = Date.now();
        const batchResults = await Promise.all(batch.map((c) => fetchAndStream(c, EXPANSION_ATTEMPTS)));
        results.push(...batchResults);
        // Schaetzung fortschreiben: gemessene Dauer plus Sicherheitsaufschlag. Wir nehmen den
        // groesseren Wert aus alter und neuer Schaetzung nicht - sonst zieht ein einzelner
        // Ausreisser die Planung dauerhaft nach oben und wir pruefen weniger Laender als moeglich.
        batchEstimateMs = Math.round((Date.now() - batchStart) * BATCH_ESTIMATE_SAFETY);
      }
      summary = parser.summarize(results, baselineCountry);
    }

    // Die Zimmerliste haengt jetzt einmal an summary.diagnose; an den einzelnen Laendern
    // waere sie nur Ballast in der Antwort (und im Cache).
    for (const r of results) delete r.diagnose;

    const bytesGesamt = results.reduce((s, r) => s + (r.transferBytes || 0), 0);
    const payload = { ...summary, partial, resultId, countries: laender };
    if (summary.success) {
      await store.cacheSet(cacheKey, { ...summary, partial, countries: laender });
      // Permalink: dasselbe Ergebnis ohne Link und ohne Zimmername-Freitext, aber mit dem, was
      // ein Empfaenger zum Einordnen braucht (Hotelname, Hotelland, Zimmer, Verpflegung).
      await store.resultSpeichern(resultId, {
        ...summary, partial, countries: laender,
        hotelName: cfg.hotelNameAusLink(link), hotelLand: cfg.hotelLandAusLink(link),
        room, board, cancel, device: deviceLabel, datum: new Date().toISOString().slice(0, 10),
      });
      // Jede (neue) erfolgreiche Abfrage in die Google-Tabelle loggen - als Deal-Sammlung.
      const baseRow = results.find((r) => r.country === baselineCountry);
      const best = summary.best;
      const basePrice = baseRow && baseRow.priceEuro != null ? baseRow.priceEuro : null;
      const ersparnisEuro = basePrice != null && best.priceEuro != null ? Math.round((basePrice - best.priceEuro) * 100) / 100 : null;
      await store.logQuery({
        hotelLink: cfg.linkFuersLog(link),
        room: room || '',
        board: LOG_BOARD_LABEL[board] || board || '',
        cancel: LOG_CANCEL_LABEL[cancel] || cancel || '',
        baselineLand: LOG_COUNTRY_LABEL[baselineCountry] || baselineCountry,
        baselinePreisEuro: basePrice != null ? basePrice : '',
        bestesLand: LOG_COUNTRY_LABEL[best.country] || best.country,
        bestPreisEuro: best.priceEuro != null ? best.priceEuro : '',
        bestPreisVorOrt: best.priceLocal != null ? `${best.priceLocal} ${best.currency}` : '',
        ersparnisProzent: summary.savingsPct != null ? summary.savingsPct : '',
        ersparnisEuro: ersparnisEuro != null ? ersparnisEuro : '',
        // "ja" nur bei einem Unterschied, der kein Rundungsrauschen ist - so laesst sich die
        // Tabelle nach echten Funden filtern, statt 0,1-%-Treffer mitzuzaehlen.
        relevant: summary.relevantSaving ? 'ja' : 'nein',
        empfehlung: summary.recommendVpnCountry ? 'ja' : 'nein',
        herkunftsland,
        alleLaender: cfg.alleLaenderFuersLog(results, laender),
        hotelLand: cfg.hotelLandAusLink(link),
        // Bei einem gekuerzten Lauf gehoert in die Tabelle, WIE stark gekuerzt wurde - sonst
        // laesst sich spaeter nicht beurteilen, ob ein "kein Fund" belastbar ist.
        // Dazu der Proxy-Verbrauch dieser Abfrage: Nur so laesst sich sehen, was eine Suche
        // wirklich kostet, ohne es jedes Mal aus dem Smartproxy-Dashboard zurueckzurechnen.
        // Das Geraet gehoert mit in die Zeile: Ohne diese Angabe liessen sich Desktop- und
        // Mobil-Messungen in der Tabelle spaeter nicht mehr auseinanderhalten.
        status: (partial ? `ok (nur ${results.length} von ${laender.length} Ländern – Zeitlimit)` : 'ok')
          + ` · ${deviceLabel}`
          + ` · ${Math.round(bytesGesamt / (1024 * 1024))} MB`
          + (laender.length < ALL_COUNTRIES.length ? ' · Länderauswahl' : ''),
      });
      // Best-of nur bei echten Funden und nur anonymisiert (siehe lib/store.js).
      if (summary.relevantSaving && basePrice != null && ersparnisEuro != null) {
        await store.bestofSpeichern({
          hotel: cfg.hotelNameAusLink(link), hotelLand: cfg.hotelLandAusLink(link),
          land: best.country, baseline: baselineCountry,
          pct: summary.savingsPct, euro: ersparnisEuro, basisEuro: basePrice,
          umgerechnet: !!summary.convertedCurrency, datum: new Date().toISOString().slice(0, 10), resultId,
        });
      }
    } else {
      // Im Log festhalten, ob der Link Reisedaten enthielt. Ohne checkin/checkout sucht Booking
      // sich selbst einen Termin und zeigt haeufig gar keine Zimmertabelle - das war am 17.09.
      // die Ursache saemtlicher Fehlschlaege. So laesst sich spaeter auszaehlen, wie oft es
      // wirklich daran liegt, statt es zu vermuten.
      const hatDatum = /[?&](checkin|checkout)=/i.test(link) || /[?&]checkin_year=/i.test(link);
      await logAttempt(hatDatum ? 'kein Preis gefunden' : 'kein Preis gefunden (Link ohne Reisedaten)',
        { baselineLand: LOG_COUNTRY_LABEL[baselineCountry] || baselineCountry });
    }
    await store.tagesstatistikSchreiben({ erfolg: summary.success, fund: !!summary.relevantSaving, bytes: bytesGesamt });
    respond(200, payload);
  } catch (err) {
    try {
      await logAttempt('Fehler: ' + String((err && err.message) || err).slice(0, 120));
      await store.tagesstatistikSchreiben({ erfolg: false, fund: false, bytes: results.reduce((s, r) => s + (r.transferBytes || 0), 0) });
    } catch (e) { /* Logging ist optional */ }
    respond(200, fehlerAntwort(err));
  } finally {
    await browser.sharedBrowserSchliessen();
  }
};
