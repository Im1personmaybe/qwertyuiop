const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

setInterval(() => console.log('alive:', new Date().toISOString()), 5 * 60 * 1000);

function fetchUrl(targetUrl, callback) {
  try {
    const parsed = new URL(targetUrl);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
      }
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => callback(null, res, data));
    });

    req.on('error', err => callback(err));
    req.on('timeout', () => { req.destroy(); callback(new Error('timeout')); });
    req.end();

  } catch (err) { callback(err); }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive' }));
    return;
  }

  // CUSTOM SEARCH ENDPOINT - fetches Bing and returns proxied results
  if (parsed.pathname === '/search') {
    const query = parsed.query.q;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?q=' }));
      return;
    }

    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    
    fetchUrl(searchUrl, (err, proxyRes, data) => {
      if (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const proxyBase = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

      // Extract search results and build our own clean HTML
      // This avoids Bing's complex JS and tracking
      let results = [];
      
      // Extract titles and URLs from Bing results
      const titleRegex = /<a[^>]*href="([^"]+)"[^>]*h="[^"]*"[^>]*>(.*?)<\/a>/gi;
      let match;
      while ((match = titleRegex.exec(data)) !== null) {
        const href = match[1];
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (href && title && href.startsWith('http') && !href.includes('bing.com') && title.length > 3) {
          results.push({ url: href, title });
        }
      }

      // Build clean search results page
      let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Search: ${query}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #e0e0e0; padding: 20px; max-width: 800px; margin: 0 auto; }
    h1 { color: #6366f1; margin-bottom: 20px; font-size: 24px; }
    .query { color: #888; margin-bottom: 30px; }
    .result { background: #2a2a2a; border: 1px solid #444; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .result a { color: #818cf8; text-decoration: none; font-size: 16px; font-weight: 500; }
    .result a:hover { text-decoration: underline; }
    .result .url { color: #22c55e; font-size: 12px; margin-top: 4px; word-break: break-all; }
    .no-results { color: #888; text-align: center; margin-top: 40px; }
  </style>
</head>
<body>
  <h1>🔍 Search Results</h1>
  <p class="query">Query: "${query}"</p>`;

      if (results.length === 0) {
        html += `<p class="no-results">No results found. Try a different search.</p>`;
      } else {
        // Deduplicate
        const seen = new Set();
        results.forEach(r => {
          if (!seen.has(r.url)) {
            seen.add(r.url);
            const proxiedUrl = `${proxyBase}/proxy?url=${encodeURIComponent(r.url)}`;
            html += `<div class="result">
              <a href="${proxiedUrl}">${r.title}</a>
              <p class="url">${r.url}</p>
            </div>`;
          }
        });
      }

      html += `</body></html>`;

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(html);
    });
    return;
  }

  // PROXY ENDPOINT
  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?url=' }));
      return;
    }

    fetchUrl(target, (err, proxyRes, data) => {
      if (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const contentType = proxyRes.headers['content-type'] || '';
      const proxyBase = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

      if (contentType.includes('text/html')) {
        const base = new URL(target);

        // Relative URLs -> proxy
        data = data.replace(
          /(href|src|action)=["'](?!https?:\/\/|\/\/|#|javascript:|mailto:|data:|about:)([^"']*)["']/gi,
          (match, attr, path) => {
            try {
              const abs = new URL(path, base).href;
              return `${attr}="${proxyBase}/proxy?url=${encodeURIComponent(abs)}"`;
            } catch (e) { return match; }
          }
        );

        // ALL absolute URLs -> proxy
        data = data.replace(
          /(href|src|action)=["'](https?:\/\/[^"']+)["']/gi,
          (match, attr, u) => {
            if (u.includes(req.headers.host + '/proxy?url=')) return match;
            return `${attr}="${proxyBase}/proxy?url=${encodeURIComponent(u)}"`;
          }
        );

        // Meta refresh
        data = data.replace(
          /content=["']0;\s*url=([^"']+)["']/gi,
          (match, u) => {
            try {
              const abs = new URL(u, base).href;
              return `content="0;url=${proxyBase}/proxy?url=${encodeURIComponent(abs)}"`;
            } catch (e) { return match; }
          }
        );

        // Base tag
        data = data.replace(
          /<base\s+href=["']([^"']+)["']/i,
          (match, baseHref) => {
            try {
              const abs = new URL(baseHref, base).href;
              return `<base href="${proxyBase}/proxy?url=${encodeURIComponent(abs)}"`;
            } catch (e) { return match; }
          }
        );
      }

      res.writeHead(proxyRes.statusCode, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`Prøxy on ${PORT}`));
