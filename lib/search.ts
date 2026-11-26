import { XMLParser } from 'fast-xml-parser';
import { detectDeliveryType } from './classifier.js';
import { detectQueryCategory, matchesSearchTerm, normalizeForSearch, scoreOfferRelevance } from './relevance.js';
import { cleanHttpUrl, parsePriceString, validateExternalFetchUrl } from './security.js';
import type { Coupon, CurrencyFilter, MonitorItem, Offer, ProductCategory, RssFeedConfig } from './types.js';

export const CS_STORES: Record<string, string> = {
  '1': 'Steam',
  '2': 'GamersGate',
  '3': 'Green Man Gaming',
  '7': 'GOG',
  '11': 'Humble Store',
  '13': 'Ubisoft Store',
  '15': 'Fanatical',
  '21': 'WinGameStore',
  '23': 'GameBillet',
  '24': 'Voidu',
  '25': 'Epic Games',
  '27': 'Gamesplanet',
  '28': 'Gamesload',
  '29': '2Game',
  '30': 'IndieGala',
  '31': 'Blizzard Shop',
  '33': 'DLGamer',
  '34': 'Noctre',
  '35': 'DreamGame'
};

const GAME_ONLY_SOURCES = new Set(['Steam', 'Epic Games', 'GOG', 'Nuuvem', 'CheapShark (USD)', 'CheapShark']);

const NON_GAME_DEFAULT_SOURCES = [
  'Google Shopping',
  'Mercado Livre',
  'Amazon',
  'KaBuM!',
  'Buscapé',
  'AllKeyShop',
  'Sites de cupons',
  'Promobit (RSS)'
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false, // Protege contra entity expansion (XXE / Billion Laughs)
  trimValues: true
});

let cachedUsdRate: { rate: number; expiresAt: number } | null = null;
const couponCache = new Map<string, { coupons: Coupon[]; expiresAt: number }>();

export type CouponApiRecord = {
  code?: string | null;
  title?: string;
  store_name?: string | null;
  discount_percent?: number | null;
  discount_fixed?: number | null;
  expires_at?: string | null;
  expires_at_brt?: string | null;
  conditions?: string | null;
  source?: string;
  url?: string;
  source_url?: string;
};

export function filterActiveStoreCoupons(
  records: CouponApiRecord[],
  storeName: string,
  now = Date.now()
): Coupon[] {
  const key = normalizeForSearch(storeName);
  return records.flatMap((item): Coupon[] => {
    if (!item.code || !item.store_name || !item.url || !item.source_url) return [];
    if (normalizeForSearch(item.store_name) !== key) return [];
    if (item.expires_at && Date.parse(item.expires_at) <= now) return [];
    const couponUrl = cleanHttpUrl(item.url);
    const sourceUrl = cleanHttpUrl(item.source_url);
    if (!couponUrl || !sourceUrl) return [];
    return [{
      code: item.code.slice(0, 80),
      title: String(item.title || 'Cupom da loja').slice(0, 180),
      store_name: item.store_name.slice(0, 80),
      discount_percent: item.discount_percent,
      discount_fixed: item.discount_fixed,
      expires_at_brt: item.expires_at_brt,
      conditions: item.conditions ? item.conditions.slice(0, 280) : null,
      url: couponUrl,
      source_url: sourceUrl,
      source: item.source || 'fonte externa',
      status: 'Vigente na fonte; checkout não testado'
    }];
  });
}

async function findStoreCoupons(storeName: string): Promise<Coupon[]> {
  const key = normalizeForSearch(storeName);
  const cached = couponCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.coupons;

  const endpoint = new URL('https://cupomdescontos.com/api/coupons');
  endpoint.searchParams.set('q', storeName.slice(0, 60));
  endpoint.searchParams.set('limit', '20');

  try {
    const response = await fetchJson<{ data?: CouponApiRecord[] }>(endpoint.toString(), 6_000);
    const now = Date.now();
    const coupons = filterActiveStoreCoupons(response.data ?? [], storeName, now);
    couponCache.set(key, { coupons, expiresAt: now + 10 * 60_000 });
    return coupons;
  } catch {
    couponCache.set(key, { coupons: [], expiresAt: Date.now() + 60_000 });
    return [];
  }
}

