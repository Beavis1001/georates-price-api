// HTTP-Hilfen von GeoRates: CORS, Client-IP, Turnstile.

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
function debugErlaubt(req) {
  const secret = process.env.DEBUG_SECRET;
  if (!secret) return false;
  const got = String(req.headers['x-georates-debug'] || '');
  return got.length === secret.length && require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

module.exports = { verifyTurnstile, setCors, clientIp, debugErlaubt };
