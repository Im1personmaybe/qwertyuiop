const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Proxy is live' }));
    return;
  }

  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Need ?url=' }));
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity'
        }
      };

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const proxyReq = protocol.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': proxyRes.headers['content-type'] || 'text/html',
            'Access-Control-Allow-Origin': '*'
          });
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          res.writeHead(502);
          res.end(JSON.stringify({ error: err.message }));
        });

        if (body) proxyReq.write(body);
        proxyReq.end();
      });

    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Bad URL' }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