async function attachCouponsToOffers(offers: Offer[]): Promise<void> {
  const storeNames = Array.from(new Set(offers.filter((offer) => offer.price > 0).map((offer) => offer.store))).slice(0, 6);
  const couponsByStore = new Map<string, Coupon[]>();
  await Promise.all(storeNames.map(async (store) => couponsByStore.set(store, await findStoreCoupons(store))));
  for (const offer of offers) {
    const coupons = couponsByStore.get(offer.store);
    if (coupons?.length) offer.coupons = coupons;
  }
}

async function fetchJson<T>(url: string, timeoutMs = 10_000, extraHeaders: Record<string, string> = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'PromoMonitor/5.1 (Open-Source TypeScript PWA)',
        Accept: 'application/json',
        ...extraHeaders
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextLimited(url: string, maxBytes = 2 * 1024 * 1024, timeoutMs = 8_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'PromoMonitor/5.1 RSS',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Validar URL final após redirecionamentos contra SSRF
    if (res.url && !validateExternalFetchUrl(res.url)) {
      throw new Error('Redirecionamento bloqueado por política de segurança');
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > maxBytes) {
      throw new Error('Feed RSS excede o limite máximo permitido (2 MB)');
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return text.slice(0, maxBytes);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          controller.abort();
          throw new Error('Feed RSS excede o limite máximo permitido (2 MB)');
        }
        chunks.push(value);
      }
    }

    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(combined);
  } finally {
    clearTimeout(timer);
  }
}

export async function getUsdToBrlRate(): Promise<number | null> {
  const now = Date.now();
  if (cachedUsdRate && cachedUsdRate.expiresAt > now) {
    return cachedUsdRate.rate;
  }

  try {
    const data = await fetchJson<{ USDBRL?: { bid?: string } }>(
      'https://economia.awesomeapi.com.br/json/last/USD-BRL',
      4_000
    );
    const rate = Number.parseFloat(data?.USDBRL?.bid || '');
    if (Number.isFinite(rate) && rate > 1 && rate < 50) {
      cachedUsdRate = { rate, expiresAt: now + 30 * 60_000 };
      return rate;
    }
  } catch {
    // Fallback para segunda API aberta
  }

  try {
    const data = await fetchJson<{ rates?: { BRL?: number } }>('https://open.er-api.com/v6/latest/USD', 4_000);
    const rate = Number(data?.rates?.BRL ?? 0);
    if (Number.isFinite(rate) && rate > 1 && rate < 50) {
      cachedUsdRate = { rate, expiresAt: now + 30 * 60_000 };
      return rate;
    }
  } catch {
    // Sem rede ou indisponível
  }

  return null;
}

