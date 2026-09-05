#!/usr/bin/env python3
import asyncio, base64, ipaddress, os, ssl, time
from dataclasses import dataclass
from urllib.parse import urlsplit

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = int(os.getenv("PORT", os.getenv("LISTEN_PORT", "8080")))
USERNAME = os.environ.get("PROXY_USERNAME", "")
PASSWORD = os.environ.get("PROXY_PASSWORD", "")
ALLOWED = [ipaddress.ip_network(x.strip()) for x in os.getenv("ALLOWED_CLIENTS", "127.0.0.1/32,::1/128").split(",") if x.strip()]
LIST_FILE = os.getenv("PROXY_LIST_FILE", "/app/proxies.txt")
LIST_URL = os.getenv("PROXY_LIST_URL", "")
REFRESH = int(os.getenv("REFRESH_SECONDS", "300"))
HEALTH = int(os.getenv("HEALTHCHECK_SECONDS", "120"))
TIMEOUT = float(os.getenv("CONNECT_TIMEOUT_SECONDS", "10"))
MAX_CONN = int(os.getenv("MAX_CONNECTIONS", "100"))
DIRECT = os.getenv("DIRECT_FALLBACK", "false").lower() == "true"

@dataclass
class Upstream:
    scheme: str
    host: str
    port: int
    username: str | None = None
    password: str | None = None
    healthy: bool = False
    checked: float = 0

upstreams: list[Upstream] = []
rr = 0
semaphore = asyncio.Semaphore(MAX_CONN)


def parse_line(line: str) -> Upstream | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if "://" not in line:
        line = "http://" + line
    p = urlsplit(line)
    if p.scheme.lower() not in {"http", "https", "socks5", "socks5h"} or not p.hostname:
        return None
    return Upstream(p.scheme.lower(), p.hostname, p.port or 80, p.username, p.password)


def load_list(text: str):
    global upstreams
    fresh = [x for line in text.splitlines() if (x := parse_line(line))]
    # Deduplicate while preserving order.
    seen, unique = set(), []
    for x in fresh:
        key = (x.scheme, x.host, x.port, x.username, x.password)
        if key not in seen:
            seen.add(key); unique.append(x)
    upstreams = unique
    print(f"loaded {len(upstreams)} upstreams", flush=True)


async def refresh_loop():
    import aiohttp
    while True:
        try:
            text = ""
            if LIST_URL:
                timeout = aiohttp.ClientTimeout(total=20)
                async with aiohttp.ClientSession(timeout=timeout) as s:
                    async with s.get(LIST_URL) as r:
                        r.raise_for_status(); text = await r.text()
            elif os.path.exists(LIST_FILE):
                text = open(LIST_FILE, encoding="utf-8", errors="replace").read()
            if text:
                load_list(text)
        except Exception as e:
            print(f"refresh failed: {e}", flush=True)
        await asyncio.sleep(REFRESH)


async def health_loop():
    while True:
        snapshot = list(upstreams)
        for u in snapshot:
            try:
                r, w = await open_upstream(u, "example.com", 80)
                w.close()
                await w.wait_closed()
                u.healthy = True
                u.checked = time.time()
            except Exception:
                u.healthy = False
                u.checked = time.time()
        await asyncio.sleep(HEALTH)


async def open_upstream(u: Upstream, target_host: str, target_port: int):
    ssl_ctx = ssl.create_default_context() if u.scheme == "https" else None
    r, w = await asyncio.wait_for(asyncio.open_connection(u.host, u.port, ssl=ssl_ctx), TIMEOUT)
    if u.scheme.startswith("socks5"):
        auth = b"\x05\x02\x00\x02" if u.username else b"\x05\x01\x00"
        w.write(auth); await w.drain(); resp = await r.readexactly(2)
        if resp[1] == 2:
            ub, pb = u.username.encode(), (u.password or "").encode()
            w.write(b"\x01" + bytes([len(ub)]) + ub + bytes([len(pb)]) + pb); await w.drain()
            if (await r.readexactly(2))[1] != 0: raise OSError("SOCKS5 authentication failed")
        elif resp[1] != 0: raise OSError("SOCKS5 authentication method rejected")
        host = target_host.encode()
        try: addr = ipaddress.ip_address(target_host)
        except ValueError: addr = None
        if addr and addr.version == 4: dst = b"\x01" + addr.packed
        elif addr and addr.version == 6: dst = b"\x04" + addr.packed
        else: dst = b"\x03" + bytes([len(host)]) + host
        w.write(b"\x05\x01\x00" + dst + target_port.to_bytes(2, "big")); await w.drain()
        head = await r.readexactly(4)
        if head[1] != 0: raise OSError(f"SOCKS5 connect failed: {head[1]}")
        n = {1: 4, 4: 16, 3: (await r.readexactly(1))[0]}[head[3]]
        await r.readexactly(n + 2)
    else:
        auth = ""
        if u.username is not None:
            token = base64.b64encode(f"{u.username}:{u.password or ''}".encode()).decode()
            auth = f"Proxy-Authorization: Basic {token}\r\n"
        connect = f"CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n{auth}Connection: close\r\n\r\n".encode()
        w.write(connect); await w.drain()
        data = await r.readuntil(b"\r\n\r\n")
        if not data.startswith(b"HTTP/") or b" 200 " not in data.split(b"\r\n", 1)[0]:
            raise OSError("HTTP upstream CONNECT rejected")
    return r, w


