import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { detectDeliveryType } from '../lib/classifier.js';
import { formatNotificationMessage } from '../lib/notifications.js';
import {
  detectQueryCategory,
  matchesSearchTerm,
  normalizeForSearch,
  scoreOfferRelevance
} from '../lib/relevance.js';
import { filterActiveStoreCoupons, filterCouponsForProduct, normalizeOfferPricing, parseRssXmlOffers, qualifies, searchSources } from '../lib/search.js';
import {
  buildAlertDedupKey,
  checkRateLimit,
  cleanHttpUrl,
  getCorsOrigin,
  isAuthorizedCron,
  isValidEmail,
  parsePriceString,
  validateExternalFetchUrl
} from '../lib/security.js';
import type { MonitorItem, Offer } from '../lib/types.js';
import { scanRequestSchema, searchRequestSchema } from '../lib/validation.js';

// --- 1. Testes de Relevância e Pesquisa Livre ("windows 11") ---
test('Relevância: rejeita falsos positivos como "Absolute Skat for Windows 11" ao buscar "windows 11"', () => {
  assert.equal(matchesSearchTerm('Absolute Skat for Windows 11', 'windows 11'), false);
  assert.equal(matchesSearchTerm('Absolute Solitaire for Windows 11', 'windows 11'), false);
  assert.equal(matchesSearchTerm('App Compatível com Windows 11', 'windows 11'), false);
  assert.equal(matchesSearchTerm('Windowsill', 'windows 11'), false);
  assert.equal(matchesSearchTerm('11-11 Memories Retold', 'windows 11'), false);
  assert.equal(matchesSearchTerm('Microsoft Windows 10 Pro', 'windows 11'), false);

  assert.equal(matchesSearchTerm('Windows 11 Pro Chave Digital ESD', 'windows 11'), true);
  assert.equal(matchesSearchTerm('Microsoft Windows 11 Home 64 Bits', 'windows 11'), true);
  assert.equal(matchesSearchTerm('Windows11 Pro Retail Original', 'windows 11'), true);
});

test('Relevância: ordena produto focado acima de menções secundárias e mantém jogos corretos', () => {
  const directScore = scoreOfferRelevance('Windows 11 Pro Chave Original', 'windows 11');
  const laptopScore = scoreOfferRelevance(
    'Notebook Dell Inspiron 15 Intel Core i5 16GB SSD 512GB Windows 11 Home',
    'windows 11'
  );
  assert.ok(directScore > laptopScore, `Esperava ${directScore} > ${laptopScore}`);

  assert.equal(matchesSearchTerm('Hades', 'Hades'), true);
  assert.equal(matchesSearchTerm('Hades II', 'Hades'), true);
  assert.equal(matchesSearchTerm('Cyberpunk 2077: Ultimate Edition', 'Cyberpunk 2077'), true);
  assert.equal(matchesSearchTerm('Cyberpunk Dreams', 'Cyberpunk 2077'), false);
  assert.equal(normalizeForSearch('Promoção RTX4070'), 'promocao rtx 4070');
});

test('Detecção automática de categoria para pesquisa livre', () => {
  assert.equal(detectQueryCategory('windows 11'), 'Software');
  assert.equal(detectQueryCategory('Microsoft Office 365'), 'Software');
  assert.equal(detectQueryCategory('RTX 4070 Super'), 'Hardware');
  assert.equal(detectQueryCategory('SSD NVMe 1TB'), 'Hardware');
  assert.equal(detectQueryCategory('iPhone 15 Pro'), 'Eletrônicos');
  assert.equal(detectQueryCategory('Elden Ring'), 'Jogos');
});

// --- 2. Testes de Segurança ---
test('Segurança SSRF: bloqueia hosts privados, localhost, metadata e URLs inválidas', () => {
  const blocked = [
    'http://localhost/feed.xml',
    'http://127.0.0.1:8080/rss',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/internal',
    'http://192.168.1.1/admin',
    'http://172.16.0.5/feed',
    'http://[::1]/feed',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://user:pass@example.com/rss',
    'https://example.com:8443/rss',
    'file:///etc/passwd',
    'javascript:alert(1)'
  ];

  for (const url of blocked) {
    assert.equal(validateExternalFetchUrl(url), null, `Deveria bloquear: ${url}`);
  }

  assert.equal(validateExternalFetchUrl('https://feeds.example.com/deals.xml'), 'https://feeds.example.com/deals.xml');
  assert.equal(cleanHttpUrl('javascript:alert(1)'), '');
  assert.equal(cleanHttpUrl('https://store.steampowered.com/app/1145360/'), 'https://store.steampowered.com/app/1145360/');
});