export async function steamSearch(term: string): Promise<Offer[]> {
  const out: Offer[] = [];
  const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=br&l=brazilian`;
  const data = await fetchJson<{
    items?: Array<{ id?: number; name?: string; tiny_image?: string; price?: { final?: number; initial?: number } }>;
  }>(searchUrl);

  // Filtra relevância já na lista inicial para não gastar chamadas em falsos positivos (ex.: "Absolute Skat for Windows 11")
  const items = (data.items ?? []).filter((app) => app.name && matchesSearchTerm(app.name, term)).slice(0, 8);

  const detailsPromises = items.map(async (app): Promise<Offer | null> => {
    if (!app.id) return null;
    try {
      const detailUrl = `https://store.steampowered.com/api/appdetails?appids=${app.id}&cc=br&l=brazilian`;
      const detail = await fetchJson<Record<string, { data?: Record<string, any> }>>(detailUrl, 8_000);
      const entry = detail[String(app.id)]?.data;
      const itemName = String(entry?.name || app.name || term);
      if (!matchesSearchTerm(itemName, term)) return null;

      if (!entry?.price_overview) {
        if (app.price?.final) {
          const cents = Number(app.price.final);
          const orig = Number(app.price.initial ?? cents);
          const disc = orig > cents ? Math.round(((orig - cents) / orig) * 100) : 0;
          return {
            name: itemName,
            store: 'Steam',
            kind: 'Loja oficial',
            delivery_type: detectDeliveryType(itemName, 'Steam'),
            currency: 'BRL',
            price: cents / 100,
            original_price: orig / 100,
            discount: disc,
            url: `https://store.steampowered.com/app/${app.id}/`,
            thumb: cleanHttpUrl(app.tiny_image),
            relevance: scoreOfferRelevance(itemName, term),
            checked_at: new Date().toISOString()
          };
        }
        return null;
      }

      const p = entry.price_overview;
      const cents = Number(p.final ?? 0);
      const orig = Number(p.initial ?? cents);

      return {
        name: itemName,
        store: 'Steam',
        kind: 'Loja oficial',
        delivery_type: detectDeliveryType(itemName, 'Steam'),
        currency: 'BRL',
        price: cents / 100,
        original_price: orig / 100,
        discount: Number(p.discount_percent ?? 0),
        url: cleanHttpUrl(entry.store_url || `https://store.steampowered.com/app/${app.id}/`),
        thumb: cleanHttpUrl(entry.header_image || app.tiny_image),
        relevance: scoreOfferRelevance(itemName, term),
        checked_at: new Date().toISOString()
      };
    } catch {
      if (app.price?.final && app.name && matchesSearchTerm(app.name, term)) {
        const cents = Number(app.price.final);
        const orig = Number(app.price.initial ?? cents);
        const disc = orig > cents ? Math.round(((orig - cents) / orig) * 100) : 0;
        const itemName = String(app.name);
        return {
          name: itemName,
          store: 'Steam',
          kind: 'Loja oficial',
          delivery_type: detectDeliveryType(itemName, 'Steam'),
          currency: 'BRL',
          price: cents / 100,
          original_price: orig / 100,
          discount: disc,
          url: `https://store.steampowered.com/app/${app.id}/`,
          thumb: cleanHttpUrl(app.tiny_image),
          relevance: scoreOfferRelevance(itemName, term),
          checked_at: new Date().toISOString()
        };
      }
      return null;
    }
  });

  const resolved = await Promise.all(detailsPromises);
  for (const item of resolved) {
    if (item) out.push(item);
  }
  return out;
}

export async function cheapsharkSearch(
  term: string,
  storeFilter?: string,
  customStoreLabel?: string
): Promise<Offer[]> {
  let url = `https://www.cheapshark.com/api/1.0/deals?title=${encodeURIComponent(term)}&pageSize=15&sortBy=Price`;
  if (storeFilter) {
    url += `&storeID=${encodeURIComponent(storeFilter)}`;
  }
  const data = await fetchJson<Array<Record<string, any>>>(url);
  if (!Array.isArray(data)) return [];

  const out: Offer[] = [];
  for (const d of data) {
    const title = String(d.title || '');
    if (!title || !matchesSearchTerm(title, term)) continue;

    const storeName = customStoreLabel || CS_STORES[String(d.storeID)] || `CheapShark (Loja ${d.storeID ?? '?'})`;
    const isOfficial = storeFilter === '25' || storeFilter === '7' || String(d.storeID) === '1';
    out.push({
      name: title,
      store: storeName,
      kind: isOfficial ? 'Loja oficial' : 'Revendedor',
      delivery_type: detectDeliveryType(title, storeName),
      currency: 'USD',
      price: Number(d.salePrice ?? 0),
      original_price: Number(d.normalPrice ?? 0),
      discount: Number(d.savings ?? 0),
      url: cleanHttpUrl(`https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(String(d.dealID ?? ''))}`),
      thumb: cleanHttpUrl(d.thumb),
      relevance: scoreOfferRelevance(title, term),
      checked_at: new Date().toISOString()
    });
  }
  return out;
}

