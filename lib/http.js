// HTTP-Hilfen von GeoRates: CORS, Client-IP, Turnstile.

const crypto = require('crypto');

// ---- Cloudflare Turnstile Bot-Check -----------------------------------------------------

async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // nicht konfiguriert -> Check übersprungen (Setup noch offen)
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp || '' }),
    });
    const json = await res.json();
    return !!json.success;
  } catch (e) {
    return false;
  }
}


// CORS: nur die eigene Seite darf den Endpunkt aus dem Browser aufrufen. Das schuetzt NICHT vor
// Skripten (curl kennt kein CORS) - dafuer sind Turnstile, Zaehlbremsen und Tagesdeckel da.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://georates.tech';
function setCors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', methods || 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GeoRates-Debug');
}

// Vercel setzt x-forwarded-for am Edge; der erste Eintrag ist der Client.
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

// Debug-Schalter (Seitentext, Mobilprofile, noScripts) nur mit Geheimwort im Header. Vorher
// konnte jeder Aufrufer sie setzen - sie kosten zusaetzlichen Proxy-Traffic und geben den
// geladenen Seitentext zurueck. Ohne gesetztes DEBUG_SECRET bleibt Debug komplett aus.
//
// Die Funktion sagt jetzt IM LOG, warum sie ablehnt. Am 20.09.2026 hat genau das gefehlt: Der
// Endpunkt antwortete nur mit "bot_check_failed", und ob das Secret fehlte, der Header
// unterwegs veraendert wurde oder ein Tippfehler vorlag, war von aussen nicht zu unterscheiden.
// Geloggt werden ausschliesslich Laengen und die Frage "rein ASCII?" - nie ein Zeichen des
// Wertes selbst, weder vom erwarteten noch vom geschickten.
//
// ASCII ist relevant, weil HTTP-Header keine Umlaute vertragen: Ein "ö" im Secret wird je nach
// Zwischenschicht als ein Byte (Latin-1) oder als zwei Bytes (UTF-8) uebertragen. Dann stimmt
// die Zeichenzahl noch, die Bytezahl aber nicht mehr.
function debugErlaubt(req) {
  const secret = process.env.DEBUG_SECRET;
  const got = String(req.headers['x-georates-debug'] || '');
  const nurAscii = (s) => /^[\x20-\x7E]*$/.test(s);

  if (!secret) {
    if (got) console.log('[http] Debug-Header geschickt, aber DEBUG_SECRET ist in dieser Umgebung nicht gesetzt (Redeploy vergessen?).');
    return false;
  }
  if (!got) return false;

  if (got.length !== secret.length) {
    console.log(`[http] Debug-Header abgelehnt: ${got.length} Zeichen geschickt, ${secret.length} erwartet. `
      + `Geschickt rein ASCII: ${nurAscii(got)}, Secret rein ASCII: ${nurAscii(secret)}.`);
    return false;
  }

  // Byteweise vergleichen. Zwei Werte koennen gleich viele ZEICHEN und trotzdem verschieden
  // viele BYTES haben (Umlaute). timingSafeEqual wirft bei ungleich langen Puffern eine
  // Ausnahme - und diese Funktion laeuft ganz am Anfang des Handlers, ausserhalb jedes try.
  // Ohne die Laengenpruefung haette ein Umlaut im Secret die Anfrage mit 500 beendet.
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) {
    console.log(`[http] Debug-Header abgelehnt: gleiche Zeichenzahl, aber ${a.length} statt ${b.length} Bytes. `
      + `Geschickt rein ASCII: ${nurAscii(got)}, Secret rein ASCII: ${nurAscii(secret)}. `
      + 'Vermutlich ein Nicht-ASCII-Zeichen im Secret - bitte nur Buchstaben und Ziffern verwenden.');
    return false;
  }

  const ok = crypto.timingSafeEqual(a, b);
  if (!ok) console.log('[http] Debug-Header abgelehnt: richtige Laenge, aber falscher Wert.');
  return ok;
}

module.exports = { verifyTurnstile, setCors, clientIp, debugErlaubt };
