import type { VercelRequest, VercelResponse } from '@vercel/node';
import nodemailer from 'nodemailer';

export type DeliveryType = 'Chave (Key)' | 'Conta' | 'Ativação Direta (Conta)';

export interface Offer {
  name: string;
  store: string;
  kind: 'Loja oficial' | 'Revendedor' | 'Comparador / Loja' | 'RSS';
  delivery_type: DeliveryType;
  currency: 'BRL' | 'USD';
  original_price: number;
  price: number;
  discount: number;
  url: string;
  thumb?: string;
  checked_at?: string;
}

export interface MonitorItem {
  id: string;
  name: string;
  category: string;
  currency_filter?: 'ALL' | 'BRL' | 'USD';
  target_price: number | null;
  min_discount: number | null;
  sources: string[];
  channels: string[];
  destinations: Record<string, string>;
  frequency: string;
  active: boolean;
  created_at: string;
  last_checked?: string;
}

const CS_STORES: Record<string, string> = {
  '1': 'Steam', '2': 'GamersGate', '3': 'Green Man Gaming', '7': 'GOG',
  '11': 'Humble Store', '13': 'Ubisoft Store', '15': 'Fanatical', '21': 'WinGameStore',
  '23': 'GameBillet', '24': 'Voidu', '25': 'Epic Games', '27': 'Gamesplanet',
  '28': 'Gamesload', '29': '2Game', '30': 'IndieGala', '31': 'Blizzard Shop',
  '33': 'DLGamer', '34': 'Noctre', '35': 'DreamGame'
};

// Detecta se a oferta trata de uma Conta ou Chave (Key) com base no título, descrição e loja
export function detectDeliveryType(title: string, store: string, extraText = ''): DeliveryType {
  const combined = `${title} ${extraText}`.toLowerCase();
  const accountKeywords = [
    'conta ', 'conta-', 'account', 'offline', 'compartilhada', 'primária', 'primaria',
    'secundária', 'secundaria', 'steam account', 'psn account', 'xbox account', 'acesso completo'
  ];
  for (const kw of accountKeywords) {
    if (combined.includes(kw)) return 'Conta';
  }
  const keyKeywords = [
    'key', 'chave', 'código', 'codigo', 'cd-key', 'cdkey', 'steam key', 'global key', 'gift card', 'voucher'
  ];
  for (const kw of keyKeywords) {
    if (combined.includes(kw)) return 'Chave (Key)';
  }

  const s = store.toLowerCase();
  // Revendedores autorizados de chaves (Humble, Nuuvem, Green Man Gaming, Fanatical, GamersGate, etc.)
  if (
    s.includes('nuuvem') || s.includes('green man') || s.includes('humble') ||
    s.includes('fanatical') || s.includes('gamersgate') || s.includes('wingamestore') ||
    s.includes('gamebillet') || s.includes('voidu') || s.includes('gamesplanet') ||
    s.includes('2game') || s.includes('indiegala') || s.includes('dlgamer') ||
    s.includes('dreamgame') || s.includes('cheapshark')
  ) {
    return 'Chave (Key)';
  }

  // Lojas oficiais (Steam, Epic, GOG) entregam ativação direta na conta ou chave
  if (s === 'steam' || s.includes('epic') || s === 'gog') {
    return 'Chave (Key)';
  }

  return 'Chave (Key)';
}

function cleanUrl(u: unknown): string {
  if (typeof u !== 'string' || (!u.startsWith('https://') && !u.startsWith('http://'))) {
    return '';
  }
  return u.slice(0, 2000);
}

