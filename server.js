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

        // 1. Relative URLs -> proxy
        data = data.replace(
          /(href|src|action)=["'](?!https?:\/\/|\/\/|#|javascript:|mailto:|data:|about:)([^"']*)["']/gi,
          (match, attr, path) => {
            try {
              const abs = new URL(path, base).href;
              return `${attr}="${proxyBase}/proxy?url=${encodeURIComponent(abs)}"`;
            } catch (e) { return match; }
          }
        );

        // 2. ALL absolute URLs -> proxy (this is the key fix)
        data = data.replace(
          /(href|src|action)=["'](https?:\/\/[^"']+)["']/gi,
          (match, attr, u) => {
            // Don't re-proxy already-proxied URLs or special schemes
            if (u.includes(req.headers.host + '/proxy?url=')) return match;
            return `${attr}="${proxyBase}/proxy?url=${encodeURIComponent(u)}"`;
          }
        );

        // 3. DuckDuckGo redirect links (uddg parameter)
        data = data.replace(
          /(href|src)=["'](https?:\/\/duckduckgo\.com\/l\/\?[^"']*uddg=([^"&]+)[^"']*)["']/gi,
          (match, attr, full, encoded) => {
            try {
              const decoded = decodeURIComponent(encoded);
              return `${attr}="${proxyBase}/proxy?url=${encodeURIComponent(decoded)}"`;
            } catch (e) { return match; }
          }
        );

        // 4. Meta refresh
        data = data.replace(
          /content=["']0;\s*url=([^"']+)["']/gi,
          (match, u) => {
            try {
              const abs = new URL(u, base).href;
              return `content="0;url=${proxyBase}/proxy?url=${encodeURIComponent(abs)}"`;
            } catch (e) { return match; }
          }
        );

        // 5. Base tag
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
