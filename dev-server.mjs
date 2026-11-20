import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ativa persistência em arquivo local (data/monitors.json) para desenvolvimento
if (!process.env.LOCAL_STORAGE_FILE) {
  process.env.LOCAL_STORAGE_FILE = 'true';
}

import { scanMonitorItems } from './dist/lib/scanner.js';
import { searchSources } from './dist/lib/search.js';
import {
  checkRateLimit,
  getCorsOrigin,
  getSecurityHeaders,
  isAuthorizedCron
} from './dist/lib/security.js';
import {
  getStorageBackend,
  loadPersistedAlerts,
  loadPersistedMonitors,
  savePersistedAlerts,
  savePersistedMonitors
} from './dist/lib/storage.js';
import {
  saveMonitorsRequestSchema,
  scanRequestSchema,
  searchRequestSchema
} from './dist/lib/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 8765);
const MAX_BODY_BYTES = 256 * 1024; // 256 KB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...getSecurityHeaders(),
    ...extraHeaders
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      raw += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;

    const corsOrigin = getCorsOrigin(req.headers.origin, host);
    const corsHeaders = {
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, Vary: 'Origin' } : {}),
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...getSecurityHeaders(), ...corsHeaders });
      return res.end();
    }

    // Rotas da API
    if (pathname.startsWith('/api/')) {
      if (pathname !== '/api/health' && pathname !== '/api/cron') {
        const ip = req.socket?.remoteAddress || 'local';
        const limit = checkRateLimit(`${ip}:${pathname}`, 60, 60_000);
        if (!limit.allowed) {
          return sendJson(
            res,
            429,
            { error: 'Muitas requisições em pouco tempo. Aguarde alguns segundos.' },
            { ...corsHeaders, 'Retry-After': String(limit.retryAfterSec) }
          );
        }
      }

      try {
        if (req.method === 'GET' && pathname === '/api/health') {
          return sendJson(
            res,
            200,
            {
              ok: true,
              version: '5.1.0',
              runtime: 'Node.js Local (Shared Core v5.1)',
              storage: getStorageBackend(),
              notifications: {
                email: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD),
                telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
                whatsapp: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
              },
              time: new Date().toISOString()
            },
            corsHeaders
          );
        }

        if (req.method === 'POST' && pathname === '/api/search') {
          const body = await readJsonBody(req);
          const parsed = searchRequestSchema.safeParse(body);
          if (!parsed.success) {
            return sendJson(res, 400, { error: parsed.error.issues[0]?.message || 'Busca inválida.' }, corsHeaders);
          }
          const { term, sources, rss_feeds, currency, category } = parsed.data;
          const result = await searchSources(term, sources, rss_feeds, currency, category);
          return sendJson(res, 200, result, corsHeaders);
        }

        if (req.method === 'POST' && pathname === '/api/scan') {
          const body = await readJsonBody(req);
          const parsed = scanRequestSchema.safeParse(body);
          if (!parsed.success) {
            return sendJson(res, 400, { error: parsed.error.issues[0]?.message || 'Payload inválido.' }, corsHeaders);
          }
          const { items, config, existing_alert_keys } = parsed.data;
          const results = await scanMonitorItems(items, config, existing_alert_keys);
          return sendJson(res, 200, { results }, corsHeaders);
        }

        if (pathname === '/api/monitors') {
          const storage = getStorageBackend();
          if (req.method === 'GET') {
            const items = await loadPersistedMonitors();
            const alerts = await loadPersistedAlerts();
            return sendJson(res, 200, { storage, items, alerts }, corsHeaders);
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const parsed = saveMonitorsRequestSchema.safeParse(body);
            if (!parsed.success) {
              return sendJson(res, 400, { error: parsed.error.issues[0]?.message || 'Dados inválidos.' }, corsHeaders);
            }
            const saved = await savePersistedMonitors(parsed.data.items);
            return sendJson(res, 200, { saved, storage, count: parsed.data.items.length }, corsHeaders);
          }
        }

        if (req.method === 'GET' && pathname === '/api/cron') {
          if (!isAuthorizedCron(req.headers.authorization)) {
            return sendJson(res, 401, { error: 'Não autorizado.' }, corsHeaders);
          }
          const items = await loadPersistedMonitors();
          const existingAlerts = await loadPersistedAlerts();
          const dedupKeys = existingAlerts.map((a) => a.dedup_key).filter(Boolean);
          const results = await scanMonitorItems(items, {}, dedupKeys);
          const newAlerts = results.flatMap((r) => r.alerts);
          if (newAlerts.length > 0) {
            await savePersistedAlerts([...existingAlerts, ...newAlerts]);
          }
          const now = new Date().toISOString();
          await savePersistedMonitors(items.map((it) => (it.active ? { ...it, last_checked: now } : it)));
          return sendJson(
            res,
            200,
            {
              ok: true,
              storage: getStorageBackend(),
              scanned: results.length,
              alerts_triggered: newAlerts.length,
              time: now
            },
            corsHeaders
          );
        }

        return sendJson(res, 404, { error: 'Rota não encontrada' }, corsHeaders);
      } catch (err) {
        if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
          return sendJson(res, 413, { error: 'Requisição excede o tamanho máximo (256 KB).' }, corsHeaders);
        }
        if (err instanceof Error && err.message === 'INVALID_JSON') {
          return sendJson(res, 400, { error: 'JSON malformado.' }, corsHeaders);
        }
        return sendJson(res, 500, { error: 'Erro interno do servidor.' }, corsHeaders);
      }
    }

    // Servir arquivos estáticos da pasta public/ com proteção contra Path Traversal
    let decodedRawPath = '';
    try {
      decodedRawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400, getSecurityHeaders());
      return res.end('Bad Request');
    }

    if (decodedRawPath.includes('..') || decodedRawPath.includes('\0') || decodedRawPath.includes('\\')) {
      res.writeHead(403, getSecurityHeaders());
      return res.end('Forbidden');
    }

    const relPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    const candidate = path.resolve(PUBLIC_DIR, `.${relPath}`);
    const isInsidePublic = candidate === PUBLIC_DIR || candidate.startsWith(PUBLIC_DIR + path.sep);

    if (!isInsidePublic) {
      res.writeHead(403, getSecurityHeaders());
      return res.end('Forbidden');
    }

    let filePath = candidate;
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // Para assets que não existem (ex.: .js/.css/.svg), retorna 404 real em vez de HTML
      const extReq = path.extname(relPath);
      if (extReq && extReq !== '.html') {
        res.writeHead(404, getSecurityHeaders());
        return res.end('Not Found');
      }
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const extraHeaders = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...getSecurityHeaders()
    };
    if (relPath === '/sw.js') {
      extraHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      extraHeaders['Service-Worker-Allowed'] = '/';
    }

    res.writeHead(200, extraHeaders);
    fs.createReadStream(filePath).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Monitor de Promoções 5.1 rodando em http://127.0.0.1:${PORT}`);
  });
}
