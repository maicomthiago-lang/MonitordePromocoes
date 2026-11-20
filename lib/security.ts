import crypto from 'node:crypto';
import type { Offer } from './types.js';

const PRIVATE_IPV4_RANGES: Array<(parts: number[]) => boolean> = [
  ([a]) => a === 0, // 0.0.0.0/8
  ([a]) => a === 10, // 10.0.0.0/8
  ([a]) => a === 127, // 127.0.0.0/8 loopback
  ([a, b]) => a === 169 && b === 254, // 169.254.0.0/16 link-local / cloud metadata
  ([a, b]) => a === 172 && b >= 16 && b <= 31, // 172.16.0.0/12
  ([a, b]) => a === 192 && b === 168, // 192.168.0.0/16
  ([a, b]) => a === 100 && b >= 64 && b <= 127, // 100.64.0.0/10 CGNAT
  ([a]) => a >= 224 // multicast & reserved
];

export function cleanHttpUrl(u: unknown): string {
  if (typeof u !== 'string') return '';
  const trimmed = u.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    return parsed.toString().slice(0, 2000);
  } catch {
    return '';
  }
}

export function isPrivateOrInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    return true;
  }

  // IPv6 loopback, link-local, unique-local, IPv4-mapped
  if (host.includes(':')) {
    const normalized = host.toLowerCase();
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('::ffff:')
    ) {
      return true;
    }
    return false;
  }

  // IPv4 literal check
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const parts = ipv4Match.slice(1).map((n) => Number(n));
    if (parts.some((n) => n < 0 || n > 255)) return true;
    return PRIVATE_IPV4_RANGES.some((check) => check(parts));
  }

  // Numeric/hex/octal obfuscated IP check (e.g., 2130706433, 0x7f000001)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    return true;
  }

  return false;
}

export function validateExternalFetchUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 1000) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return null;
  }
  if (isPrivateOrInternalHost(parsed.hostname)) {
    return null;
  }

  return parsed.toString();
}

/**
 * Converte string de preço de formatos BRL ("1.299,90", "59,90")
 * e USD ("19.99", "1,299.99", "19,99") corretamente para number.
 */
export function parsePriceString(raw: string, preferUsd = false): number {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^\d.,]/g, '');
  if (!cleaned) return Number.NaN;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    // O último separador indica a casa decimal
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      // Formato BR: 1.299,90
      return Number.parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    }
    // Formato US: 1,299.99
    return Number.parseFloat(cleaned.replace(/,/g, ''));
  }

  if (hasComma) {
    const parts = cleaned.split(',');
    const last = parts[parts.length - 1] || '';
    // Ex.: 1,299 em USD vs 59,90 em BRL
    if (parts.length === 2 && last.length === 3 && preferUsd) {
      return Number.parseFloat(cleaned.replace(/,/g, ''));
    }
    if (parts.length > 2) {
      return Number.parseFloat(cleaned.replace(/,/g, ''));
    }
    return Number.parseFloat(cleaned.replace(',', '.'));
  }

  if (hasDot) {
    const parts = cleaned.split('.');
    const last = parts[parts.length - 1] || '';
    // Ex.: 1.299 (milhar em BRL) vs 19.99 (decimal em USD/API)
    if (parts.length > 2) {
      return Number.parseFloat(cleaned.replace(/\./g, ''));
    }
    if (parts.length === 2 && last.length === 3 && !preferUsd) {
      return Number.parseFloat(cleaned.replace(/\./g, ''));
    }
    return Number.parseFloat(cleaned);
  }

  return Number.parseFloat(cleaned);
}

export function isValidEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed);
}

export function buildAlertDedupKey(itemId: string, offer: Pick<Offer, 'store' | 'url' | 'price' | 'currency'>): string {
  const normalizedUrl = (offer.url || '').split('?')[0].toLowerCase();
  const roundedPrice = Number(offer.price || 0).toFixed(2);
  const raw = `${itemId}|${offer.store.toLowerCase()}|${offer.currency}|${roundedPrice}|${normalizedUrl}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

export function checkRateLimit(key: string, maxRequests = 40, windowMs = 60_000): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const existing = rateBuckets.get(key);

  // Limpeza oportunista para evitar crescimento infinito de memória
  if (rateBuckets.size > 1000) {
    for (const [k, v] of rateBuckets.entries()) {
      if (v.resetAt <= now) rateBuckets.delete(k);
    }
  }

  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, retryAfterSec: 0 };
  }

  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - existing.count),
    retryAfterSec: 0
  };
}

export function getSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
}

export function getCorsOrigin(requestOrigin?: string, host?: string): string {
  const configured = (process.env.ALLOWED_ORIGIN || '').trim();
  if (configured) {
    const allowedList = configured.split(',').map((s) => s.trim()).filter(Boolean);
    if (requestOrigin && allowedList.includes(requestOrigin)) {
      return requestOrigin;
    }
    return allowedList[0] || '';
  }

  if (requestOrigin) {
    try {
      const parsed = new URL(requestOrigin);
      if (
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        (host && parsed.host === host)
      ) {
        return requestOrigin;
      }
    } catch {
      return '';
    }
  }

  return '';
}

export function isAuthorizedCron(authHeader?: string): boolean {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return true;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice('Bearer '.length).trim();
  const a = Buffer.from(secret);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
