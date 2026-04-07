const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PROXY_URL = "http://5928d06d6d0c3a97cb03:398ce2c56c9e1c67@gw.dataimpulse.com:823";
const proxyAgent = new HttpsProxyAgent(PROXY_URL);
const cheerio = require('cheerio');
const { Solver } = require('2captcha-ts');

const app = express();
app.use(express.json());

const solver = new Solver(process.env.CAPTCHA_API_KEY);

app.get('/', (req, res) => res.json({ status: 'EOIR scraper running', version: '2.0.0' }));

app.get('/debug', (req, res) => res.json({ status: 'ok', approach: 'axios+cheerio, no puppeteer' }));

app.post('/lookup', async (req, res) => {
  const { aNbr, nationality } = req.body;
  if (!aNbr || !nationality) return res.status(400).json({ error: 'aNbr and nationality required' });

  const digits = aNbr.replace(/[^0-9]/g, '');
  const normalized = digits.length === 8 ? '0' + digits : digits.padStart(9, '0');
  if (normalized.length !== 9) return res.status(400).json({ error: 'Invalid A-Number' });

  try {
    console.log('Looking up A-' + normalized);

    // Try the McVCIS phone API first (no IP blocking)
    try {
      const ivrRes = await axios.post('https://acis.eoir.justice.gov/api/mcvcis', 
        { aNbr: normalized, nationality },
        {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            'Accept': 'application/json',
            'Origin': 'https://acis.eoir.justice.gov',
            'Referer': 'https://acis.eoir.justice.gov/en/caseInformation/',
          },
          timeout: 10000,
        }
      );
      if (ivrRes.data) {
        console.log('McVCIS API success:', JSON.stringify(ivrRes.data).substring(0, 200));
        return res.json({ success: true, normalized, data: ivrRes.data });
      }
    } catch (ivrErr) {
      console.log('McVCIS failed:', ivrErr.message);
    }

    // Try caseStatus endpoint
    try {
      const csRes = await axios.get(
        `https://acis.eoir.justice.gov/api/caseStatus/${normalized}?nationality=${encodeURIComponent(nationality)}`,
        {
          headers: {
            'User-Agent': 'okhttp/4.9.0',
            'Accept': 'application/json',
          },
          timeout: 10000,
        }
      );
      if (csRes.data) {
        console.log('caseStatus API:', JSON.stringify(csRes.data).substring(0, 200));
        return res.json({ success: true, normalized, data: csRes.data });
      }
    } catch (csErr) {
      console.log('caseStatus failed:', csErr.message);
    }

    // Step 1: Get the page to find sitekey and cookies
    const homeRes = await axios.get('https://acis.eoir.justice.gov/en/caseInformation/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      httpsAgent: proxyAgent,
      timeout: 20000,
    });

    const cookies = homeRes.headers['set-cookie']?.join('; ') || '';
    const $ = cheerio.load(homeRes.data);
    const sitekey = $('[data-sitekey]').attr('data-sitekey');
    console.log('Sitekey:', sitekey, 'Cookies:', cookies.substring(0, 50));

    let captchaToken = '';
    if (sitekey) {
      console.log('Solving captcha...');
      try {
        const solution = await solver.hcaptcha({
          pageurl: 'https://acis.eoir.justice.gov/en/caseInformation/',
          sitekey,
        });
        captchaToken = solution.data;
        console.log('Captcha solved');
      } catch (e) {
        console.error('Captcha failed:', e.message);
      }
    }

    // Step 2: Submit form
    const params = new URLSearchParams();
    params.append('aNbr', normalized);
    params.append('nationality', nationality);
    if (captchaToken) params.append('h-captcha-response', captchaToken);

    const lookupRes = await axios.post('https://acis.eoir.justice.gov/en/caseInformation/', params, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://acis.eoir.justice.gov/en/caseInformation/',
        'Cookie': cookies,
        'Origin': 'https://acis.eoir.justice.gov',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      httpsAgent: proxyAgent,
      timeout: 20000,
      maxRedirects: 5,
    });

    const $r = cheerio.load(lookupRes.data);
    const bodyText = $r('body').text();
    console.log('Response length:', bodyText.length);
    console.log('Body preview:', bodyText.substring(0, 300));

    // Check for API endpoint in the response JS
    const apiMatch = lookupRes.data.match(/fetch\(['"]([^'"]*caseInformation[^'"]+)['"]/);
    console.log('API match:', apiMatch ? apiMatch[1] : 'none');

    if (bodyText.toLowerCase().includes('no case found')) {
      return res.json({ success: true, normalized, data: { found: false, message: 'No case found.' } });
    }

    // Try direct API call
    try {
      const apiRes = await axios.get(`https://acis.eoir.justice.gov/api/caseInformation?aNbr=${normalized}&nationality=${encodeURIComponent(nationality)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
          'Accept': 'application/json',
          'Referer': 'https://acis.eoir.justice.gov/en/caseInformation/',
          'Cookie': cookies,
        },
        timeout: 10000,
      });
      console.log('API response:', JSON.stringify(apiRes.data).substring(0, 300));
      return res.json({ success: true, normalized, data: { found: true, raw: apiRes.data } });
    } catch (apiErr) {
      console.log('Direct API failed:', apiErr.message);
    }

    const dateMatch = bodyText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
    const judgeMatch = bodyText.match(/(?:Judge|JUDGE)[^\n]*\n([^\n]+)/i);

    if (dateMatch || judgeMatch) {
      return res.json({ success: true, normalized, data: {
        found: true,
        nextHearing: dateMatch ? { date: dateMatch[0] } : null,
        judge: judgeMatch ? judgeMatch[1].trim() : null,
        rawText: bodyText.substring(0, 1000),
      }});
    }

    // Fallback
    return res.json({ success: false, fallback: true, normalized, debug: bodyText.substring(0, 500) });

  } catch (err) {
    console.error('Error:', err.message);
    return res.json({ success: false, error: err.message, fallback: true, normalized });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('EOIR scraper v2 on port ' + PORT));
