/**
 * Ollama Bridge Proxy v2.0 — SECURE EDITION
 * ============================================
 *
 * Three security modes — pick one:
 *
 * MODE 1: Foundry Referer Lock (RECOMMENDED)
 *   Only requests from your Foundry domain(s) are accepted.
 *   Set: PROXY_MODE=referer ALLOWED_ORIGINS=https://your-foundry.com
 *
 * MODE 2: Shared Secret Token
 *   Clients must include a secret in the X-Ollama-Proxy header.
 *   Set: PROXY_MODE=token PROXY_SECRET=your-secret-here
 *
 * MODE 3: IP Allowlist
 *   Only specific IPs / CIDR ranges can use the proxy.
 *   Set: PROXY_MODE=ip PROXY_ALLOWED_IPS=203.0.113.0/24,192.168.1.0/24
 *
 * Environment variables:
 *   OLLAMA_TARGET_URL   — Where to forward (default: https://ollama.com)
 *   OLLAMA_API_KEY      — Bearer token for upstream Ollama (cloud)
 *   PROXY_PORT          — Listen port (default: 3001)
 *   PROXY_HOST          — Bind address (default: 127.0.0.1)
 *   PROXY_MODE          — Security mode: referer | token | ip | open
 *   ALLOWED_ORIGINS     — Comma-separated for MODE=referer
 *   PROXY_SECRET        — Shared secret for MODE=token
 *   PROXY_ALLOWED_IPS   — CIDR ranges for MODE=ip
 *   RATE_LIMIT_RPM      — Max requests per minute per IP (default: 30)
 *   ALLOWED_PATHS       — Comma-separated allowed paths (default: /api/chat,/api/generate)
 */

const express = require('express');
const http = require('http');
const https = require('https');
const url = require('url');
const net = require('net');

const app = express();
app.use(express.json({ limit: '5mb' }));

/* ── Configuration ── */
const TARGET = (process.env.OLLAMA_TARGET_URL || 'https://ollama.com').replace(/\/$/, '');
const API_KEY = process.env.OLLAMA_API_KEY || '';
const PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const HOST = process.env.PROXY_HOST || '127.0.0.1';
const MODE = (process.env.PROXY_MODE || 'token').toLowerCase();

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const PROXY_SECRET = process.env.PROXY_SECRET || 'change-me-ollama-proxy';
const ALLOWED_IPS = (process.env.PROXY_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '30', 10);
const ALLOWED_PATHS = (process.env.ALLOWED_PATHS || '/api/chat,/api/generate').split(',').map(s => s.trim()).filter(Boolean);

/* ── Rate limiter (simple sliding window per IP) ── */
const rateMap = new Map();
function rateLimit(ip) {
  const now = Date.now();
  if (!rateMap.has(ip)) {
    rateMap.set(ip, []);
  }
  const window = rateMap.get(ip).filter(t => now - t < 60000);
  rateMap.set(ip, window);
  if (window.length >= RATE_LIMIT_RPM) return false;
  window.push(now);
  return true;
}

/* ── IP matching helper ── */
function ipInRange(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);
  const ipNum = ip.split('.').reduce((a, b) => (a << 8) + parseInt(b, 10), 0) >>> 0;
  const rangeNum = range.split('.').reduce((a, b) => (a << 8) + parseInt(b, 10), 0) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

