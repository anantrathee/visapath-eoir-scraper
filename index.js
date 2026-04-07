const express = require('express');
const puppeteer = require('puppeteer');

const { Solver } = require('2captcha-ts');

const app = express();
app.use(express.json());
const solver = new Solver(process.env.CAPTCHA_API_KEY || 'dc371c50f5952790ad18e2617b7e9641');

app.get('/', (req, res) => res.json({ status: 'EOIR scraper running', version: '9.0.0' }));

app.post('/lookup', async (req, res) => {
  const { aNbr, nationality } = req.body;
  if (!aNbr || !nationality) return res.status(400).json({ error: 'required' });
  const digits = aNbr.replace(/[^0-9]/g, '');
  const normalized = digits.length === 8 ? '0' + digits : digits.padStart(9, '0');

  let browser;
  try {
    console.log('v9 - full puppeteer, no proxy');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--ignore-certificate-errors',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();
    // Enable JavaScript explicitly
    await page.setJavaScriptEnabled(true);
    // Hide automation
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');

    console.log('Loading ACIS no proxy...');
    await page.goto('https://acis.eoir.justice.gov/en/caseInformation/', {
      waitUntil: 'networkidle2', timeout: 30000
    });

    console.log('Title:', await page.title());
    
    // Click I ACCEPT disclaimer if present
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button,a')).some(el => el.innerText.includes('ACCEPT')),
        { timeout: 5000 }
      );
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button,a')).find(el => el.innerText.includes('ACCEPT'));
        if (btn) btn.click();
      });
      console.log('Clicked I ACCEPT');
      // Navigate directly to case information form after accepting disclaimer
      await page.goto('https://acis.eoir.justice.gov/en/caseInformation/', {
        waitUntil: 'networkidle2', timeout: 15000
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      console.log('Navigated to case form, title:', await page.title());
    } catch(e) { console.log('No disclaimer found'); }

    // Wait for React to render
    await new Promise(r => setTimeout(r, 3000));
    
    // Wait longer for React to render
    await new Promise(r => setTimeout(r, 5000));
    
    const pageInfo = await page.evaluate(() => {
      const sitekey = document.querySelector('[data-sitekey]');
      const input = document.querySelector('input');
      const select = document.querySelector('select');
      const allInputs = document.querySelectorAll('input, select, button, form');
      return {
        sitekey: sitekey ? sitekey.getAttribute('data-sitekey') : null,
        hasInput: !!input,
        inputType: input ? input.type : null,
        hasSelect: !!select,
        elementCount: allInputs.length,
        htmlSnippet: document.documentElement.innerHTML.substring(0, 800),
        bodySnippet: document.body.innerText.substring(0, 300),
      };
    });
    
    console.log('Page info:', JSON.stringify(pageInfo).substring(0, 500));

    if (pageInfo.sitekey) {
      console.log('Solving hCaptcha...');
      const solution = await solver.hcaptcha({
        pageurl: 'https://acis.eoir.justice.gov/en/caseInformation/',
        sitekey: pageInfo.sitekey,
      });
      await page.evaluate((token) => {
        const t = document.querySelector('[name="h-captcha-response"]');
        if (t) { t.value = token; t.dispatchEvent(new Event('change')); }
        const el = document.querySelector('.h-captcha');
        if (el && el.dataset.callback && window[el.dataset.callback]) window[el.dataset.callback](token);
      }, solution.data);
      console.log('Captcha solved, waiting...');
      await new Promise(r => setTimeout(r, 2000));
    }

    // Fill A-Number
    const inputs = await page.$$('input');
    for (const input of inputs) {
      const type = await input.evaluate(el => el.type);
      if (type === 'tel' || type === 'text' || type === 'number') {
        await input.click({ clickCount: 3 });
        await input.type(normalized, { delay: 50 });
        console.log('Filled A-Number:', normalized);
        break;
      }
    }

    // Select nationality
    const selects = await page.$$('select');
    for (const sel of selects) {
      const matched = await sel.evaluate((el, nat) => {
        const o = Array.from(el.options).find(o => 
          o.text.toLowerCase().includes(nat.toLowerCase()) ||
          o.value.toLowerCase().includes(nat.toLowerCase())
        );
        if (o) { el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); return o.text; }
        return null;
      }, nationality);
      if (matched) { console.log('Nationality selected:', matched); break; }
    }

    // Submit
    const btn = await page.$('button[type="submit"]') || await page.$('button');
    if (btn) { await btn.click(); console.log('Submitted'); }

    // Wait for results
    await page.waitForFunction(() => {
      const t = document.body.innerText;
      return t.includes('Hearing') || t.includes('No case') || t.includes('pending') || 
             t.includes('CLOSED') || t.includes('Judge');
    }, { timeout: 15000 }).catch(() => console.log('Timeout waiting for results'));

    const result = await page.evaluate(() => {
      const b = document.body.innerText;
      console.log('Final body length:', b.length);
      if (b.toLowerCase().includes('no case found')) return { found: false, message: 'No case found.' };
      const d = b.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
      const t = b.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i);
      const j = b.match(/(?:Judge|JUDGE)[^\n]*\n([^\n]+)/i);
      const a = b.match(/(?:Court Address|COURT ADDRESS)[^\n]*\n([^\n]+)/i);
      const s = b.match(/(administratively CLOSED|This case is pending|GRANTED|DENIED)/i);
      const tp = b.match(/(INDIVIDUAL|MASTER|IN PERSON|TELEPHONIC|VIDEO)/i);
      return {
        found: !!(d || j || a || s),
        nextHearing: d ? { date: d[0], time: t ? t[0] : null, type: tp ? tp[1] : null } : null,
        judge: j ? j[1].trim() : null,
        courtAddress: a ? a[1].trim() : null,
        status: s ? s[1].trim() : 'Pending',
        rawText: b.substring(0, 2000),
      };
    });

    console.log('Final result:', JSON.stringify(result).substring(0, 200));
    res.json({ success: true, normalized, data: result });
  } catch (err) {
    console.error('Error:', err.message);
    res.json({ success: false, error: err.message, fallback: true, normalized });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('EOIR scraper v8 on port ' + PORT));
