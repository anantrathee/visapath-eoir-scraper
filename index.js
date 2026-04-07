const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.use(express.json());

const PROXY = 'http://5928d06d6d0c3a97cb03:398ce2c56c9e1c67@gw.dataimpulse.com:823';

app.get('/', (req, res) => res.json({ status: 'EOIR scraper running', version: '4.0.0' }));

app.post('/lookup', async (req, res) => {
  const { aNbr, nationality } = req.body;
  if (!aNbr || !nationality) return res.status(400).json({ error: 'aNbr and nationality required' });
  const digits = aNbr.replace(/[^0-9]/g, '');
  const normalized = digits.length === 8 ? '0' + digits : digits.padStart(9, '0');

  const agent = new HttpsProxyAgent(PROXY);

  // Try multiple known ACIS endpoints
  const endpoints = [
    {
      method: 'POST',
      url: 'https://acis.eoir.justice.gov/api/caseInformation',
      data: { aNbr: normalized, nationality },
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    },
    {
      method: 'GET', 
      url: `https://acis.eoir.justice.gov/api/cases/${normalized}`,
      headers: { 'Accept': 'application/json' }
    },
    {
      method: 'POST',
      url: 'https://acis.eoir.justice.gov/en/caseInformation',
      data: new URLSearchParams({ aNbr: normalized, nationality }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/html' }
    },
  ];

  for (const ep of endpoints) {
    try {
      console.log('Trying:', ep.url);
      const config = {
        method: ep.method,
        url: ep.url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://acis.eoir.justice.gov',
          'Referer': 'https://acis.eoir.justice.gov/en/caseInformation/',
          'X-Requested-With': 'XMLHttpRequest',
          ...ep.headers,
        },
        httpsAgent: agent,
        timeout: 20000,
      };
      if (ep.data) config.data = ep.data;
      const response = await axios(config);
      console.log('Success from:', ep.url, 'status:', response.status);
      console.log('Data:', JSON.stringify(response.data).substring(0, 300));
      return res.json({ success: true, normalized, endpoint: ep.url, data: response.data });
    } catch (err) {
      console.log('Failed:', ep.url, err.response?.status || err.message);
    }
  }

  return res.json({ success: false, fallback: true, normalized, message: 'All endpoints blocked' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('EOIR scraper v4 on port ' + PORT));
