const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_PATH = '/proxy/';

app.use(express.static('public'));

// Simple homepage
app.get('/', (req, res) => {
  res.send(`
    <h1>Proxy Backend Server</h1>
    <p>Use: <code>/proxy/https://example.com</code></p>
    <p>Search: <code>/search?q=your query</code></p>
    
    <h2>Supported Sites</h2>
    <ul>
      <li><a href="/proxy/https://youtube.com">YouTube</a></li>
      <li><a href="/proxy/https://reddit.com">Reddit</a></li>
      <li><a href="/proxy/https://discord.com">Discord</a></li>
    </ul>

    <form action="/search">
      <input name="q" placeholder="Search DuckDuckGo" style="padding:8px; width:300px;" />
      <button type="submit" style="padding:8px;">Search</button>
    </form>

    <p style="margin-top:30px; color:#666;">
      <strong>PROXIED through backend server</strong>
    </p>
  `);
});

// DuckDuckGo Search
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).send('Query required');

  try {
    const response = await axios.get(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    let html = response.data;

    // Rewrite links to use our proxy
    html = html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
      return `href="${PROXY_PATH}${url}"`;
    });

    res.send(`
      <h1>Search: ${query}</h1>
      ${html}
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send('Search failed');
  }
});

// Main proxy handler
app.use(PROXY_PATH, async (req, res) => {
  let targetUrl = req.url.slice(1); // remove leading /

  if (!targetUrl.startsWith('http')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    if (contentType.includes('text/html')) {
      let html = response.data.toString();
      const $ = cheerio.load(html);

      // Rewrite resources
      $('a[href], link[href], script[src], img[src], source[src], iframe[src], video[src]').each((i, el) => {
        const attr = el.attribs.src || el.attribs.href;
        if (!attr || attr.startsWith('#') || attr.startsWith('data:')) return;

        let fullUrl = attr;
        if (attr.startsWith('//')) fullUrl = 'https:' + attr;
        else if (!attr.startsWith('http')) {
          fullUrl = new URL(attr, targetUrl).href;
        }

        const proxyUrl = `${PROXY_PATH}${fullUrl}`;
        if (el.attribs.src) el.attribs.src = proxyUrl;
        if (el.attribs.href) el.attribs.href = proxyUrl;
      });

      $('head').prepend(`<base href="${targetUrl}">`);

      // Yellow banner
      $('body').prepend(`
        <div style="background:#ff0;color:#000;padding:12px;text-align:center;position:fixed;top:0;left:0;right:0;z-index:9999;font-weight:bold;">
          PROXIED through backend server | <a href="/" style="color:#000;">Home</a>
        </div>
      `);

      html = $.html();
      res.send(html);
    } 
    else if (contentType.includes('text/css')) {
      let css = response.data.toString();
      css = css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
        if (url.startsWith('data:')) return match;
        let fullUrl = url.startsWith('http') ? url : new URL(url, targetUrl).href;
        return `url(${PROXY_PATH}${fullUrl})`;
      });
      res.send(css);
    } 
    else if (contentType.includes('javascript')) {
      let js = response.data.toString();
      js = js.replace(/"(https?:\/\/[^"]+)"/g, `"${PROXY_PATH}$1"`);
      js = js.replace(/'(https?:\/\/[^']+)'/g, `'${PROXY_PATH}$1'`);
      res.send(js);
    } 
    else {
      res.send(response.data);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send(`Proxy error: ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on port ${PORT}`);
});