async function fetchJson<T>(url: string, timeoutMs = 12000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'PromoMonitor/5.0 (TypeScript PWA)',
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function steamSearch(term: string): Promise<Offer[]> {
  const out: Offer[] = [];
  const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=br&l=brazilian`;
  const data = await fetchJson<{ items?: Array<{ id?: number; name?: string; tiny_image?: string; price?: { final?: number; initial?: number } }> }>(searchUrl);

  const items = (data.items ?? []).slice(0, 8);
  const detailsPromises = items.map(async (app) => {
    if (!app.id) return null;
    try {
      const detailUrl = `https://store.steampowered.com/api/appdetails?appids=${app.id}&cc=br&l=brazilian`;
      const detail = await fetchJson<Record<string, { data?: any }>>(detailUrl, 9000);
      const entry = detail[String(app.id)]?.data;
      const itemName = entry?.name || app.name || term;

      if (!entry?.price_overview) {
        if (app.price?.final) {
          const cents = Number(app.price.final);
          const orig = Number(app.price.initial ?? cents);
          const disc = orig > cents ? Math.round(((orig - cents) / orig) * 100) : 0;
          return {
            name: itemName,
            store: 'Steam',
            kind: 'Loja oficial' as const,
            delivery_type: detectDeliveryType(itemName, 'Steam'),
            currency: 'BRL' as const,
            price: cents / 100,
            original_price: orig / 100,
            discount: disc,
            url: `https://store.steampowered.com/app/${app.id}/`,
            thumb: app.tiny_image,
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
        kind: 'Loja oficial' as const,
        delivery_type: detectDeliveryType(itemName, 'Steam'),
        currency: 'BRL' as const,
        price: cents / 100,
        original_price: orig / 100,
        discount: Number(p.discount_percent ?? 0),
        url: cleanUrl(entry.store_url || `https://store.steampowered.com/app/${app.id}/`),
        thumb: entry.header_image || app.tiny_image,
        checked_at: new Date().toISOString()
      };
    } catch {
      return null;
    }
  });

  const resolved = await Promise.all(detailsPromises);
  for (const item of resolved) {
    if (item) out.push(item);
  }
  return out;
}

async function cheapsharkSearch(term: string, storeFilter?: string, customStoreLabel?: string): Promise<Offer[]> {
  let url = `https://www.cheapshark.com/api/1.0/deals?title=${encodeURIComponent(term)}&pageSize=12&sortBy=Price`;
  if (storeFilter) {
    url += `&storeID=${encodeURIComponent(storeFilter)}`;
  }
  const data = await fetchJson<any[]>(url);
  if (!Array.isArray(data)) return [];

  return data.map((d) => {
    const storeName = customStoreLabel || CS_STORES[String(d.storeID)] || `CheapShark (Loja ${d.storeID ?? '?'})`;
    const title = String(d.title || term);
    return {
      name: title,
      store: storeName,
      kind: (storeFilter === '25' || storeFilter === '7') ? 'Loja oficial' as const : 'Revendedor' as const,
      delivery_type: detectDeliveryType(title, storeName),
      currency: 'USD' as const,
      price: Number(d.salePrice ?? 0),
      original_price: Number(d.normalPrice ?? 0),
      discount: Number(d.savings ?? 0),
      url: cleanUrl(`https://www.cheapshark.com/redirect?dealID=${d.dealID ?? ''}`),
      thumb: cleanUrl(d.thumb),
      checked_at: new Date().toISOString()
    };
  });
}

async function gogDirectSearch(term: string): Promise<Offer[]> {
  try {
    const url = `https://embed.gog.com/games/ajax/filtered?mediaType=game&search=${encodeURIComponent(term)}`;
    const data = await fetchJson<{ products?: any[] }>(url, 9000);
    const products = (data.products ?? []).slice(0, 6);
    const out: Offer[] = [];
    for (const p of products) {
      if (!p.price) continue;
      const finalAmount = parseFloat(String(p.price.finalAmount ?? p.price.amount ?? '0').replace(',', '.'));
      const baseAmount = parseFloat(String(p.price.baseAmount ?? finalAmount).replace(',', '.'));
      if (Number.isNaN(finalAmount) || finalAmount <= 0) continue;
      const symbol = String(p.price.symbol || '').toUpperCase();
      const currency: 'BRL' | 'USD' = (symbol.includes('R$') || symbol.includes('BRL')) ? 'BRL' : 'USD';
      const title = String(p.title || term);
      out.push({
        name: title,
        store: 'GOG',
        kind: 'Loja oficial',
        delivery_type: detectDeliveryType(title, 'GOG'),
        currency,
        price: finalAmount,
        original_price: baseAmount > 0 ? baseAmount : finalAmount,
        discount: Number(p.price.discountPercentage ?? p.price.discount ?? 0),
        url: cleanUrl(p.url ? `https://www.gog.com${p.url}` : `https://www.gog.com/en/games?query=${encodeURIComponent(term)}`),
        checked_at: new Date().toISOString()
      });
    }
    if (out.length > 0) return out;
  } catch {}
  return cheapsharkSearch(term, '7', 'GOG');
}

