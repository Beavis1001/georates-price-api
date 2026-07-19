// Serverless Function: versucht den Gesamtpreis einer Booking.com-Seite fuer gegebene
// Reisedaten automatisch auszulesen (Headless-Chrome-Rendering, da Booking.com Preise
// per JavaScript nachlaedt). Bewusst "best effort": Booking.com hat Bot-Schutz und aendert
// seine Seitenstruktur regelmaessig, daher schlaegt das hier und da fehl - genau dafuer
// gibt es auf der Website den Fallback auf die manuelle Pruefung per E-Mail.

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

function buildUrlWithDates(link, checkin, checkout) {
  try {
    const url = new URL(link);
    if (checkin) url.searchParams.set('checkin', checkin);
    if (checkout) url.searchParams.set('checkout', checkout);
    if (!url.searchParams.get('group_adults')) url.searchParams.set('group_adults', '2');
    if (!url.searchParams.get('no_rooms')) url.searchParams.set('no_rooms', '1');
    return url.toString();
  } catch (e) {
    return link;
  }
}

module.exports = async (req, res) => {
  // Nur Anfragen von der eigenen Website erlauben
  res.setHeader('Access-Control-Allow-Origin', 'https://georates.tech');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, reason: 'method_not_allowed' });
    return;
  }

  const { link, checkin, checkout } = req.body || {};
  if (!link || !/^https?:\/\/([a-z0-9-]+\.)*booking\.com\//i.test(link)) {
    res.status(400).json({ success: false, reason: 'invalid_link' });
    return;
  }

  const targetUrl = buildUrlWithDates(link, checkin, checkout);
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Cookie-Banner wegklicken, falls vorhanden (sonst kann er Elemente verdecken)
    try {
      await page.click('#onetrust-accept-btn-handler', { timeout: 3000 });
    } catch (e) {
      /* kein Banner sichtbar - ignorieren */
    }

    // Preis-Selektoren: Booking.com aendert diese erfahrungsgemaess regelmaessig,
    // daher mehrere Kandidaten nacheinander probieren.
    const priceSelectors = [
      '[data-testid="price-and-discounted-price"]',
      '[data-testid="availability-rate-price"]',
      '.prco-valign-middle-helper',
    ];

    let price = null;
    for (const sel of priceSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        price = await page.$eval(sel, (el) => el.textContent.trim());
        if (price) break;
      } catch (e) {
        /* naechsten Selektor versuchen */
      }
    }

    await browser.close();

    if (!price) {
      res.status(200).json({ success: false, reason: 'price_not_found', checkedUrl: targetUrl });
      return;
    }
    res.status(200).json({ success: true, price, checkedUrl: targetUrl });
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignorieren */ }
    }
    const message = String((err && err.message) || err);
    const blocked = /timeout|blocked|net::|captcha/i.test(message);
    res.status(200).json({
      success: false,
      reason: blocked ? 'blocked_or_timeout' : 'error',
      message,
    });
  }
};