async def direct_connect(host, port):
    return await asyncio.wait_for(asyncio.open_connection(host, port), TIMEOUT)


def choose():
    global rr
    if not upstreams: return None
    for _ in range(len(upstreams)):
        u = upstreams[rr % len(upstreams)]; rr += 1
        if u.healthy: return u
    return None


def authorized(headers, peer):
    try:
        ip = ipaddress.ip_address(peer[0])
        if not any(ip in n for n in ALLOWED): return False
    except ValueError: return False
    expected = "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
    return headers.get("proxy-authorization", "") == expected and bool(USERNAME and PASSWORD)


async def relay(a, b):
    try:
        while True:
            data = await a.read(65536)
            if not data: break
            b.write(data); await b.drain()
    finally:
        b.close()


async def handle(reader, writer):
    async with semaphore:
        peer = writer.get_extra_info("peername")
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), TIMEOUT)
            lines = raw.decode("latin1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1); headers[k.lower()] = v.strip()
            if method.upper() == "GET" and target == "/health":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"); await writer.drain(); return
            if not authorized(headers, peer):
                writer.write(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=proxy\r\nConnection: close\r\n\r\n"); await writer.drain(); return
            if method.upper() == "CONNECT":
                host, port_s = target.rsplit(":", 1); port = int(port_s)
            else:
                parsed = urlsplit(target)
                host, port = parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
                if not host: raise ValueError("invalid target")
            u = choose()
            try:
                if u: upstream_r, upstream_w = await open_upstream(u, host, port)
                elif DIRECT: upstream_r, upstream_w = await direct_connect(host, port)
                else: raise OSError("no healthy upstream available")
                if u and not u.healthy: u.healthy = True
            except Exception:
                if u: u.healthy = False
                raise
            if method.upper() == "CONNECT":
                writer.write(b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: secure-forward-proxy\r\n\r\n"); await writer.drain()
                await asyncio.gather(relay(reader, upstream_w), relay(upstream_r, writer))
            else:
                # Convert absolute-form to origin-form and prevent connection reuse.
                path = (urlsplit(target).path or "/") + (("?" + urlsplit(target).query) if urlsplit(target).query else "")
                out = [f"{method} {path} HTTP/1.1"]
                for k, v in headers.items():
                    if k not in {"proxy-authorization", "proxy-connection", "connection", "host"}:
                        out.append(f"{k}: {v}")
                out += [f"Host: {host}:{port}" if port not in (80, 443) else f"Host: {host}", "Connection: close", "", ""]
                upstream_w.write("\r\n".join(out).encode("latin1")); await upstream_w.drain()
                await relay(reader, upstream_w)
                await relay(upstream_r, writer)
        except Exception as e:
            try:
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); await writer.drain()
            except Exception: pass
        finally:
            writer.close()
            try: await writer.wait_closed()
            except Exception: pass


async def main():
    if not USERNAME or not PASSWORD: raise SystemExit("PROXY_USERNAME and PROXY_PASSWORD are required")
    load_list(open(LIST_FILE, encoding="utf-8", errors="replace").read() if os.path.exists(LIST_FILE) else "")
    asyncio.create_task(refresh_loop())
    asyncio.create_task(health_loop())
    server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
    print(f"listening on {LISTEN_HOST}:{LISTEN_PORT}; allowed={ALLOWED}", flush=True)
    async with server: await server.serve_forever()

if __name__ == "__main__":
    asyncio.run(main())