async function rssSearch(term: string, extraFeeds: Array<{ name?: string; url?: string }> = []): Promise<Offer[]> {
  const out: Offer[] = [];
  let envFeeds: Array<{ name?: string; url?: string }> = [];
  try {
    envFeeds = JSON.parse(process.env.RSS_FEEDS || '[]');
  } catch {
    envFeeds = [];
  }
  const feeds = [...envFeeds, ...extraFeeds];

  for (const feed of feeds) {
    const url = cleanUrl(feed.url);
    if (!url) continue;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'PromoMonitor/5.0 RSS' } });
      const xml = await res.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match: RegExpExecArray | null;

      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || '').trim();
        if (!title.toLowerCase().includes(term.toLowerCase())) continue;

        const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
        const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] || '').replace(/<[^>]+>/g, ' ');

        const priceMatch = `${title} ${desc}`.match(/(?:R\$|BRL|US\$|USD)\s*([\d.,]+)/i);
        if (!priceMatch) continue;

        const isUsd = /US\$|USD/i.test(priceMatch[0]);
        const parsedPrice = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
        if (Number.isNaN(parsedPrice)) continue;

        const storeName = feed.name || 'Promobit / RSS';
        out.push({
          name: title.slice(0, 180),
          store: storeName,
          kind: 'RSS',
          delivery_type: detectDeliveryType(title, storeName, desc),
          currency: isUsd ? 'USD' : 'BRL',
          price: parsedPrice,
          original_price: parsedPrice,
          discount: 0,
          url: cleanUrl(link),
          checked_at: new Date().toISOString()
        });
      }
    } catch {}
  }
  return out;
}

function qualifies(item: MonitorItem, offer: Offer): boolean {
  if (offer.price <= 0) return false;
  const filterCurr = item.currency_filter || 'ALL';
  if (filterCurr !== 'ALL' && offer.currency !== filterCurr) return false;

  const hasRule = item.target_price !== null || item.min_discount !== null;
  if (!hasRule) return false;

  const priceOk =
    item.target_price !== null &&
    (filterCurr === 'ALL' ? offer.currency === 'BRL' : offer.currency === filterCurr) &&
    offer.price <= item.target_price;
  const discountOk = item.min_discount !== null && offer.discount >= item.min_discount;
  return priceOk || discountOk;
}

async function sendNotifications(item: MonitorItem, offer: Offer, runtimeConfig: Record<string, string> = {}): Promise<string[]> {
  const sent: string[] = [];
  const message = [
    `Promoção encontrada: ${offer.name}`,
    `Tipo: ${offer.delivery_type}`,
    `Loja: ${offer.store}`,
    `Preço: ${offer.currency} ${offer.price.toFixed(2)}`,
    `Desconto: ${Math.round(offer.discount)}%`,
    offer.url
  ].join('\n');

  const emailTo = item.destinations?.['E-mail'] || item.destinations?.email;
  if ((item.channels.includes('E-mail') || item.active) && emailTo && emailTo.includes('@')) {
    const smtpHost = runtimeConfig.smtp_host || process.env.SMTP_HOST;
    const smtpPort = Number(runtimeConfig.smtp_port || process.env.SMTP_PORT || 587);
    const smtpUser = runtimeConfig.smtp_user || process.env.SMTP_USER;
    const smtpPass = runtimeConfig.smtp_password || process.env.SMTP_PASSWORD;
    const smtpFrom = runtimeConfig.smtp_from || process.env.SMTP_FROM || smtpUser;

    if (smtpHost && smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          auth: { user: smtpUser, pass: smtpPass }
        });
        await transporter.sendMail({
          from: smtpFrom,
          to: emailTo,
          subject: `Promoção (${offer.delivery_type}): ${offer.name}`,
          text: message
        });
        sent.push('E-mail');
      } catch {}
    }
  }

  if (item.channels.includes('Telegram')) {
    const token = runtimeConfig.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = item.destinations?.Telegram || runtimeConfig.telegram_chat_id || process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message })
        });
        if (res.ok) sent.push('Telegram');
      } catch {}
    }
  }

  if (item.channels.includes('WhatsApp')) {
    const token = runtimeConfig.whatsapp_token || process.env.WHATSAPP_TOKEN;
    const phoneId = runtimeConfig.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const version = runtimeConfig.whatsapp_api_version || process.env.WHATSAPP_API_VERSION || 'v23.0';
    const to = item.destinations?.WhatsApp;
    if (token && phoneId && to) {
      try {
        const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: message }
          })
        });
        if (res.ok) sent.push('WhatsApp');
      } catch {}
    }
  }

  return sent;
}

