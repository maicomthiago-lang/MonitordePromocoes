import type { VercelRequest, VercelResponse } from '@vercel/node';
import { scanMonitorItems } from '../lib/scanner.js';
import { searchSources } from '../lib/search.js';
import {
  checkRateLimit,
  getCorsOrigin,
  getSecurityHeaders,
  isAuthorizedCron
} from '../lib/security.js';
import {
  getStorageBackend,
  loadPersistedAlerts,
  loadPersistedMonitors,
  savePersistedAlerts,
  savePersistedMonitors
} from '../lib/storage.js';
import {
  saveMonitorsRequestSchema,
  scanRequestSchema,
  searchRequestSchema
} from '../lib/validation.js';

function getClientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secHeaders = getSecurityHeaders();
  for (const [k, v] of Object.entries(secHeaders)) {
    res.setHeader(k, v);
  }
  res.setHeader('Cache-Control', 'no-store');

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  const corsOrigin = getCorsOrigin(originHeader, hostHeader);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const url = new URL(req.url || '/', `https://${hostHeader || 'localhost'}`);
  const pathname = url.pathname;

  // Rate limiting básico por IP
  if (pathname !== '/api/health' && pathname !== '/api/cron') {
    const ip = getClientIp(req);
    const limit = checkRateLimit(`${ip}:${pathname}`, 40, 60_000);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      return res.status(429).json({
        error: 'Muitas requisições em pouco tempo. Aguarde alguns segundos e tente novamente.'
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    const storage = getStorageBackend();
    return res.status(200).json({
      ok: true,
      version: '5.1.0',
      runtime: 'Node.js / TypeScript (Vercel Serverless)',
      storage,
      notifications: {
        email: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD),
        telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        whatsapp: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
      },
      time: new Date().toISOString()
    });
  }

  if (req.method === 'POST' && pathname === '/api/search') {
    const parsed = searchRequestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || 'Parâmetros de busca inválidos.';
      return res.status(400).json({ error: msg });
    }
    const { term, sources, rss_feeds, currency, category } = parsed.data;
    const result = await searchSources(term, sources, rss_feeds, currency, category);
    return res.status(200).json(result);
  }

  if (req.method === 'POST' && pathname === '/api/scan') {
    const parsed = scanRequestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message || 'Payload de varredura inválido.';
      return res.status(400).json({ error: msg });
    }
    const { items, config, existing_alert_keys } = parsed.data;
    const results = await scanMonitorItems(items, config, existing_alert_keys);
    return res.status(200).json({ results });
  }

  if (pathname === '/api/monitors') {
    const storage = getStorageBackend();
    if (req.method === 'GET') {
      const items = await loadPersistedMonitors();
      const alerts = await loadPersistedAlerts();
      return res.status(200).json({ storage, items, alerts });
    }
    if (req.method === 'POST') {
      if (storage === 'none') {
        return res.status(200).json({
          saved: false,
          storage,
          message: 'Armazenamento em servidor não configurado (usando localStorage do navegador).'
        });
      }
      const parsed = saveMonitorsRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      }
      const saved = await savePersistedMonitors(parsed.data.items);
      return res.status(200).json({ saved, storage, count: parsed.data.items.length });
    }
  }

  if (req.method === 'GET' && pathname === '/api/cron') {
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    if (!isAuthorizedCron(authHeader)) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }

    const storage = getStorageBackend();
    if (storage === 'none') {
      return res.status(200).json({
        ok: true,
        storage,
        scanned: 0,
        alerts_triggered: 0,
        message: 'Cron ativo. Configure UPSTASH_REDIS_REST_URL/TOKEN (ou Vercel KV) para monitorar em segundo plano.'
      });
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
    const updatedItems = items.map((it) => (it.active ? { ...it, last_checked: now } : it));
    await savePersistedMonitors(updatedItems);

    return res.status(200).json({
      ok: true,
      storage,
      scanned: results.length,
      alerts_triggered: newAlerts.length,
      time: now
    });
  }

  return res.status(404).json({ error: 'Rota não encontrada' });
}
