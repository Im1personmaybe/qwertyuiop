from pathlib import Path
p = Path('/home/ubuntu/uv-proxy.js')
s = p.read_text()
repls = {
    "html = html.replace(/<<base\\b[^>]*>/gi, '');": "html = html.replace(/<base\\b[^>]*>/gi, '');",
    "html = html.replace(/<<meta\\b[^>]*http-equiv=[\"']Content-Security-Policy[\"'][^>]*>/gi, '');": "html = html.replace(/<meta\\b[^>]*http-equiv=[\"']Content-Security-Policy[\"'][^>]*>/gi, '');",
    "html = html.replace(/<<meta\\b[^>]*http-equiv=[\"']Content-Security-Policy-Report-Only[\"'][^>]*>/gi, '');": "html = html.replace(/<meta\\b[^>]*http-equiv=[\"']Content-Security-Policy-Report-Only[\"'][^>]*>/gi, '');",
    "html = html.replace(/<<meta\\b[^>]*http-equiv=[\"']refresh[\"'][^>]*content=[\"'](\\d+);\\s*url=([^\"']*)[\"'][^>]*>/gi,": "html = html.replace(/<meta\\b[^>]*http-equiv=[\"']refresh[\"'][^>]*content=[\"'](\\d+);\\s*url=([^\"']*)[\"'][^>]*>/gi,",
    "html = html.replace(/<<style\\b[^>]*>([\\s\\S]*?)<<\\/style>/gi,": "html = html.replace(/<style\\b[^>]*>([\\s\\S]*?)<\\/style>/gi,",
    "return `<style>${rewriteCss(css, baseUrl)}</style>`;": "return `<style>${rewriteCss(css, baseUrl)}</style>`;",
    "return btoa(result).replace(/\\\\\\\\+/g, '-').replace(/\\\\\\\\//g, '_').replace(/=/g, '');": "return btoa(result).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');",
    "res.end(`<<h1>Proxy Error</h1><p>${err.message}</p>`);": "res.end(`<h1>Proxy Error</h1><p>${escapeHtml(err.message)}</p>`);",
    "res.end(`<<h1>Error</h1><p>${err.message}</p>`);": "res.end(`<h1>Error</h1><p>${escapeHtml(err.message)}</p>`);",
    "    res.setHeader('Access-Control-Allow-Credentials', 'true');": "    // Credentials cannot be combined with a wildcard origin.\n    // Keep this endpoint intentionally non-credentialed."
}
for old, new in repls.items():
    if old not in s:
        print('missing:', old[:80])
    s = s.replace(old, new)
# Insert helpers and safer request defaults.
needle = "const BARE_PREFIX = '/bare/';\n"
insert = """const BARE_PREFIX = '/bare/';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 50 * 1024 * 1024);
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_TARGETS === 'true';

function escapeHtml(value) {
    return String(value).replace(/[&<>\"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[ch]));
}

function isBlockedHostname(hostname) {
    const host = hostname.toLowerCase().replace(/[\\[\\]]/g, '');
    if (ALLOW_PRIVATE_TARGETS) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true;
    if (/^(10|127)\\./.test(host) || /^192\\.168\\./.test(host) || /^169\\.254\\./.test(host)) return true;
    const m = host.match(/^172\\.(\\d{1,3})\\./);
    return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

function validateTarget(value) {
    const target = new URL(value);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only http and https targets are supported');
    if (isBlockedHostname(target.hostname)) throw new Error('Target host is not allowed');
    return target;
}
"""
s = s.replace(needle, insert, 1)
# Validate all externally supplied targets.
s = s.replace("const target = new URL(targetUrl);", "const target = validateTarget(targetUrl);")
# Correct response-size handling in both buffered proxy paths.
s = s.replace("proxyRes.on('data', chunk => body.push(chunk));", "proxyRes.on('data', chunk => {\n                body.push(chunk);\n                if (Buffer.concat(body).length > MAX_RESPONSE_BYTES) proxyRes.destroy(new Error('Response too large'));\n            });")
# Add request timeouts after each proxy request construction.
s = s.replace("        proxyReq.on('error', (err) => {", "        proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => proxyReq.destroy(new Error('Upstream request timed out')));\n\n        proxyReq.on('error', (err) => {")
# This replacement applies to all occurrences.
# Rewrite headers outside the text-only branch by inserting before isText.
marker = "                // Only rewrite text content\n                const isText = contentType.includes('text/html')"
header_block = """                // Redirects and cookies matter for binary responses too.
                if (proxyRes.headers.location) proxyRes.headers.location = rewriteUrl(proxyRes.headers.location, targetUrl);
                if (proxyRes.headers.refresh) {
                    const refreshMatch = proxyRes.headers.refresh.match(/(\\d+);\\s*url=(.+)/i);
                    if (refreshMatch) proxyRes.headers.refresh = `${refreshMatch[1]}; url=${rewriteUrl(refreshMatch[2], targetUrl)}`;
                }
                if (proxyRes.headers['set-cookie']) {
                    proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => cookie
                        .replace(/domain=[^;]+/gi, '')
                        .replace(/path=[^;]+/gi, 'path=/')
                        .replace(/;?\\s*secure/gi, '')
                        .replace(/;?\\s*samesite=[^;]+/gi, ''));
                }

                // Only rewrite text content
                const isText = contentType.includes('text/html')"""
s = s.replace(marker, header_block)
# Remove duplicate nested header rewriting blocks to avoid doing it twice.
start = "                    // Rewrite Location headers - CRITICAL for OAuth redirects"
end = "                    const finalData = Buffer.from(bodyStr);"
while start in s:
    a = s.index(start); b = s.index(end, a)
    s = s[:a] + s[b:]
start2 = "                    // Rewrite Location headers\n"
while start2 in s:
    a = s.index(start2); b = s.index("                    const finalData = Buffer.from(bodyStr);", a)
    s = s[:a] + s[b:]
p.write_text(s)
print('patched', p)