test('Segurança: validação de CRON_SECRET, e-mail, CORS e rate limit', () => {
  const prevSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'super-secret-token-123';
  try {
    assert.equal(isAuthorizedCron(undefined), false);
    assert.equal(isAuthorizedCron('Bearer errado'), false);
    assert.equal(isAuthorizedCron('Bearer super-secret-token-123'), true);
  } finally {
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
  }

  assert.equal(isValidEmail('usuario@exemplo.com.br'), true);
  assert.equal(isValidEmail('invalido@'), false);
  assert.equal(isValidEmail('sem-arroba.com'), false);

  assert.equal(getCorsOrigin('http://127.0.0.1:8765', '127.0.0.1:8765'), 'http://127.0.0.1:8765');
  assert.equal(getCorsOrigin('https://evil.example', 'monitordepromocoes.vercel.app'), '');

  const key = `test-rate-${Date.now()}`;
  assert.equal(checkRateLimit(key, 2, 10_000).allowed, true);
  assert.equal(checkRateLimit(key, 2, 10_000).allowed, true);
  assert.equal(checkRateLimit(key, 2, 10_000).allowed, false);
});

// --- 3. Parsing de Preços e XML RSS/Atom ---
test('Parser de preços suporta formatos BRL e USD corretamente', () => {
  assert.equal(parsePriceString('1.299,90', false), 1299.9);
  assert.equal(parsePriceString('59,90', false), 59.9);
  assert.equal(parsePriceString('19.99', true), 19.99);
  assert.equal(parsePriceString('1,299.99', true), 1299.99);
  assert.equal(parsePriceString('19.99', false), 19.99);
});

test('Parser RSS/Atom com fast-xml-parser extrai preços BRL e USD e aplica filtro de relevância', () => {
  const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Ofertas Teste</title>
        <item>
          <title>Windows 11 Pro Licença Digital ESD</title>
          <link>https://loja.exemplo.com/win11-pro</link>
          <description>Promoção por R$ 89,90 ativação original</description>
        </item>
        <item>
          <title>Windows 11 Pro Global Key</title>
          <link>https://keys.exemplo.com/win11-usd</link>
          <description>Oferta especial US$ 19.99</description>
        </item>
        <item>
          <title>Absolute Skat for Windows 11</title>
          <link>https://store.exemplo.com/skat</link>
          <description>Jogo de cartas R$ 41,99</description>
        </item>
      </channel>
    </rss>`;

  const offers = parseRssXmlOffers(sampleRss, 'windows 11', 'Feed Teste');
  assert.equal(offers.length, 2);
  assert.equal(offers[0]?.currency, 'BRL');
  assert.equal(offers[0]?.price, 89.9);
  assert.equal(offers[0]?.original_price, 89.9);
  assert.equal(offers[0]?.discount, 0);
  assert.equal(offers[0]?.delivery_type, 'Chave (Key)');
  assert.equal(offers[1]?.currency, 'USD');
  assert.equal(offers[1]?.price, 19.99);

  const promoRss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <item>
        <title>Windows 11 Pro Original</title>
        <link>https://loja.exemplo.com/win11-promo</link>
        <description>De R$ 200,00 por R$ 100,00</description>
      </item>
      <item>
        <title>Windows 11 Home Key -50% OFF</title>
        <link>https://keys.exemplo.com/win11-home</link>
        <description>Oferta por US$ 20.00</description>
      </item>
    </channel></rss>`;

  const promoOffers = parseRssXmlOffers(promoRss, 'windows 11', 'Feed Promo');
  assert.equal(promoOffers.length, 2);
  assert.equal(promoOffers[0]?.original_price, 200);
  assert.equal(promoOffers[0]?.price, 100);
  assert.equal(promoOffers[0]?.discount, 50);
  assert.equal(promoOffers[1]?.original_price, 40);
  assert.equal(promoOffers[1]?.price, 20);
  assert.equal(promoOffers[1]?.discount, 50);
});

