const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { Solver } = require('2captcha-ts');

const app = express();
app.use(express.json());
const solver = new Solver(process.env.CAPTCHA_API_KEY || 'dc371c50f5952790ad18e2617b7e9641');
const PROXY_HOST = 'gw.dataimpulse.com:823';
const PROXY_USER = '5928d06d6d0c3a97cb03';
const PROXY_PASS = '398ce2c56c9e1c67';

async function launchBrowser(useProxy = true) {
  const args = [
    ...chromium.args,
    '--ignore-certificate-errors',
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ];
  if (useProxy) args.push('--proxy-server=http://' + PROXY_HOST);
  return puppeteer.launch({
    headless: chromium.headless,
    executablePath: await chromium.executablePath(),
    args,
  });
}

app.get('/', (req, res) => res.json({ status: 'EOIR scraper running', version: '7.0.0' }));

app.get('/test-acis-noproxy', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser(false);
    const page = await browser.newPage();
    await page.goto('https://acis.eoir.justice.gov/en/caseInformation/', { timeout: 20000 });
    const title = await page.title();
    const body = await page.evaluate(() => document.body.innerText.substring(0, 200));
    res.json({ success: true, title, body });
  } catch(err) {
    res.json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.get('/test-https', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser(false);
    const page = await browser.newPage();
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    await page.goto('https://www.google.com', { timeout: 20000 });
    const title = await page.title();
    res.json({ success: true, title });
  } catch(err) {
    res.json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.get('/test-proxy', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser(false);
    const page = await browser.newPage();
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    await page.goto('https://api.ipify.org?format=json', { timeout: 20000 });
    const ip = await page.evaluate(() => document.body.innerText);
    res.json({ success: true, ip: JSON.parse(ip) });
  } catch(err) {
    res.json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.post('/lookup', async (req, res) => {
  const { aNbr, nationality } = req.body;
  if (!aNbr || !nationality) return res.status(400).json({ error: 'required' });
  const digits = aNbr.replace(/[^0-9]/g, '');
  const normalized = digits.length === 8 ? '0' + digits : digits.padStart(9, '0');

  let browser;
  try {
    browser = await launchBrowser(false);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    console.log('Loading ACIS with proxy...');
    await page.goto('https://acis.eoir.justice.gov/en/caseInformation/', {
      waitUntil: 'networkidle2', timeout: 30000
    });

    const title = await page.title();
    console.log('Title:', title);
    
    // Wait for React app to fully render
    await new Promise(r => setTimeout(r, 3000));
    
    // Take screenshot for debugging
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 500));
    console.log('Page HTML preview:', html);

    const sitekey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });
    
    console.log('Sitekey:', sitekey);

    if (sitekey) {
      console.log('Solving captcha...');
      const solution = await solver.hcaptcha({
        pageurl: 'https://acis.eoir.justice.gov/en/caseInformation/',
        sitekey,
      });
      await page.evaluate((token) => {
        const t = document.querySelector('[name="h-captcha-response"]');
        if (t) { t.value = token; t.dispatchEvent(new Event('change')); }
        const el = document.querySelector('.h-captcha');
        if (el && el.dataset.callback && window[el.dataset.callback]) window[el.dataset.callback](token);
      }, solution.data);
      console.log('Captcha solved');
    }

    const inputs = await page.$$('input');
    for (const input of inputs) {
      const type = await input.evaluate(el => el.type);
      if (type === 'tel' || type === 'text') {
        await input.click({ clickCount: 3 });
        await input.type(normalized, { delay: 50 });
        break;
      }
    }

    const selects = await page.$$('select');
    for (const sel of selects) {
      const matched = await sel.evaluate((el, nat) => {
        const o = Array.from(el.options).find(o => o.text.toLowerCase().includes(nat.toLowerCase()));
        if (o) { el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); return o.text; }
        return null;
      }, nationality);
      if (matched) { console.log('Nationality:', matched); break; }
    }

    const btn = await page.$('button[type="submit"]') || await page.$('button');
    if (btn) { await btn.click(); console.log('Submitted'); }

    await page.waitForFunction(() => {
      const t = document.body.innerText;
      return t.includes('Hearing') || t.includes('No case') || t.includes('pending') || t.includes('CLOSED');
    }, { timeout: 15000 }).catch(() => {});

    const result = await page.evaluate(() => {
      const b = document.body.innerText;
      if (b.toLowerCase().includes('no case found')) return { found: false, message: 'No case found.' };
      const d = b.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
      const t = b.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i);
      const j = b.match(/(?:Judge|JUDGE)[^\n]*\n([^\n]+)/i);
      const a = b.match(/(?:Court Address|COURT ADDRESS)[^\n]*\n([^\n]+)/i);
      const s = b.match(/(administratively CLOSED|This case is pending|GRANTED|DENIED)/i);
      const tp = b.match(/(INDIVIDUAL|MASTER|IN PERSON|TELEPHONIC|VIDEO)/i);
      return {
        found: true,
        nextHearing: d ? { date: d[0], time: t ? t[0] : null, type: tp ? tp[1] : null } : null,
        judge: j ? j[1].trim() : null,
        courtAddress: a ? a[1].trim() : null,
        status: s ? s[1].trim() : 'Pending',
        rawText: b.substring(0, 1500),
      };
    });

    console.log('Result:', JSON.stringify(result));
    res.json({ success: true, normalized, data: result });
  } catch (err) {
    console.error('Error:', err.message);
    res.json({ success: false, error: err.message, fallback: true, normalized });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('EOIR scraper v7 on port ' + PORT));