export async function gogDirectSearch(term: string): Promise<Offer[]> {
  // 1. API oficial do catálogo GOG em Real (BRL)
  try {
    const catalogUrl = `https://catalog.gog.com/v1/catalog?limit=10&countryCode=BR&currencyCode=BRL&productType=in:game,pack&query=like:${encodeURIComponent(term)}`;
    const data = await fetchJson<{ products?: Array<Record<string, any>> }>(catalogUrl, 8_000);
    const products = (data.products ?? []).filter((p) => p.title && matchesSearchTerm(String(p.title), term)).slice(0, 6);
    const out: Offer[] = [];

    for (const p of products) {
      const priceObj = p.price;
      if (!priceObj) continue;
      const finalAmount = parsePriceString(String(priceObj.finalMoney?.amount ?? priceObj.final ?? '0'), false);
      const baseAmount = parsePriceString(
        String(priceObj.baseMoney?.amount ?? priceObj.base ?? finalAmount),
        false
      );
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) continue;

      const currCode = String(priceObj.finalMoney?.currency || '').toUpperCase();
      const currency: 'BRL' | 'USD' = currCode === 'USD' ? 'USD' : 'BRL';
      const title = String(p.title || term);
      const discountRaw = String(priceObj.discount || '0').replace(/[^\d]/g, '');
      const discount =
        Number(discountRaw) || (baseAmount > finalAmount ? Math.round(((baseAmount - finalAmount) / baseAmount) * 100) : 0);

      out.push({
        name: title,
        store: 'GOG',
        kind: 'Loja oficial',
        delivery_type: detectDeliveryType(title, 'GOG'),
        currency,
        price: finalAmount,
        original_price: Number.isFinite(baseAmount) && baseAmount > 0 ? baseAmount : finalAmount,
        discount,
        url: cleanHttpUrl(
          p.storeLink || (p.slug ? `https://www.gog.com/en/game/${p.slug}` : `https://www.gog.com/en/games?query=${encodeURIComponent(term)}`)
        ),
        thumb: cleanHttpUrl(p.coverHorizontal || p.coverVertical),
        relevance: scoreOfferRelevance(title, term),
        checked_at: new Date().toISOString()
      });
    }

    if (out.length > 0) return out;
  } catch {
    // Fallback abaixo
  }

  // 2. Fallback: API embed da GOG
  try {
    const url = `https://embed.gog.com/games/ajax/filtered?mediaType=game&search=${encodeURIComponent(term)}`;
    const data = await fetchJson<{ products?: Array<Record<string, any>> }>(url, 8_000);
    const products = (data.products ?? []).filter((p) => p.title && matchesSearchTerm(String(p.title), term)).slice(0, 6);
    const out: Offer[] = [];
    for (const p of products) {
      if (!p.price) continue;
      const symbol = String(p.price.symbol || '').toUpperCase();
      const isUsd = !(symbol.includes('R$') || symbol.includes('BRL'));
      const finalAmount = parsePriceString(String(p.price.finalAmount ?? p.price.amount ?? '0'), isUsd);
      const baseAmount = parsePriceString(String(p.price.baseAmount ?? finalAmount), isUsd);
      if (!Number.isFinite(finalAmount) || finalAmount <= 0) continue;
      const title = String(p.title || term);
      out.push({
        name: title,
        store: 'GOG',
        kind: 'Loja oficial',
        delivery_type: detectDeliveryType(title, 'GOG'),
        currency: isUsd ? 'USD' : 'BRL',
        price: finalAmount,
        original_price: Number.isFinite(baseAmount) && baseAmount > 0 ? baseAmount : finalAmount,
        discount: Number(p.price.discountPercentage ?? p.price.discount ?? 0),
        url: cleanHttpUrl(
          p.url ? `https://www.gog.com${p.url}` : `https://www.gog.com/en/games?query=${encodeURIComponent(term)}`
        ),
        relevance: scoreOfferRelevance(title, term),
        checked_at: new Date().toISOString()
      });
    }
    if (out.length > 0) return out;
  } catch {
    // Fallback para CheapShark
  }

  return cheapsharkSearch(term, '7', 'GOG');
}