test('Preservação de valor original, valor encontrado e desconto aplicado em ofertas e notificações', () => {
  const normalized = normalizeOfferPricing(
    {
      name: 'Cyberpunk 2077',
      store: 'GOG',
      kind: 'Loja oficial',
      delivery_type: 'Ativação Direta (Conta)',
      currency: 'USD',
      original_price: 59.99,
      price: 29.99,
      discount: 0,
      url: 'https://www.gog.com/en/game/cyberpunk_2077'
    },
    5.5
  );

  assert.equal(normalized.original_price, 59.99);
  assert.equal(normalized.price, 29.99);
  assert.equal(normalized.discount, 50);
  assert.equal(normalized.original_price_brl_estimated, 329.95);
  assert.equal(normalized.price_brl_estimated, 164.95);

  const msg = formatNotificationMessage(normalized);
  assert.ok(msg.includes('Valor original: US$ 59.99 (~R$ 329.95)'));
  assert.ok(msg.includes('Valor encontrado: US$ 29.99 (~R$ 164.95)'));
  assert.ok(msg.includes('Desconto aplicado: 50%'));
});

// --- 4. Classificação Chave vs Ativação Direta vs Conta ---
test('Classificador distingue Chave (Key), Ativação Direta (Conta) e Conta', () => {
  assert.equal(detectDeliveryType('Windows 11 Pro Licença Digital ESD', 'Amazon'), 'Chave (Key)');
  assert.equal(detectDeliveryType('Elden Ring', 'Steam'), 'Ativação Direta (Conta)');
  assert.equal(detectDeliveryType('Cyberpunk 2077', 'GOG'), 'Ativação Direta (Conta)');
  assert.equal(detectDeliveryType('Hades', 'Nuuvem'), 'Chave (Key)');
  assert.equal(detectDeliveryType('Elden Ring Conta Compartilhada Steam', 'Google Shopping'), 'Conta');
  assert.equal(detectDeliveryType('No Man Sky Offline Mode', 'Steam'), 'Ativação Direta (Conta)');
});

// --- 5. Qualificação de Alertas, Deduplicação e Validação Zod ---
test('qualifies() suporta BRL, USD e ALL com conversão cambial + dedup determinística', () => {
  const baseItem: MonitorItem = {
    id: 'item-1',
    name: 'Windows 11',
    category: 'Software',
    currency_filter: 'ALL',
    target_price: 100,
    min_discount: 50,
    sources: ['Google Shopping'],
    channels: ['Painel', 'E-mail'],
    destinations: { 'E-mail': 'teste@exemplo.com' },
    frequency: 'A cada hora',
    active: true,
    created_at: new Date().toISOString()
  };

  const usdOffer: Offer = {
    name: 'Windows 11 Pro Key',
    store: 'AllKeyShop',
    kind: 'Revendedor',
    delivery_type: 'Chave (Key)',
    currency: 'USD',
    original_price: 30,
    price: 15,
    discount: 10,
    url: 'https://keys.exemplo.com/win11'
  };

  // USD 15 * 5.5 = R$ 82,50 <= R$ 100 -> qualifica!
  assert.equal(qualifies(baseItem, usdOffer, 5.5), true);
  // USD 15 * 7.0 = R$ 105 > R$ 100 e desconto 10% < 50% -> não qualifica
  assert.equal(qualifies(baseItem, usdOffer, 7.0), false);

  const key1 = buildAlertDedupKey('item-1', usdOffer);
  const key2 = buildAlertDedupKey('item-1', { ...usdOffer, url: 'https://keys.exemplo.com/win11?ref=123' });
  assert.equal(key1, key2);

  assert.equal(searchRequestSchema.safeParse({ term: '', sources: ['Steam'] }).success, false);
  assert.equal(searchRequestSchema.safeParse({ term: 'windows 11', sources: ['Google Shopping'] }).success, true);
  assert.equal(searchRequestSchema.safeParse({ term: 'windows 11', sources: [] }).success, true);
  assert.equal(searchRequestSchema.safeParse({ term: 'windows 11' }).success, true);
  assert.equal(scanRequestSchema.safeParse({ items: Array(21).fill(baseItem) }).success, false);
});

