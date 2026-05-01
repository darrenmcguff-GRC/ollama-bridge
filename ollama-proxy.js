/**
 * Ollama Bridge Companion Proxy
 * A lightweight Express server that sits between Foundry VTT (browser)
 * and the Ollama API (cloud or local), eliminating CORS issues.
 *
 * Usage:
 *   npm install express
 *   node ollama-proxy.js
 *
 * Or with PM2:
 *   pm2 start ollama-proxy.js --name ollama-proxy
 *
 * Environment variables:
 *   OLLAMA_TARGET_URL   — Where to forward requests (default: https://ollama.com)
 *   OLLAMA_API_KEY      — Bearer token for cloud Ollama (optional)
 *   PROXY_PORT          — Port to listen on (default: 3001)
 *   PROXY_HOST          — Bind address (default: 127.0.0.1, use 0.0.0.0 for LAN)
 */

const express = require('express');
const http = require('http');
const https = require('https');
const url = require('url');

const app = express();
app.use(express.json({ limit: '10mb' }));

const TARGET = (process.env.OLLAMA_TARGET_URL || 'https://ollama.com').replace(/\/$/, '');
const API_KEY = process.env.OLLAMA_API_KEY || '';
const PORT = parseInt(process.env.PROXY_PORT || '3001', 10);
const HOST = process.env.PROXY_HOST || '127.0.0.1';

/* ── CORS: allow Foundry origins ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── Health check ── */
app.get('/health', (req, res) => {
  res.json({ ok: true, target: TARGET, forwarded: true });
});

/* ── Proxy all /api/* requests ── */
app.all('/api/*', async (req, res) => {
  const targetPath = `${TARGET}${req.path}`;
  const isHttps = targetPath.startsWith('https://');
  const client = isHttps ? https : http;

  const headers = {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
    ...(req.headers.authorization ? { 'Authorization': req.headers.authorization } : {})
  };
  // If request brings its own auth, it wins over env
  if (req.headers.authorization) {
    headers['Authorization'] = req.headers.authorization;
  }

  const options = url.parse(targetPath);
  options.method = req.method;
  options.headers = headers;
  options.timeout = 120000; // 2 min for large models

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${targetPath}`);

  const proxyReq = client.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    Object.keys(proxyRes.headers).forEach(k => res.setHeader(k, proxyRes.headers[k]));
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy error', message: err.message });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Gateway timeout' });
    }
  });

  if (req.body && Object.keys(req.body).length > 0) {
    proxyReq.write(JSON.stringify(req.body));
  }
  proxyReq.end();
});

/* ── Start ── */
app.listen(PORT, HOST, () => {
  console.log(`Ollama Bridge Proxy running at http://${HOST}:${PORT}`);
  console.log(`Forwarding to: ${TARGET}`);
  console.log(`Auth: ${API_KEY ? 'Bearer token from env' : 'none (forward from request header)'}`);
});