export async function mercadoLivreSearch(term: string): Promise<Offer[]> {
  const token = (process.env.ML_ACCESS_TOKEN || '').trim();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(term)}&limit=10`;
    const data = await fetchJson<{ results?: Array<Record<string, any>> }>(url, 6_000, headers);
    const results = (data.results ?? []).filter((r) => r.title && matchesSearchTerm(String(r.title), term));
    const out: Offer[] = [];

    for (const r of results.slice(0, 6)) {
      const price = Number(r.price ?? 0);
      const origPrice = Number(r.original_price ?? price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const title = String(r.title);
      const discount = origPrice > price ? Math.round(((origPrice - price) / origPrice) * 100) : 0;
      out.push({
        name: title,
        store: 'Mercado Livre',
        kind: 'Loja oficial',
        delivery_type: detectDeliveryType(title, 'Mercado Livre'),
        currency: 'BRL',
        price,
        original_price: origPrice > 0 ? origPrice : price,
        discount,
        url: cleanHttpUrl(r.permalink),
        thumb: cleanHttpUrl(String(r.thumbnail || '').replace(/^http:\/\//i, 'https://')),
        relevance: scoreOfferRelevance(title, term),
        checked_at: new Date().toISOString()
      });
    }

    if (out.length > 0) return out;
  } catch {
    // API pública pode exigir OAuth; fallback para link direto de busca
  }

  const slug = encodeURIComponent(term.trim().replace(/\s+/g, '-'));
  return [
    {
      name: `${term} (Buscar ofertas no Mercado Livre)`,
      store: 'Mercado Livre',
      kind: 'Comparador / Loja',
      delivery_type: detectDeliveryType(term, 'Mercado Livre'),
      currency: 'BRL',
      price: 0,
      original_price: 0,
      discount: 0,
      url: `https://lista.mercadolivre.com.br/${slug}`,
      checked_at: new Date().toISOString()
    }
  ];
}

function normalizeXmlText(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (val && typeof val === 'object' && '#text' in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)['#text'] || '');
  }
  return '';
}

function extractXmlLink(linkField: unknown): string {
  if (typeof linkField === 'string') return linkField;
  if (Array.isArray(linkField)) {
    for (const entry of linkField) {
      const candidate = extractXmlLink(entry);
      if (candidate) return candidate;
    }
    return '';
  }
  if (linkField && typeof linkField === 'object') {
    const obj = linkField as Record<string, unknown>;
    if (typeof obj['@_href'] === 'string') return obj['@_href'];
    if (typeof obj['#text'] === 'string') return obj['#text'];
  }
  return '';
}

export function parseRssXmlOffers(xml: string, term: string, storeName: string): Offer[] {
  const out: Offer[] = [];

  let parsed: Record<string, any>;
  try {
    parsed = xmlParser.parse(xml) as Record<string, any>;
  } catch {
    return out;
  }

  const rawItems = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? parsed?.['rdf:RDF']?.item ?? [];
  const itemsList = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  for (const entry of itemsList) {
    if (!entry || typeof entry !== 'object') continue;
    const title = normalizeXmlText(entry.title).replace(/<[^>]+>/g, ' ').trim();
    if (!title || !matchesSearchTerm(title, term)) continue;

    const desc = normalizeXmlText(entry.description ?? entry.summary ?? entry.content)
      .replace(/<[^>]+>/g, ' ')
      .trim();
    const link = cleanHttpUrl(extractXmlLink(entry.link));
    if (!link) continue;

    const combinedText = `${title} ${desc}`;
    const dePorMatch = combinedText.match(
      /de\s+(R\$|BRL|US\$|USD|\$)\s*([\d.,]+)\s+(?:por|para)\s+(R\$|BRL|US\$|USD|\$)?\s*([\d.,]+)/i
    );

    let isUsd = false;
    let parsedPrice = Number.NaN;
    let originalPrice = Number.NaN;

    if (dePorMatch) {
      const currToken = dePorMatch[3] || dePorMatch[1] || '';
      isUsd = /^(US\$|USD|\$)$/i.test(currToken.trim());
      originalPrice = parsePriceString(dePorMatch[2] || '', isUsd);
      parsedPrice = parsePriceString(dePorMatch[4] || '', isUsd);
    } else {
      const priceMatch = combinedText.match(/(R\$|BRL|US\$|USD|\$)\s*([\d.,]+)/i);
      if (!priceMatch) continue;
      const currencyToken = priceMatch[1] || '';
      isUsd = /^(US\$|USD|\$)$/i.test(currencyToken.trim());
      parsedPrice = parsePriceString(priceMatch[2] || '', isUsd);
      originalPrice = parsedPrice;
    }

    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) continue;

    const pctMatch = combinedText.match(/(?:-|\b)(\d{1,2})\s*%\s*(?:off|desconto)?/i);
    let discount = pctMatch ? Number(pctMatch[1]) : 0;

    if (Number.isFinite(originalPrice) && originalPrice > parsedPrice) {
      discount = Math.round(((originalPrice - parsedPrice) / originalPrice) * 100);
    } else if (discount > 0 && discount < 100) {
      originalPrice = Number((parsedPrice / (1 - discount / 100)).toFixed(2));
    } else {
      originalPrice = parsedPrice;
    }

    out.push({
      name: title.slice(0, 180),
      store: storeName,
      kind: 'RSS',
      delivery_type: detectDeliveryType(title, storeName, desc),
      currency: isUsd ? 'USD' : 'BRL',
      price: Number(parsedPrice.toFixed(2)),
      original_price: Number(originalPrice.toFixed(2)),
      discount: Math.max(0, Math.min(100, Math.round(discount))),
      url: link,
      relevance: scoreOfferRelevance(title, term),
      checked_at: new Date().toISOString()
    });
  }

  return out;
}