test('Cupons: mantém somente códigos ativos, da mesma loja e com links HTTP seguros', () => {
  const coupons = filterActiveStoreCoupons([
    {
      code: 'AMAZON10', title: '10% na primeira compra', store_name: 'Amazon',
      expires_at: '2026-11-27T03:00:00.000Z', url: 'https://cupomdescontos.com/ir/amazon',
      source_url: 'https://cupomdescontos.com/cupom/amazon'
    },
    {
      code: 'VENCIDO', title: 'Cupom expirado', store_name: 'Amazon',
      expires_at: '2026-11-24T03:00:00.000Z', url: 'https://cupomdescontos.com/ir/amazon',
      source_url: 'https://cupomdescontos.com/cupom/amazon'
    },
    {
      code: 'OUTRA-LOJA', title: 'Outro cupom', store_name: 'Magalu',
      url: 'https://cupomdescontos.com/ir/magalu', source_url: 'https://cupomdescontos.com/cupom/magalu'
    },
    {
      code: 'URL-INVÁLIDA', title: 'Link inseguro', store_name: 'Amazon',
      url: 'javascript:alert(1)', source_url: 'https://cupomdescontos.com/cupom/amazon'
    }
  ], 'Amazon', Date.parse('2026-11-25T12:00:00.000Z'));

  assert.equal(coupons.length, 1);
  assert.equal(coupons[0]?.code, 'AMAZON10');
  assert.equal(coupons[0]?.status, 'Vigente na fonte; checkout não testado');

  const productCoupons = filterCouponsForProduct([
    ...coupons,
    { ...coupons[0]!, code: 'JOGOS10', title: '10% de desconto em jogos' },
    { ...coupons[0]!, code: 'TV10', title: '10% em televisores selecionados' },
    { ...coupons[0]!, code: 'SEMJOGOS', title: '10% em todos os produtos, exceto jogos' }
  ], 'Hades', 'Jogos');
  assert.deepEqual(productCoupons.map((coupon) => coupon.code), ['AMAZON10', 'JOGOS10']);
});

// --- 6. Pesquisa Livre ("windows 11") em modo Auto não retorna lojas de jogos ---
test('searchSources em modo Auto para "windows 11" detecta Software e remove lojas exclusivas de jogos', async () => {
  const res = await searchSources(
    'windows 11',
    [],
    [],
    'ALL',
    'Auto'
  );

  assert.equal(res.detected_category, 'Software');
  assert.equal(res.offers.some((o) => ['Steam', 'GOG', 'Epic Games', 'Nuuvem'].includes(o.store)), false);
  assert.equal(res.offers.every((offer) => offer.price > 0), true);
  assert.equal(res.offers.every((offer) => matchesSearchTerm(offer.name, 'windows 11')), true);
  assert.equal(res.offers.every((offer) => cleanHttpUrl(offer.url) !== ''), true);
});

// --- 7. Teste HTTP End-to-End no dev-server.mjs ---
test('Servidor HTTP local: rotas estáticas, PWA assets, API e proteção Path Traversal', async () => {
  const devServerUrl = pathToFileURL(path.resolve(process.cwd(), 'dev-server.mjs')).href;
  const { createAppServer } = (await import(devServerUrl)) as {
    createAppServer: () => http.Server;
  };
  const server = createAppServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // Healthcheck + headers de segurança
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
    const healthJson = (await healthRes.json()) as { ok: boolean; version: string };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.version, '5.1.0');

    // Assets PWA existem (corrige falha de instalação do Service Worker)
    for (const asset of ['/', '/styles.css', '/app.js', '/manifest.json', '/sw.js', '/icon.svg']) {
      const r = await fetch(`${baseUrl}${asset}`);
      assert.equal(r.status, 200, `Asset ${asset} deveria retornar 200`);
    }

    // Proteção contra Path Traversal
    const rawTraversalStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port: address.port, path: '/%2e%2e/package.json' },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        }
      );
      req.on('error', reject);
    });
    assert.equal(rawTraversalStatus, 403);

    // Validação Zod em /api/search
    const badSearch = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: '', sources: [] })
    });
    assert.equal(badSearch.status, 400);

    // Pesquisa livre "windows 11" via HTTP
    const winSearch = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        term: 'windows 11',
        sources: ['Steam', 'GOG', 'Google Shopping', 'Amazon'],
        currency: 'ALL',
        category: 'Auto'
      })
    });
    assert.equal(winSearch.status, 200);
    const winData = (await winSearch.json()) as { detected_category: string; offers: Offer[] };
    assert.equal(winData.detected_category, 'Software');
    assert.equal(
      winData.offers.some((o) => o.name.toLowerCase().includes('absolute skat')),
      false
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
