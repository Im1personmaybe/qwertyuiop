const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();
const PORT = 3000;

// Base proxy path
const PROXY_PATH = '/proxy/';

// Middleware to serve static files (optional UI)
app.use(express.static('public'));

// Simple homepage with instructions
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
      <li><a href="/proxy/https://snapchat.com">Snapchat</a> (limited)</li>
    </ul>
    <form action="/search">
      <input name="q" placeholder="Search DuckDuckGo" />
      <button type="submit">Search</button>
    </form>
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
    res.status(500).send('Search failed');
  }
});

// Main proxy handler
app.use(PROXY_PATH, async (req, res, next) => {
  let targetUrl = req.url.slice(1); // remove leading /
  
  if (!targetUrl.startsWith('http')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProxyBot/1.0)'
      }
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // HTML processing
    if (contentType.includes('text/html')) {
      let html = response.data.toString();
      const $ = cheerio.load(html);

      // Rewrite all links, scripts, images, etc.
      $('a[href], link[href], script[src], img[src], source[src], iframe[src]').each((i, el) => {
        const attr = el.attribs.src || el.attribs.href;
        if (attr && !attr.startsWith('#') && !attr.startsWith('data:')) {
          let fullUrl;
          if (attr.startsWith('//')) fullUrl = 'https:' + attr;
          else if (attr.startsWith('/')) fullUrl = new URL(attr, targetUrl).href;
          else if (!attr.startsWith('http')) fullUrl = new URL(attr, targetUrl).href;
          else fullUrl = attr;

          const proxyUrl = `${PROXY_PATH}${fullUrl}`;
          if (el.attribs.src) el.attribs.src = proxyUrl;
          if (el.attribs.href) el.attribs.href = proxyUrl;
        }
      });

      // Base tag for relative paths
      $('head').prepend(`<base href="${targetUrl}">`);
      
      // Add warning banner
      $('body').prepend(`
        <div style="background:#ff0;color:#000;padding:10px;text-align:center;position:fixed;top:0;left:0;right:0;z-index:9999;">
          <strong>PROXIED through backend server</strong> | 
          <a href="/">Home</a>
        </div>
      `);

      html = $.html();
      res.send(html);
    } 
    // CSS processing - rewrite urls()
    else if (contentType.includes('text/css')) {
      let css = response.data.toString();
      css = css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
        if (url.startsWith('data:')) return match;
        let fullUrl = url;
        if (!url.startsWith('http')) {
          fullUrl = new URL(url, targetUrl).href;
        }
        return `url(${PROXY_PATH}${fullUrl})`;
      });
      res.send(css);
    } 
    // JS - very limited rewriting
    else if (contentType.includes('javascript')) {
      let js = response.data.toString();
      // Basic string URL rewriting (imperfect)
      js = js.replace(/"(https?:\/\/[^"]+)"/g, `"${PROXY_PATH}$1"`);
      js = js.replace(/'(https?:\/\/[^']+)'/g, `'${PROXY_PATH}$1'`);
      res.send(js);
    } 
    else {
      // Images, fonts, videos, etc. - pass through
      res.send(response.data);
    }
  } catch (error) {
    console.error(error);
    res.status(500).send(`Proxy error: ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running at http://localhost:${PORT}`);
  console.log(`Example: http://localhost:${PORT}/proxy/https://youtube.com`);
});
