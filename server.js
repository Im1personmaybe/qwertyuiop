const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Keep-alive ping to prevent Render from sleeping too fast
setInterval(() => {
  console.log('Keep-alive:', new Date().toISOString());
}, 5 * 60 * 1000); // Log every 5 minutes

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  // Health check
  if (parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', time: new Date().toISOString() }));
    return;
  }

  // Proxy endpoint
  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
      return;
    }

    try {
      const targetUrl = new URL(target);
      const protocol = targetUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Cache-Control': 'max-age=0'
        }
      };

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const proxyReq = protocol.request(options, (proxyRes) => {
          const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS'
          };

          ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'content-language'].forEach(h => {
            if (proxyRes.headers[h]) headers[h] = proxyRes.headers[h];
          });

          if (proxyRes.headers['set-cookie']) {
            headers['set-cookie'] = proxyRes.headers['set-cookie'];
          }

          res.writeHead(proxyRes.statusCode, headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          console.error('Proxy error:', err.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to reach target', details: err.message }));
          }
        });

        proxyReq.on('timeout', () => {
          proxyReq.destroy();
          if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gateway timeout' }));
          }
        });

        if (body) proxyReq.write(body);
        proxyReq.end();
      });

    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid URL', details: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Prøxy running on port ${PORT}`);
});