/* ── Security middleware ── */
app.use((req, res, next) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress?.replace(/^::ffff:/, '')
    || 'unknown';

  /* 1. Rate limiting */
  if (!rateLimit(clientIp)) {
    console.warn(`[BLOCKED] Rate limit exceeded for ${clientIp}`);
    return res.status(429).json({ error: 'Too many requests. Slow down.' });
  }

  /* 2. Check path is allowed */
  const reqPath = req.path.replace(/\/+$/, '');
  const allowed = ALLOWED_PATHS.some(p => reqPath === p || reqPath.startsWith(p));
  if (!allowed && req.path !== '/health') {
    console.warn(`[BLOCKED] Disallowed path: ${req.path} from ${clientIp}`);
    return res.status(403).json({ error: 'Access denied: path not allowed.' });
  }

  /* 3. Security mode check */
  if (MODE === 'open') {
    // Open mode — anyone can call (not recommended)
    console.warn(`[OPEN] Request from ${clientIp} — proxy is unauthenticated!`);

  } else if (MODE === 'referer') {
    // Referer lock — only allow from Foundry domains
    const origin = req.headers['origin'] || req.headers['referer'] || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    if (!allowed) {
      console.warn(`[BLOCKED] Origin not allowed: ${origin} from ${clientIp}`);
      return res.status(403).json({ error: 'Access denied: unknown origin.' });
    }

  } else if (MODE === 'token') {
    // Shared secret — client sends X-Ollama-Proxy header
    const secret = req.headers['x-ollama-proxy'] || req.query?.secret || '';
    if (secret !== PROXY_SECRET) {
      console.warn(`[BLOCKED] Invalid proxy secret from ${clientIp}`);
      return res.status(403).json({ error: 'Access denied: invalid proxy token.' });
    }

  } else if (MODE === 'ip') {
    // IP allowlist
    const matched = ALLOWED_IPS.some(cidr => ipInRange(clientIp, cidr));
    if (!matched) {
      console.warn(`[BLOCKED] IP not allowed: ${clientIp}`);
      return res.status(403).json({ error: 'Access denied: IP not allowed.' });
    }
  }

  next();
});

/* ── CORS: restricted to configured origins ── */
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.find(o => origin.startsWith(o));

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  } else if (MODE === 'open') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // Strip origin to prevent CORS leaking
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ollama-Proxy');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.removeHeader('X-Powered-By');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── Health check ── */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    target: TARGET,
    mode: MODE,
    rateLimit: `${RATE_LIMIT_RPM}/min`,
    allowedPaths: ALLOWED_PATHS
  });
});

/* ── Proxy all allowed API paths ── */
const proxyPaths = ALLOWED_PATHS.filter(p => p.startsWith('/api/'));
proxyPaths.forEach(path => {
  app.all(path, async (req, res) => {
    const targetPath = `${TARGET}${req.path}`;
    const isHttps = targetPath.startsWith('https://');
    const client = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'OllamaBridge/2.0'
    };

    // Attach API key from env OR from incoming Authorization header
    if (API_KEY) {
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    const options = {
      ...url.parse(targetPath),
      method: req.method,
      headers,
      timeout: 120000
    };

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} (from ${req.socket?.remoteAddress})`);

    const proxyReq = client.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode);

      // Forward only safe headers
      const safeHeaders = ['content-type', 'content-length', 'date', 'cache-control'];
      Object.keys(proxyRes.headers).forEach(k => {
        if (safeHeaders.includes(k.toLowerCase())) {
          res.setHeader(k, proxyRes.headers[k]);
        }
      });

      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`Proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Upstream connection failed', message: err.message });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'Upstream timeout' });
      }
    });

    if (req.body && Object.keys(req.body).length > 0) {
      proxyReq.write(JSON.stringify(req.body));
    }
    proxyReq.end();
  });
});

/* ── Catch-all for unknown paths ── */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ── Start ── */
app.listen(PORT, HOST, () => {
  const modeDesc = {
    open: '⚠️ OPEN — ANYONE CAN USE THIS PROXY (not recommended)',
    referer: `🔒 ORIGIN LOCK — only ${ALLOWED_ORIGINS.join(', ')}`,
    token: '🔒 SHARED SECRET — clients must send X-Ollama-Proxy header',
    ip: `🔒 IP ALLOWLIST — only ${ALLOWED_IPS.join(', ')}`
  };

  console.log('='.repeat(60));
  console.log('  Ollama Bridge Proxy v2.0 — SECURE');
  console.log('='.repeat(60));
  console.log(`  Listening:  http://${HOST}:${PORT}`);
  console.log(`  Target:     ${TARGET}`);
  console.log(`  Auth mode:  ${modeDesc[MODE] || 'unknown'}`);
  console.log(`  Rate limit: ${RATE_LIMIT_RPM} req/min per IP`);
  console.log(`  Paths:      ${ALLOWED_PATHS.join(', ')}`);
  console.log(`  API key:    ${API_KEY ? '✓ configured' : '✗ not set (upstream requests may fail)'}`);
  console.log('='.repeat(60));
});

/* ── Graceful shutdown ── */
process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nShutting down...'); process.exit(0); });
