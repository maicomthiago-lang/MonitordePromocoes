import crypto from 'node:crypto';
import { sendNotifications } from './notifications.js';
import { qualifies, searchSources } from './search.js';
import { buildAlertDedupKey, isValidEmail } from './security.js';
import type { AlertRecord, MonitorItem, ProductCategory, RuntimeConfig, ScanItemResult } from './types.js';

const VALID_CATEGORIES = new Set<ProductCategory>(['Auto', 'Jogos', 'Software', 'Hardware', 'Eletrônicos', 'Outros']);

function toProductCategory(raw?: string): ProductCategory {
  if (raw && VALID_CATEGORIES.has(raw as ProductCategory)) {
    return raw as ProductCategory;
  }
  return 'Auto';
}

export async function scanMonitorItems(
  items: MonitorItem[],
  runtimeConfig: RuntimeConfig = {},
  existingDedupKeys: Iterable<string> = []
): Promise<ScanItemResult[]> {
  const extraFeeds = Array.isArray(runtimeConfig.rss_feeds) ? runtimeConfig.rss_feeds : [];
  const seenKeys = new Set<string>(existingDedupKeys);
  const results: ScanItemResult[] = [];

  for (const item of items) {
    if (!item.active) continue;

    const email = (item.destinations?.['E-mail'] || item.destinations?.email || '').trim();
    if (!isValidEmail(email)) {
      results.push({
        item_id: item.id,
        item: item.name,
        offers: [],
        alerts: [],
        errors: ['Monitoramento ativo exige um e-mail válido cadastrado.'],
        usd_to_brl_rate: null
      });
      continue;
    }

    const { offers, errors, usd_to_brl_rate, detected_category } = await searchSources(
      item.name,
      item.sources,
      extraFeeds,
      item.currency_filter || 'ALL',
      toProductCategory(item.category)
    );

    const triggeredAlerts: AlertRecord[] = [];

    for (const offer of offers) {
      if (!qualifies(item, offer, usd_to_brl_rate)) continue;

      const dedupKey = buildAlertDedupKey(item.id, offer);
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      const notif = await sendNotifications(item, offer, runtimeConfig);
      triggeredAlerts.push({
        ...offer,
        id: crypto.randomUUID(),
        item_id: item.id,
        dedup_key: dedupKey,
        created_at: new Date().toISOString(),
        notified: notif.sent.length ? notif.sent.join(', ') : 'Painel',
        notification_errors: notif.errors.length ? notif.errors : undefined
      });
    }

    results.push({
      item_id: item.id,
      item: item.name,
      offers,
      alerts: triggeredAlerts,
      errors,
      usd_to_brl_rate,
      detected_category
    });
  }

  return results;
}