export async function rssSearch(
  term: string,
  extraFeeds: RssFeedConfig[] = []
): Promise<{ offers: Offer[]; errors: string[] }> {
  const out: Offer[] = [];
  const errors: string[] = [];

  let envFeeds: RssFeedConfig[] = [];
  try {
    const parsed = JSON.parse(process.env.RSS_FEEDS || '[]');
    if (Array.isArray(parsed)) envFeeds = parsed;
  } catch {
    envFeeds = [];
  }

  const feeds = [...envFeeds, ...extraFeeds].slice(0, 5);

  for (const feed of feeds) {
    const safeUrl = validateExternalFetchUrl(feed?.url);
    if (!safeUrl) {
      errors.push(`RSS bloqueado (URL inválida ou privada): ${String(feed?.url || '').slice(0, 80)}`);
      continue;
    }

    try {
      const xml = await fetchTextLimited(safeUrl);
      const storeName = (feed.name || 'Promobit / RSS').slice(0, 80);
      out.push(...parseRssXmlOffers(xml, term, storeName));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'erro de leitura';
      errors.push(`RSS (${feed.name || 'feed'}): ${msg}`);
    }
  }

  return { offers: out, errors };
}

export function normalizeOfferPricing(offer: Offer, usdToBrlRate: number | null = null): Offer {
  const price = Number.isFinite(Number(offer.price)) && Number(offer.price) > 0 ? Number(Number(offer.price).toFixed(2)) : 0;
  if (price <= 0) {
    return { ...offer, price: 0, original_price: 0, discount: 0 };
  }

  let originalPrice =
    Number.isFinite(Number(offer.original_price)) && Number(offer.original_price) > 0
      ? Number(Number(offer.original_price).toFixed(2))
      : price;

  let discount =
    Number.isFinite(Number(offer.discount)) && Number(offer.discount) > 0
      ? Math.min(100, Math.round(Number(offer.discount)))
      : 0;

  if (originalPrice < price) {
    originalPrice = price;
  }

  if (originalPrice > price) {
    discount = Math.max(0, Math.min(100, Math.round(((originalPrice - price) / originalPrice) * 100)));
  } else if (discount > 0 && discount < 100) {
    originalPrice = Number((price / (1 - discount / 100)).toFixed(2));
  } else {
    discount = 0;
  }

  const normalized: Offer = {
    ...offer,
    price,
    original_price: originalPrice,
    discount
  };

  if (offer.currency === 'USD' && usdToBrlRate && usdToBrlRate > 0) {
    normalized.price_brl_estimated = Math.round(Math.round(price * 100) * usdToBrlRate) / 100;
    normalized.original_price_brl_estimated = Math.round(Math.round(originalPrice * 100) * usdToBrlRate) / 100;
  }

  return normalized;
}

export function qualifies(item: MonitorItem, offer: Offer, usdToBrlRate: number | null = null): boolean {
  if (!Number.isFinite(offer.price) || offer.price <= 0) return false;

  const filterCurr = item.currency_filter || 'ALL';
  if (filterCurr !== 'ALL' && offer.currency !== filterCurr) return false;

  const hasRule = item.target_price !== null || item.min_discount !== null;
  if (!hasRule) return false;

  let priceOk = false;
  if (item.target_price !== null) {
    if (filterCurr === 'ALL') {
      if (offer.currency === 'BRL') {
        priceOk = offer.price <= item.target_price;
      } else if (offer.currency === 'USD' && usdToBrlRate && usdToBrlRate > 0) {
        priceOk = offer.price * usdToBrlRate <= item.target_price;
      }
    } else if (offer.currency === filterCurr) {
      priceOk = offer.price <= item.target_price;
    }
  }

  const discountOk = item.min_discount !== null && offer.discount >= item.min_discount;
  return priceOk || discountOk;
}

