import fs from 'node:fs/promises';
import path from 'node:path';
import type { AlertRecord, MonitorItem } from './types.js';

export type StorageBackend = 'upstash-kv' | 'local-file' | 'none';

const KV_MONITORS_KEY = 'monitordepromocoes:monitors:v5';
const KV_ALERTS_KEY = 'monitordepromocoes:alerts:v5';

function getKvConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();
  if (url && token) return { url: url.replace(/\/$/, ''), token };
  return null;
}

function getLocalDataDir(): string | null {
  if (process.env.LOCAL_STORAGE_FILE === 'true') {
    return path.resolve(process.cwd(), 'data');
  }
  return null;
}

export function getStorageBackend(): StorageBackend {
  if (getKvConfig()) return 'upstash-kv';
  if (getLocalDataDir()) return 'local-file';
  return 'none';
}

async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const cfg = getKvConfig();
  if (!cfg) return fallback;
  const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${cfg.token}` }
  });
  if (!res.ok) return fallback;
  const body = (await res.json()) as { result?: string | null };
  if (!body.result) return fallback;
  try {
    return JSON.parse(body.result) as T;
  } catch {
    return fallback;
  }
}

async function kvSet<T>(key: string, value: T): Promise<boolean> {
  const cfg = getKvConfig();
  if (!cfg) return false;
  const res = await fetch(`${cfg.url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value))
  });
  return res.ok;
}

async function localRead<T>(filename: string, fallback: T): Promise<T> {
  const dir = getLocalDataDir();
  if (!dir) return fallback;
  try {
    const raw = await fs.readFile(path.join(dir, filename), 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function localWrite<T>(filename: string, value: T): Promise<boolean> {
  const dir = getLocalDataDir();
  if (!dir) return false;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(value, null, 2), 'utf-8');
  return true;
}

export async function loadPersistedMonitors(): Promise<MonitorItem[]> {
  const backend = getStorageBackend();
  if (backend === 'upstash-kv') return kvGet<MonitorItem[]>(KV_MONITORS_KEY, []);
  if (backend === 'local-file') return localRead<MonitorItem[]>('monitors.json', []);
  return [];
}

export async function savePersistedMonitors(items: MonitorItem[]): Promise<boolean> {
  const backend = getStorageBackend();
  if (backend === 'upstash-kv') return kvSet(KV_MONITORS_KEY, items);
  if (backend === 'local-file') return localWrite('monitors.json', items);
  return false;
}

export async function loadPersistedAlerts(): Promise<AlertRecord[]> {
  const backend = getStorageBackend();
  if (backend === 'upstash-kv') return kvGet<AlertRecord[]>(KV_ALERTS_KEY, []);
  if (backend === 'local-file') return localRead<AlertRecord[]>('alerts.json', []);
  return [];
}

export async function savePersistedAlerts(alerts: AlertRecord[]): Promise<boolean> {
  const trimmed = alerts.slice(-300);
  const backend = getStorageBackend();
  if (backend === 'upstash-kv') return kvSet(KV_ALERTS_KEY, trimmed);
  if (backend === 'local-file') return localWrite('alerts.json', trimmed);
  return false;
}
