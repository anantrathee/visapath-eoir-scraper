const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { Solver } = require('2captcha-ts');

const app = express();
app.use(express.json());
const solver = new Solver(process.env.CAPTCHA_API_KEY || 'dc371c50f5952790ad18e2617b7e9641');

app.get('/', (req, res) => res.json({ status: 'EOIR scraper running', version: '10.0.0' }));

app.post('/lookup', async (req, res) => {
  const { aNbr, nationality } = req.body;
  if (!aNbr || !nationality) return res.status(400).json({ error: 'required' });
  const digits = aNbr.replace(/[^0-9]/g, '');
  const normalized = digits.length === 8 ? '0' + digits : digits.padStart(9, '0');

  let browser;
  try {
    const execPath = await chromium.executablePath();
    browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath: execPath,
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const page = await browser.newPage();
    
    // Intercept all network requests to find the API call
    const apiResponses = [];
    await page.setRequestInterception(true);
    page.on('request', req => req.continue());
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('acis.eoir') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png')) {
        try {
          const text = await response.text();
          if (text.length > 10 && text.length < 10000) {
            apiResponses.push({ url, status: response.status(), body: text.substring(0, 500) });
            console.log('API call:', url, 'status:', response.status(), 'body:', text.substring(0, 200));
          }
        } catch(e) {}
      }
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    console.log('Loading ACIS...');
    await page.goto('https://acis.eoir.justice.gov/en/caseInformation/', {
      waitUntil: 'networkidle0', timeout: 30000
    });

    // Accept disclaimer
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button,a')).some(el => el.innerText.includes('ACCEPT')),
        { timeout: 5000 }
      );
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button,a')).find(el => el.innerText.includes('ACCEPT'));
        if (btn) btn.click();
      });
      console.log('Accepted disclaimer');
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
    } catch(e) { console.log('No disclaimer'); }

    // Wait for form with networkidle
    await page.waitForFunction(
      () => document.querySelectorAll('input, select').length > 0,
      { timeout: 15000 }
    ).catch(() => console.log('Form not found after wait'));

    const formInfo = await page.evaluate(() => ({
      inputs: document.querySelectorAll('input').length,
      selects: document.querySelectorAll('select').length,
      url: window.location.href,
      bodyLength: document.body.innerHTML.length,
    }));
    console.log('Form info:', JSON.stringify(formInfo));
    console.log('API responses so far:', JSON.stringify(apiResponses));

    res.json({ success: true, normalized, formInfo, apiResponses });
  } catch (err) {
    console.error('Error:', err.message);
    res.json({ success: false, error: err.message, normalized });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('EOIR scraper v10 on port ' + PORT));