export async function searchSources(
  term: string,
  sources: string[],
  extraFeeds: RssFeedConfig[] = [],
  currencyFilter: CurrencyFilter = 'ALL',
  category: ProductCategory = 'Auto'
): Promise<{ offers: Offer[]; errors: string[]; usd_to_brl_rate: number | null; detected_category: Exclude<ProductCategory, 'Auto'> }> {
  let offers: Offer[] = [];
  const errors: string[] = [];

  const detectedCategory = category === 'Auto' ? detectQueryCategory(term) : category;
  const isNonGameAuto = category === 'Auto' && detectedCategory !== 'Jogos';

  // Em pesquisa livre (Auto), se o termo for Software/Hardware/Eletrônicos (ex.: "windows 11"),
  // evita poluir a busca com links de lojas exclusivas de jogos e inclui fontes de varejo/software.
  let effectiveSources = Array.from(new Set(sources));
  if (isNonGameAuto) {
    const nonGameSelected = effectiveSources.filter((s) => !GAME_ONLY_SOURCES.has(s));
    effectiveSources = Array.from(new Set([...nonGameSelected, ...NON_GAME_DEFAULT_SOURCES]));
  }

  const ratePromise = getUsdToBrlRate();

  await Promise.all(
    effectiveSources.map(async (src) => {
      try {
        if (src === 'Steam') {
          offers.push(...(await steamSearch(term)));
        } else if (src === 'CheapShark (USD)' || src === 'CheapShark') {
          offers.push(...(await cheapsharkSearch(term)));
        } else if (src === 'Epic Games') {
          const epicDeals = await cheapsharkSearch(term, '25', 'Epic Games');
          if (epicDeals.length > 0) {
            offers.push(...epicDeals);
          } else if (detectedCategory === 'Jogos') {
            offers.push({
              name: `${term} (Busca direta na Epic Games Store)`,
              store: 'Epic Games',
              kind: 'Comparador / Loja',
              delivery_type: detectDeliveryType(term, 'Epic Games'),
              currency: 'BRL',
              price: 0,
              original_price: 0,
              discount: 0,
              url: `https://store.epicgames.com/pt-BR/browse?q=${encodeURIComponent(term)}&sortBy=relevancy`,
              checked_at: new Date().toISOString()
            });
          }
        } else if (src === 'GOG') {
          const gogDeals = await gogDirectSearch(term);
          if (gogDeals.length > 0) {
            offers.push(...gogDeals);
          } else if (detectedCategory === 'Jogos') {
            offers.push({
              name: `${term} (Catálogo GOG)`,
              store: 'GOG',
              kind: 'Comparador / Loja',
              delivery_type: detectDeliveryType(term, 'GOG'),
              currency: 'BRL',
              price: 0,
              original_price: 0,
              discount: 0,
              url: `https://www.gog.com/en/games?query=${encodeURIComponent(term)}`,
              checked_at: new Date().toISOString()
            });
          }
        } else if (src === 'Nuuvem') {
          if (detectedCategory === 'Jogos' || category === 'Jogos') {
            offers.push({
              name: `${term} (Chave de Ativação - Nuuvem Brasil)`,
              store: 'Nuuvem',
              kind: 'Comparador / Loja',
              delivery_type: 'Chave (Key)',
              currency: 'BRL',
              price: 0,
              original_price: 0,
              discount: 0,
              url: `https://www.nuuvem.com/br-pt/catalog/search/${encodeURIComponent(term)}`,
              checked_at: new Date().toISOString()
            });
          }
        } else if (src === 'Mercado Livre') {
          offers.push(...(await mercadoLivreSearch(term)));
        } else if (src === 'KaBuM!') {
          offers.push({
            name: `${term} (Buscar na KaBuM!)`,
            store: 'KaBuM!',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'KaBuM!'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: `https://www.kabum.com.br/busca/${encodeURIComponent(term.trim().replace(/\s+/g, '-'))}`,
            checked_at: new Date().toISOString()
          });
        } else if (src === 'Buscapé') {
          offers.push({
            name: `${term} (Comparar preços no Buscapé)`,
            store: 'Buscapé',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Buscapé'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: `https://www.buscape.com.br/search?q=${encodeURIComponent(term)}`,
            checked_at: new Date().toISOString()
          });
        } else if (src === 'AllKeyShop') {
          offers.push({
            name: `${term} (Comparar chaves no AllKeyShop)`,
            store: 'AllKeyShop',
            kind: 'Comparador / Loja',
            delivery_type: 'Chave (Key)',
            currency: 'USD',
            price: 0,
            original_price: 0,
            discount: 0,
            url: `https://www.allkeyshop.com/blog/catalogue/search-${encodeURIComponent(term)}/`,
            checked_at: new Date().toISOString()
          });
        } else if (src === 'Google Shopping') {
          offers.push({
            name: `${term} (Ofertas no Google Shopping)`,
            store: 'Google Shopping',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Google Shopping'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: `https://www.google.com.br/search?tbm=shop&q=${encodeURIComponent(term)}`,
            checked_at: new Date().toISOString()
          });
        } else if (src === 'Amazon') {
          offers.push({
            name: `${term} (Ofertas na Amazon Brasil)`,
            store: 'Amazon',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Amazon'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: `https://www.amazon.com.br/s?k=${encodeURIComponent(term)}`,
            checked_at: new Date().toISOString()
          });
        } else if (src === 'Sites de cupons') {
          offers.push({
            name: `${term} (Buscar promoções e cupons no Pelando)`,
            store: 'Sites de cupons',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Pelando'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: `https://www.pelando.com.br/busca?q=${encodeURIComponent(term)}`,
            checked_at: new Date().toISOString()
          });
        } else if (src === 'Promobit (RSS)' || src === 'RSS' || src === 'Feeds RSS') {
          const rssRes = await rssSearch(term, extraFeeds);
          errors.push(...rssRes.errors);
          if (rssRes.offers.length > 0) {
            offers.push(...rssRes.offers);
          } else {
            offers.push({
              name: `${term} (Comunidade de Ofertas Promobit)`,
              store: 'Promobit (RSS)',
              kind: 'Comparador / Loja',
              delivery_type: detectDeliveryType(term, 'Promobit'),
              currency: 'BRL',
              price: 0,
              original_price: 0,
              discount: 0,
              url: `https://www.promobit.com.br/buscar/?q=${encodeURIComponent(term)}`,
              checked_at: new Date().toISOString()
            });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro na consulta';
        errors.push(`${src}: ${msg}`);
      }
    })
  );

  const usdToBrlRate = await ratePromise;

  // Deduplicar ofertas idênticas por loja + url + moeda
  const seen = new Set<string>();
  offers = offers.filter((o) => {
    if (!Number.isFinite(o.price) || o.price <= 0 || !matchesSearchTerm(o.name, term)) return false;
    if (!cleanHttpUrl(o.url)) return false;
    const key = `${o.store}|${o.currency}|${o.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Normalizar sempre valor original, valor encontrado e porcentagem aplicada (+ estimativa BRL se USD)
  offers = offers.map((o) => normalizeOfferPricing(o, usdToBrlRate));

  // Filtrar por moeda selecionada
  if (currencyFilter === 'BRL' || currencyFilter === 'USD') {
    offers = offers.filter((o) => o.currency === currencyFilter);
  }

  // Ordenar: ofertas com preço real primeiro (priorizando relevância alta e menor preço equivalente)
  await attachCouponsToOffers(offers);

  offers.sort((a, b) => {
    if (a.price > 0 && b.price === 0) return -1;
    if (a.price === 0 && b.price > 0) return 1;
    if (a.price > 0 && b.price > 0) {
      const relA = a.relevance ?? 50;
      const relB = b.relevance ?? 50;
      if (Math.abs(relB - relA) >= 20) return relB - relA;
      const valA = a.currency === 'USD' && a.price_brl_estimated ? a.price_brl_estimated : a.price;
      const valB = b.currency === 'USD' && b.price_brl_estimated ? b.price_brl_estimated : b.price;
      return valA - valB;
    }
    return a.store.localeCompare(b.store);
  });

  return { offers, errors, usd_to_brl_rate: usdToBrlRate, detected_category: detectedCategory };
}
