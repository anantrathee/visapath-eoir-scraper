const express = require('express');
const puppeteer = require('puppeteer');
const { Solver } = require('2captcha-ts');

const app = express();
app.use(express.json());

const solver = new Solver(process.env.CAPTCHA_API_KEY);

app.get('/', (req, res) => {
  res.json({ status: 'EOIR scraper running', version: '1.0.0' });
});

app.post('/lookup', async (req, res) => {
  const { aNbr, nationality } = req.body;
  if (!aNbr || !nationality) return res.status(400).json({ error: 'aNbr and nationality required' });

  const digits = aNbr.replace(/[^0-9]/g, '');
  const normalized = digits.length === 8 ? '0' + digits : digits.padStart(9, '0');
  if (normalized.length !== 9) return res.status(400).json({ error: 'Invalid A-Number' });

  let browser;
  try {
    console.log('Launching browser for A-' + normalized);
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-zygote','--single-process','--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
    await page.goto('https://acis.eoir.justice.gov/en/caseInformation/', { waitUntil: 'networkidle2', timeout: 30000 });

    const sitekey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });

    if (sitekey) {
      console.log('Solving hCaptcha...');
      const solution = await solver.hcaptcha({ pageurl: 'https://acis.eoir.justice.gov/en/caseInformation/', sitekey });
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
      if (type === 'tel' || type === 'text' || type === 'number') {
        await input.click({ clickCount: 3 });
        await input.type(normalized, { delay: 50 });
        break;
      }
    }

    const selects = await page.$$('select');
    for (const sel of selects) {
      const matched = await sel.evaluate((el, nat) => {
        const opts = Array.from(el.options);
        const m = opts.find(o => o.text.toLowerCase().includes(nat.toLowerCase()) || o.value.toLowerCase().includes(nat.toLowerCase()));
        if (m) { el.value = m.value; el.dispatchEvent(new Event('change', { bubbles: true })); return m.text; }
        return null;
      }, nationality);
      if (matched) { console.log('Nationality selected: ' + matched); break; }
    }

    const btn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]') || await page.$('button');
    if (btn) { await btn.click(); console.log('Submitted'); }

    await page.waitForFunction(() => {
      const t = document.body.innerText;
      return t.includes('Hearing') || t.includes('hearing') || t.includes('No case') || t.includes('Decision') || t.includes('pending') || t.includes('CLOSED');
    }, { timeout: 15000 }).catch(() => {});

    const result = await page.evaluate(() => {
      const body = document.body.innerText;
      if (body.toLowerCase().includes('no case found') || body.toLowerCase().includes('no case information')) {
        return { found: false, message: 'No case found for this A-Number and nationality.' };
      }
      const dateMatch = body.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
      const timeMatch = body.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i);
      const judgeMatch = body.match(/(?:Judge|JUDGE)[^\n]*\n([^\n]+)/i);
      const addressMatch = body.match(/(?:Court Address|COURT ADDRESS)[^\n]*\n([^\n]+)/i);
      const typeMatch = body.match(/(INDIVIDUAL|MASTER|IN PERSON|TELEPHONIC|VIDEO)/i);
      const statusMatch = body.match(/(administratively CLOSED|This case is pending|GRANTED|DENIED)/i);
      return {
        found: true,
        nextHearing: dateMatch ? { date: dateMatch[0], time: timeMatch ? timeMatch[0] : null, type: typeMatch ? typeMatch[1] : null } : null,
        judge: judgeMatch ? judgeMatch[1].trim() : null,
        courtAddress: addressMatch ? addressMatch[1].trim() : null,
        status: statusMatch ? statusMatch[1].trim() : 'Pending',
        rawText: body.substring(0, 1500),
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
app.listen(PORT, () => console.log('EOIR scraper on port ' + PORT));