export async function searchSources(
  term: string,
  sources: string[],
  extraFeeds: Array<{ name?: string; url?: string }> = [],
  currencyFilter: string = 'ALL'
) {
  let offers: Offer[] = [];
  const errors: string[] = [];

  await Promise.all(
    sources.map(async (src) => {
      try {
        if (src === 'Steam') {
          offers.push(...(await steamSearch(term)));
        } else if (src === 'CheapShark (USD)' || src === 'CheapShark') {
          offers.push(...(await cheapsharkSearch(term)));
        } else if (src === 'Epic Games') {
          const epicDeals = await cheapsharkSearch(term, '25', 'Epic Games');
          if (epicDeals.length > 0) {
            offers.push(...epicDeals);
          } else {
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
          offers.push(...(await gogDirectSearch(term)));
        } else if (src === 'Nuuvem') {
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
        } else if (src === 'Google Shopping') {
          offers.push({
            name: `${term} (Chaves e Contas no Google Shopping)`,
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
            name: `${term} (Mídia / Código Digital na Amazon Brasil)`,
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
            name: `${term} (Buscar promoções no Pelando)`,
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
          const rssDeals = await rssSearch(term, extraFeeds);
          if (rssDeals.length > 0) {
            offers.push(...rssDeals);
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
      } catch (err: any) {
        errors.push(`${src}: ${err?.message || 'Erro na consulta'}`);
      }
    })
  );

  // Filtra por moeda caso o usuário tenha selecionado BRL ou USD (se ALL/Livre, mantém todas)
  if (currencyFilter === 'BRL' || currencyFilter === 'USD') {
    offers = offers.filter((o) => o.currency === currencyFilter);
  }

  offers.sort((a, b) => {
    if (a.price > 0 && b.price === 0) return -1;
    if (a.price === 0 && b.price > 0) return 1;
    return a.price - b.price;
  });

  return { offers, errors };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/health') {
    return res.status(200).json({
      ok: true,
      runtime: 'Node.js / TypeScript (Vercel Serverless)',
      time: new Date().toISOString()
    });
  }

  if (req.method === 'POST' && path === '/api/search') {
    const { term, sources, rss_feeds, currency } = req.body || {};
    if (!term || !Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({ error: 'Informe o termo e ao menos uma fonte.' });
    }
    const result = await searchSources(
      String(term).trim(),
      sources,
      Array.isArray(rss_feeds) ? rss_feeds : [],
      currency || 'ALL'
    );
    return res.status(200).json(result);
  }

  if (req.method === 'POST' && path === '/api/scan') {
    const items: MonitorItem[] = Array.isArray(req.body?.items) ? req.body.items : [];
    const runtimeConfig = req.body?.config || {};
    const extraFeeds = Array.isArray(runtimeConfig.rss_feeds) ? runtimeConfig.rss_feeds : [];
    const results = [];

    for (const item of items) {
      if (!item.active) continue;

      const email = (item.destinations?.['E-mail'] || item.destinations?.email || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        results.push({
          item_id: item.id,
          item: item.name,
          offers: [],
          alerts: [],
          errors: ['Monitoramento ativo exige um e-mail válido cadastrado.']
        });
        continue;
      }

      const { offers, errors } = await searchSources(
        item.name,
        item.sources,
        extraFeeds,
        item.currency_filter || 'ALL'
      );
      const triggeredAlerts = [];

      for (const offer of offers) {
        if (qualifies(item, offer)) {
          const notified = await sendNotifications(item, offer, runtimeConfig);
          triggeredAlerts.push({
            ...offer,
            item_id: item.id,
            created_at: new Date().toISOString(),
            notified: notified.length ? notified.join(', ') : 'Painel'
          });
        }
      }

      results.push({
        item_id: item.id,
        item: item.name,
        offers,
        alerts: triggeredAlerts,
        errors
      });
    }

    return res.status(200).json({ results });
  }

  if (req.method === 'GET' && path === '/api/cron') {
    return res.status(200).json({ ok: true, message: 'Cron ativo.' });
  }

  return res.status(404).json({ error: 'Rota não encontrada' });
}
