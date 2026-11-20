(function () {
  'use strict';

  var STORAGE_ITEMS_KEY = 'monitordepromocoes_items_v5';
  var STORAGE_ALERTS_KEY = 'monitordepromocoes_alerts_v5';
  var STORAGE_CFG_KEY = 'promo_cfg';

  var serverOnline = false;
  var serverStorageMode = 'none';
  var isAutoScanning = false;

  // --- Utilitários de Segurança (XSS, URL, CSV) ---
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(raw) {
    if (typeof raw !== 'string') return '#';
    var trimmed = raw.trim();
    try {
      var parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return parsed.toString();
      }
    } catch (e) {}
    return '#';
  }

  function sanitizeCsvCell(value) {
    var str = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    return '"' + str.replace(/"/g, '""') + '"';
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
  }

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
  }

  function buildDedupKey(itemId, offer) {
    var cleanUrl = String(offer.url || '').split('?')[0].toLowerCase();
    return [
      itemId,
      String(offer.store || '').toLowerCase(),
      String(offer.currency || 'BRL'),
      Number(offer.price || 0).toFixed(2),
      cleanUrl
    ].join('|');
  }

  // --- Persistência local + sincronização opcional com servidor ---
  function getItems() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_ITEMS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveItems(items) {
    try {
      localStorage.setItem(STORAGE_ITEMS_KEY, JSON.stringify(items));
    } catch (e) {}
    if (serverOnline && serverStorageMode !== 'none') {
      fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items })
      }).catch(function () {});
    }
  }

  function getAlerts() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_ALERTS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveAlerts(alerts) {
    try {
      localStorage.setItem(STORAGE_ALERTS_KEY, JSON.stringify(alerts.slice(-300)));
    } catch (e) {}
  }

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_CFG_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  // --- Relevância & Classificação (espelha backend para modo offline/PWA) ---
  var STOPWORDS = {
    de: 1, da: 1, do: 1, das: 1, dos: 1, e: 1, a: 1, o: 1, as: 1, os: 1,
    em: 1, para: 1, por: 1, com: 1, the: 1, of: 1, and: 1, for: 1, to: 1, in: 1, on: 1
  };

  function normalizeText(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function extractTokens(term) {
    var norm = normalizeText(term);
    if (!norm) return [];
    var all = norm.split(' ').filter(Boolean);
    var filtered = all.filter(function (t) { return !STOPWORDS[t]; });
    return filtered.length ? filtered : all;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function matchesSearchTerm(offerTitle, searchTerm) {
    var qTokens = extractTokens(searchTerm);
    if (!qTokens.length) return true;
    var normTitle = normalizeText(offerTitle);
    var normTerm = normalizeText(searchTerm);
    if (!normTitle) return false;

    if (normTerm && !/\b(for|para|compativel|compatible)\b/.test(normTerm)) {
      var compatRe = new RegExp('\\b(for|para|on|compativel\\s+com|compatible\\s+with)\\s+' + escapeRegex(normTerm) + '\\b', 'g');
      if (compatRe.test(normTitle)) {
        var stripped = normTitle.replace(compatRe, ' ').replace(/\s+/g, ' ').trim();
        var strippedTokens = stripped.split(' ').filter(Boolean);
        var stillMatches = qTokens.every(function (qt) { return strippedTokens.indexOf(qt) !== -1; });
        if (!stillMatches) return false;
      }
    }

    var titleTokens = normTitle.split(' ').filter(Boolean);
    return qTokens.every(function (qt) {
      return titleTokens.some(function (tt) {
        if (tt === qt) return true;
        if (/^[a-z]{4,}$/.test(qt)) {
          return tt === qt + 's' || qt === tt + 's';
        }
        return false;
      });
    });
  }

  function detectQueryCategory(term) {
    var norm = normalizeText(term);
    if (/\b(windows\s*(7|8|10|11|server|pro|home)?|(microsoft\s*)?office\s*(365|2016|2019|2021|2024)?|microsoft\s*365|adobe|photoshop|coreldraw|autocad|antivirus|kaspersky|norton|bitdefender|licenca\s+digital)\b/i.test(norm)) {
      return 'Software';
    }
    if (/\b(rtx|gtx|radeon|ryzen|core\s*i[3579]|ssd|nvme|ddr[45]|placa\s*de\s*video|placa\s*mae|monitor\s*gamer|teclado\s*mecanico)\b/i.test(norm)) {
      return 'Hardware';
    }
    if (/\b(iphone|ipad|macbook|samsung\s*galaxy|xiaomi|notebook|laptop|smart\s*tv|kindle|playstation\s*5|xbox\s*series|nintendo\s*switch)\b/i.test(norm)) {
      return 'Eletrônicos';
    }
    return 'Jogos';
  }

  function detectDeliveryType(title, store, extraText) {
    var combined = String(title || '') + ' ' + String(extraText || '');
    var accountPatterns = [
      /\bconta\s+(compartilhada|prim[aá]ria|secund[aá]ria|offline|steam|psn|xbox|epic|completa)\b/i,
      /\b(steam|psn|xbox|epic|gog|microsoft)\s+account\b/i,
      /\b(shared|offline|full\s+access)\s+account\b/i
    ];
    for (var i = 0; i < accountPatterns.length; i++) {
      if (accountPatterns[i].test(combined)) return 'Conta';
    }

    if (/\b(cd[-\s]?key|steam\s+key|global\s+key|product\s+key|chave|licen[çc]a|serial|esd|oem|retail|voucher|key)\b/i.test(combined)) {
      return 'Chave (Key)';
    }

    var s = String(store || '').toLowerCase();
    if (s === 'steam' || s === 'gog' || s.indexOf('epic') !== -1) {
      return 'Ativação Direta (Conta)';
    }
    return 'Chave (Key)';
  }

  function formatDeliveryBadge(deliveryType) {
    var dtype = deliveryType || 'Chave (Key)';
    if (dtype === 'Conta') {
      return '<span class="tag account-badge">👤 Conta</span>';
    }
    if (dtype === 'Ativação Direta (Conta)') {
      return '<span class="tag direct-badge">⚡ Ativação Direta</span>';
    }
    return '<span class="tag key-badge">🔑 Chave (Key)</span>';
  }

  function formatCurrencySymbol(curr) {
    return curr === 'USD' ? 'US$' : 'R$';
  }

  function formatCurrLabel(curr) {
    if (curr === 'BRL') return 'Somente Real (R$)';
    if (curr === 'USD') return 'Somente Dólar (US$)';
    return 'Livre (BRL + USD)';
  }

  // --- Fontes por categoria ---
  var SOURCES_BY_CATEGORY = {
    Auto: [
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'Mercado Livre', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'KaBuM!', defaultChecked: true },
      { name: 'Buscapé', defaultChecked: true },
      { name: 'Steam', defaultChecked: true },
      { name: 'GOG', defaultChecked: true },
      { name: 'Epic Games', defaultChecked: true },
      { name: 'Nuuvem', defaultChecked: true },
      { name: 'AllKeyShop', defaultChecked: true },
      { name: 'CheapShark (USD)', defaultChecked: true },
      { name: 'Sites de cupons', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: false }
    ],
    Jogos: [
      { name: 'Steam', defaultChecked: true },
      { name: 'GOG', defaultChecked: true },
      { name: 'Epic Games', defaultChecked: true },
      { name: 'Nuuvem', defaultChecked: true },
      { name: 'CheapShark (USD)', defaultChecked: true },
      { name: 'AllKeyShop', defaultChecked: true },
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'Sites de cupons', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: false }
    ],
    Software: [
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'Mercado Livre', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'KaBuM!', defaultChecked: true },
      { name: 'Buscapé', defaultChecked: true },
      { name: 'AllKeyShop', defaultChecked: true },
      { name: 'Sites de cupons', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: true }
    ],
    Hardware: [
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'KaBuM!', defaultChecked: true },
      { name: 'Mercado Livre', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'Buscapé', defaultChecked: true },
      { name: 'Sites de cupons', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: true }
    ],
    'Eletrônicos': [
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'Mercado Livre', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'KaBuM!', defaultChecked: true },
      { name: 'Buscapé', defaultChecked: true },
      { name: 'Sites de cupons', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: true }
    ],
    Outros: [
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'Mercado Livre', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'Buscapé', defaultChecked: true },
      { name: 'Sites de cupons', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: true }
    ]
  };

  var CS_STORES = {
    '1': 'Steam', '2': 'GamersGate', '3': 'Green Man Gaming', '7': 'GOG',
    '11': 'Humble Store', '13': 'Ubisoft Store', '15': 'Fanatical', '21': 'WinGameStore',
    '23': 'GameBillet', '24': 'Voidu', '25': 'Epic Games', '27': 'Gamesplanet',
    '28': 'Gamesload', '29': '2Game', '30': 'IndieGala', '31': 'Blizzard Shop',
    '33': 'DLGamer', '34': 'Noctre', '35': 'DreamGame'
  };

  function renderSourceChips(containerId, category, inputClass) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var list = SOURCES_BY_CATEGORY[category] || SOURCES_BY_CATEGORY.Outros;
    container.innerHTML = list.map(function (src) {
      var safeName = escapeHtml(src.name);
      return (
        '<label class="source-chip ' + (src.defaultChecked ? 'selected' : '') + '">' +
          '<input type="checkbox" class="' + escapeHtml(inputClass) + '" value="' + safeName + '" ' + (src.defaultChecked ? 'checked' : '') + ' />' +
          '<span>' + safeName + '</span>' +
        '</label>'
      );
    }).join('');

    var chips = container.querySelectorAll('.source-chip');
    chips.forEach(function (chip) {
      var chk = chip.querySelector('input');
      if (!chk) return;
      chk.addEventListener('change', function () {
        chip.classList.toggle('selected', chk.checked);
      });
    });
  }

  // --- Navegação por Abas ---
  var tabButtons = document.querySelectorAll('.nav-tab');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      tabButtons.forEach(function (b) {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.remove('active');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      var targetPanel = document.getElementById(btn.getAttribute('data-tab'));
      if (targetPanel) targetPanel.classList.add('active');
    });
  });

  // --- Busca Direta (fallback offline/PWA sem proxy de terceiros) ---
  async function directBrowserSearch(term, sources, currencyFilter, category) {
    var offers = [];
    var errors = [];
    var currMode = currencyFilter || 'ALL';
    var detected = category && category !== 'Auto' ? category : detectQueryCategory(term);
    var effectiveSources = sources.slice();

    if (category === 'Auto' && detected !== 'Jogos') {
      effectiveSources = effectiveSources.filter(function (s) {
        return ['Steam', 'GOG', 'Epic Games', 'Nuuvem', 'CheapShark (USD)', 'CheapShark'].indexOf(s) === -1;
      });
      ['Google Shopping', 'Mercado Livre', 'Amazon', 'KaBuM!', 'Buscapé', 'AllKeyShop', 'Sites de cupons'].forEach(function (s) {
        if (effectiveSources.indexOf(s) === -1) effectiveSources.push(s);
      });
    }

    var tasks = effectiveSources.map(async function (src) {
      try {
        if (src === 'CheapShark (USD)' || src === 'CheapShark' || src === 'Epic Games' || src === 'GOG' || src === 'Steam') {
          var storeParam = src === 'Steam' ? '&storeID=1' : (src === 'Epic Games' ? '&storeID=25' : (src === 'GOG' ? '&storeID=7' : ''));
          var r = await fetch('https://www.cheapshark.com/api/1.0/deals?title=' + encodeURIComponent(term) + '&pageSize=12&sortBy=Price' + storeParam);
          if (r.ok) {
            var data = await r.json();
            if (Array.isArray(data)) {
              data.forEach(function (d) {
                var title = String(d.title || '');
                if (!title || !matchesSearchTerm(title, term)) return;
                var stName = src === 'CheapShark (USD)' || src === 'CheapShark'
                  ? (CS_STORES[String(d.storeID)] || ('CheapShark #' + d.storeID))
                  : src;
                offers.push({
                  name: title,
                  store: stName,
                  kind: src === 'Steam' || src === 'GOG' || src === 'Epic Games' ? 'Loja oficial' : 'Revendedor',
                  delivery_type: detectDeliveryType(title, stName),
                  currency: 'USD',
                  price: parseFloat(d.salePrice || '0'),
                  original_price: parseFloat(d.normalPrice || '0'),
                  discount: parseFloat(d.savings || '0'),
                  url: 'https://www.cheapshark.com/redirect?dealID=' + encodeURIComponent(d.dealID || ''),
                  thumb: d.thumb || ''
                });
              });
            }
          }
        } else if (src === 'Mercado Livre') {
          offers.push({
            name: term + ' (Buscar ofertas no Mercado Livre)',
            store: 'Mercado Livre',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Mercado Livre'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://lista.mercadolivre.com.br/' + encodeURIComponent(term.trim().replace(/\s+/g, '-'))
          });
        } else if (src === 'KaBuM!') {
          offers.push({
            name: term + ' (Buscar na KaBuM!)',
            store: 'KaBuM!',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'KaBuM!'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.kabum.com.br/busca/' + encodeURIComponent(term.trim().replace(/\s+/g, '-'))
          });
        } else if (src === 'Buscapé') {
          offers.push({
            name: term + ' (Comparar preços no Buscapé)',
            store: 'Buscapé',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Buscapé'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.buscape.com.br/search?q=' + encodeURIComponent(term)
          });
        } else if (src === 'AllKeyShop') {
          offers.push({
            name: term + ' (Comparar chaves no AllKeyShop)',
            store: 'AllKeyShop',
            kind: 'Comparador / Loja',
            delivery_type: 'Chave (Key)',
            currency: 'USD',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.allkeyshop.com/blog/catalogue/search-' + encodeURIComponent(term) + '/'
          });
        } else if (src === 'Nuuvem') {
          offers.push({
            name: term + ' (Chave de Ativação - Nuuvem Brasil)',
            store: 'Nuuvem',
            kind: 'Comparador / Loja',
            delivery_type: 'Chave (Key)',
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.nuuvem.com/br-pt/catalog/search/' + encodeURIComponent(term)
          });
        } else if (src === 'Google Shopping') {
          offers.push({
            name: term + ' (Ofertas no Google Shopping)',
            store: 'Google Shopping',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Google Shopping'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.google.com.br/search?tbm=shop&q=' + encodeURIComponent(term)
          });
        } else if (src === 'Amazon') {
          offers.push({
            name: term + ' (Ofertas na Amazon Brasil)',
            store: 'Amazon',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Amazon'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.amazon.com.br/s?k=' + encodeURIComponent(term)
          });
        } else if (src === 'Sites de cupons') {
          offers.push({
            name: term + ' (Buscar cupons e promoções no Pelando)',
            store: 'Sites de cupons',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Pelando'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.pelando.com.br/busca?q=' + encodeURIComponent(term)
          });
        } else if (src === 'Promobit (RSS)' || src === 'RSS') {
          offers.push({
            name: term + ' (Comunidade de Ofertas Promobit)',
            store: 'Promobit (RSS)',
            kind: 'Comparador / Loja',
            delivery_type: detectDeliveryType(term, 'Promobit'),
            currency: 'BRL',
            price: 0,
            original_price: 0,
            discount: 0,
            url: 'https://www.promobit.com.br/buscar/?q=' + encodeURIComponent(term)
          });
        }
      } catch (err) {
        errors.push(src + ': falha de conexão.');
      }
    });

    await Promise.all(tasks);

    if (currMode === 'BRL' || currMode === 'USD') {
      offers = offers.filter(function (o) { return o.currency === currMode; });
    }

    offers.sort(function (a, b) {
      if (a.price > 0 && b.price === 0) return -1;
      if (a.price === 0 && b.price > 0) return 1;
      return a.price - b.price;
    });

    return { offers: offers, errors: errors, detected_category: detected, usd_to_brl_rate: null };
  }

  async function executeRealSearch(term, sources, currencyFilter, category) {
    var currMode = currencyFilter || 'ALL';
    var catMode = category || 'Auto';
    var savedCfg = getConfig();
    if (window.location.protocol.startsWith('http')) {
      try {
        var res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            term: term,
            sources: sources,
            currency: currMode,
            category: catMode,
            rss_feeds: savedCfg.rss_feeds || []
          })
        });
        if (res.ok) {
          var data = await res.json();
          if (data && Array.isArray(data.offers)) return data;
        }
      } catch (e) {}
    }
    return await directBrowserSearch(term, sources, currMode, catMode);
  }

  // Chama o endpoint real /api/scan (dispara SMTP/Telegram/WhatsApp + deduplicação)
  async function executeRealScan(activeItems) {
    var savedCfg = getConfig();
    var existingAlerts = getAlerts();
    var existingKeys = existingAlerts.map(function (a) {
      return a.dedup_key || buildDedupKey(a.item_id, a);
    });

    if (window.location.protocol.startsWith('http')) {
      try {
        var res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: activeItems,
            config: {
              rss_feeds: savedCfg.rss_feeds || [],
              telegram_chat_id: savedCfg.telegram_chat_id || undefined
            },
            existing_alert_keys: existingKeys
          })
        });
        if (res.ok) {
          var data = await res.json();
          if (data && Array.isArray(data.results)) {
            return { viaServer: true, results: data.results };
          }
        }
      } catch (e) {}
    }

    // Fallback offline no navegador
    var seenSet = {};
    existingKeys.forEach(function (k) { seenSet[k] = true; });
    var fallbackResults = [];

    for (var i = 0; i < activeItems.length; i++) {
      var item = activeItems[i];
      var sRes = await directBrowserSearch(item.name, item.sources, item.currency_filter || 'ALL', item.category || 'Auto');
      var itemAlerts = [];
      (sRes.offers || []).forEach(function (off) {
        if (!qualifiesOffer(item, off)) return;
        var dk = buildDedupKey(item.id, off);
        if (seenSet[dk]) return;
        seenSet[dk] = true;
        itemAlerts.push({
          id: generateId(),
          item_id: item.id,
          dedup_key: dk,
          name: off.name,
          store: off.store,
          delivery_type: off.delivery_type || detectDeliveryType(off.name, off.store),
          currency: off.currency,
          original_price: off.original_price,
          price: off.price,
          price_brl_estimated: off.price_brl_estimated,
          discount: off.discount,
          url: off.url,
          created_at: new Date().toISOString(),
          notified: 'Painel (offline)'
        });
      });
      fallbackResults.push({
        item_id: item.id,
        item: item.name,
        offers: sRes.offers || [],
        alerts: itemAlerts,
        errors: sRes.errors || [],
        usd_to_brl_rate: sRes.usd_to_brl_rate || null,
        detected_category: sRes.detected_category
      });
    }

    return { viaServer: false, results: fallbackResults };
  }

  function qualifiesOffer(item, offer) {
    if (Number(offer.price) <= 0) return false;
    var filterCurr = item.currency_filter || 'ALL';
    if (filterCurr !== 'ALL' && offer.currency !== filterCurr) return false;

    var hasRule = item.target_price !== null || item.min_discount !== null;
    if (!hasRule) return false;

    var priceOk = false;
    if (item.target_price !== null) {
      if (filterCurr === 'ALL') {
        if (offer.currency === 'BRL') {
          priceOk = Number(offer.price) <= Number(item.target_price);
        } else if (offer.currency === 'USD' && offer.price_brl_estimated) {
          priceOk = Number(offer.price_brl_estimated) <= Number(item.target_price);
        }
      } else if (offer.currency === filterCurr) {
        priceOk = Number(offer.price) <= Number(item.target_price);
      }
    }
    var discountOk = item.min_discount !== null && Number(offer.discount) >= Number(item.min_discount);
    return priceOk || discountOk;
  }

  // --- Renderização segura de ofertas (separa preços reais vs links de busca) ---
  function renderSingleOfferCard(o) {
    var hasPrice = Number(o.price) > 0;
    var sym = formatCurrencySymbol(o.currency);
    var deliveryBadge = formatDeliveryBadge(o.delivery_type || detectDeliveryType(o.name, o.store));

    var priceHtml = hasPrice
      ? '<span class="price-highlight">' + escapeHtml(sym) + ' ' + Number(o.price).toFixed(2) + ' (' + escapeHtml(o.currency) + ')</span>' +
        (o.currency === 'USD' && o.price_brl_estimated ? '<span class="price-est">≈ R$ ' + Number(o.price_brl_estimated).toFixed(2) + '</span>' : '') +
        (Number(o.original_price) > Number(o.price) ? '<s class="price-old">' + escapeHtml(sym) + ' ' + Number(o.original_price).toFixed(2) + '</s>' : '') +
        (Number(o.discount) > 0 ? '<span class="tag green">-' + Math.round(Number(o.discount)) + '%</span>' : '')
      : '<span class="tag">Busca direta (' + escapeHtml(o.currency) + ')</span>';

    var safeThumb = o.thumb ? safeUrl(o.thumb) : '#';
    var thumbHtml = safeThumb !== '#'
      ? '<img src="' + escapeHtml(safeThumb) + '" alt="" class="offer-thumb" loading="lazy" />'
      : '';

    var linkUrl = safeUrl(o.url);

    return (
      '<div class="list-item">' +
        '<div class="offer-left">' +
          thumbHtml +
          '<div>' +
            '<strong>' + escapeHtml(o.name) + '</strong>' +
            '<div class="offer-meta">' +
              '<span class="tag">' + escapeHtml(o.store) + '</span>' +
              deliveryBadge +
              priceHtml +
            '</div>' +
          '</div>' +
        '</div>' +
        '<a href="' + escapeHtml(linkUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">' +
          (hasPrice ? 'Abrir Oferta ↗' : 'Pesquisar na Loja ↗') +
        '</a>' +
      '</div>'
    );
  }

  function renderOfferListHTML(offers, errors, meta) {
    var parts = [];
    if (meta && (meta.detected_category || meta.usd_to_brl_rate)) {
      var metaChips = [];
      if (meta.detected_category) {
        metaChips.push('<span class="tag">Categoria: ' + escapeHtml(meta.detected_category) + '</span>');
      }
      if (meta.usd_to_brl_rate) {
        metaChips.push('<span class="tag green">Cotação USD → BRL: R$ ' + Number(meta.usd_to_brl_rate).toFixed(2) + '</span>');
      }
      parts.push('<div class="meta-bar">' + metaChips.join('') + '</div>');
    }

    if (errors && errors.length) {
      parts.push(
        '<p style="color:#fca5a5; font-size:0.84rem; margin-bottom:12px;">Avisos: ' +
          escapeHtml(errors.join(' • ')) +
        '</p>'
      );
    }

    if (!offers || !offers.length) {
      parts.push('<p style="color:var(--muted);">Nenhuma oferta compatível encontrada com os filtros selecionados.</p>');
      return parts.join('');
    }

    var priced = offers.filter(function (o) { return Number(o.price) > 0; });
    var catalog = offers.filter(function (o) { return Number(o.price) <= 0; });

    if (priced.length) {
      parts.push('<div class="section-divider">Ofertas com preço em tempo real (' + priced.length + ')</div>');
      parts.push(priced.map(renderSingleOfferCard).join(''));
    }

    if (catalog.length) {
      parts.push('<div class="section-divider">Links diretos de pesquisa nas lojas (' + catalog.length + ')</div>');
      parts.push(catalog.map(renderSingleOfferCard).join(''));
    }

    return parts.join('');
  }

  // --- Healthcheck & Capabilities ---
  async function checkServerHealth() {
    var pill = document.getElementById('server-status');
    var txt = document.getElementById('status-text');
    var capsEl = document.getElementById('server-capabilities');
    if (!pill || !txt) return;

    if (window.location.protocol.startsWith('http')) {
      try {
        var res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          var info = await res.json();
          serverOnline = true;
          serverStorageMode = info.storage || 'none';
          pill.classList.remove('offline');
          txt.textContent = 'Servidor online (v' + (info.version || '5.1') + ')';

          if (capsEl && info.notifications) {
            var n = info.notifications;
            capsEl.innerHTML =
              '<span class="tag ' + (n.email ? 'green' : 'paused') + '">SMTP E-mail: ' + (n.email ? 'Configurado' : 'Pendente no servidor') + '</span>' +
              '<span class="tag ' + (n.telegram ? 'green' : 'paused') + '">Telegram: ' + (n.telegram ? 'Configurado' : 'Pendente no servidor') + '</span>' +
              '<span class="tag ' + (n.whatsapp ? 'green' : 'paused') + '">WhatsApp: ' + (n.whatsapp ? 'Configurado' : 'Pendente no servidor') + '</span>' +
              '<span class="tag ' + (serverStorageMode !== 'none' ? 'green' : 'paused') + '">Persistência Cron: ' + escapeHtml(serverStorageMode) + '</span>';
          }

          if (serverStorageMode !== 'none') {
            syncFromServerIfLocalEmpty();
          }
          return;
        }
      } catch (e) {}
    }

    serverOnline = false;
    pill.classList.add('offline');
    txt.textContent = 'Modo Offline (PWA)';
  }

  async function syncFromServerIfLocalEmpty() {
    if (getItems().length > 0) return;
    try {
      var res = await fetch('/api/monitors', { cache: 'no-store' });
      if (!res.ok) return;
      var data = await res.json();
      if (Array.isArray(data.items) && data.items.length > 0) {
        localStorage.setItem(STORAGE_ITEMS_KEY, JSON.stringify(data.items));
        renderMonitors();
      }
      if (Array.isArray(data.alerts) && data.alerts.length > 0 && getAlerts().length === 0) {
        saveAlerts(data.alerts);
        renderAlerts();
      }
    } catch (e) {}
  }

  // --- Controles de Formulário ---
  var categorySelect = document.getElementById('item-category');
  var sourcesLegend = document.getElementById('sources-legend');
  var currencySelect = document.getElementById('item-currency');
  var targetLabel = document.getElementById('label-item-target');
  var chkMonitorar = document.getElementById('chk-monitorar');
  var inputEmail = document.getElementById('dest-email');
  var emailReqStar = document.getElementById('email-req-star');
  var monitorBadgeState = document.getElementById('monitor-badge-state');
  var chkChannelEmail = document.getElementById('chn-email');

  function updateCategorySources() {
    if (!categorySelect || !sourcesLegend) return;
    var cat = categorySelect.value;
    sourcesLegend.textContent = 'Fontes (' + cat + ')';
    renderSourceChips('sources-chips-container', cat, 'src-chk');
  }

  function updateCurrencyLabel() {
    if (!currencySelect || !targetLabel) return;
    var val = currencySelect.value;
    if (val === 'USD') targetLabel.textContent = 'Preço-alvo (US$)';
    else if (val === 'BRL') targetLabel.textContent = 'Preço-alvo (R$)';
    else targetLabel.textContent = 'Preço-alvo (R$ / Livre)';
  }

  function syncMonitorEmailRule() {
    if (!chkMonitorar || !inputEmail) return;
    var wantsMonitor = chkMonitorar.checked;
    if (wantsMonitor) {
      inputEmail.setAttribute('required', 'required');
      if (emailReqStar) emailReqStar.style.display = 'inline';
      if (monitorBadgeState) {
        monitorBadgeState.textContent = 'Monitoramento Ativo';
        monitorBadgeState.className = 'tag green';
      }
      if (chkChannelEmail) chkChannelEmail.checked = true;
    } else {
      inputEmail.removeAttribute('required');
      inputEmail.classList.remove('input-error');
      if (emailReqStar) emailReqStar.style.display = 'none';
      if (monitorBadgeState) {
        monitorBadgeState.textContent = 'Apenas Salvo (Inativo)';
        monitorBadgeState.className = 'tag paused';
      }
    }
  }

  if (categorySelect) categorySelect.addEventListener('change', updateCategorySources);
  if (currencySelect) currencySelect.addEventListener('change', updateCurrencyLabel);
  if (chkMonitorar) chkMonitorar.addEventListener('change', syncMonitorEmailRule);

  function showError(msg) {
    var box = document.getElementById('form-error');
    var okBox = document.getElementById('form-success');
    if (okBox) okBox.style.display = 'none';
    if (!box) return;
    if (!msg) {
      box.style.display = 'none';
      box.textContent = '';
      return;
    }
    box.textContent = '⚠️ ' + msg;
    box.style.display = 'flex';
  }

  function showSuccess(msg) {
    var errBox = document.getElementById('form-error');
    var okBox = document.getElementById('form-success');
    if (errBox) errBox.style.display = 'none';
    if (!okBox) return;
    if (!msg) {
      okBox.style.display = 'none';
      return;
    }
    okBox.textContent = '✅ ' + msg;
    okBox.style.display = 'flex';
  }

  // --- Botão Pesquisa Rápida na Aba Monitoramentos ---
  var btnQuickCheck = document.getElementById('btn-quick-check');
  if (btnQuickCheck) {
    btnQuickCheck.addEventListener('click', async function () {
      showError('');
      var name = document.getElementById('item-name').value.trim();
      var category = document.getElementById('item-category').value;
      var currFilter = document.getElementById('item-currency').value;
      var sources = Array.from(document.querySelectorAll('.src-chk:checked')).map(function (el) { return el.value; });
      if (!name) return showError('Digite o nome do produto, software ou jogo para pesquisar.');
      if (!sources.length) return showError('Selecione pelo menos uma fonte.');

      var previewCard = document.getElementById('quick-search-card');
      var previewOut = document.getElementById('quick-search-output');
      previewCard.style.display = 'block';
      previewOut.innerHTML = '<p style="color:var(--muted);">Consultando preços reais nas lojas selecionadas...</p>';
      btnQuickCheck.disabled = true;

      try {
        var result = await executeRealSearch(name, sources, currFilter, category);
        previewOut.innerHTML = renderOfferListHTML(result.offers, result.errors, {
          detected_category: result.detected_category,
          usd_to_brl_rate: result.usd_to_brl_rate
        });
      } finally {
        btnQuickCheck.disabled = false;
      }
    });
  }

  // --- Salvar Novo Monitoramento (usa /api/scan quando ativo) ---
  var btnSaveItem = document.getElementById('btn-save-item');
  if (btnSaveItem) {
    btnSaveItem.addEventListener('click', async function () {
      showError('');
      inputEmail.classList.remove('input-error');

      var name = document.getElementById('item-name').value.trim();
      var category = document.getElementById('item-category').value;
      var currency_filter = document.getElementById('item-currency').value;
      var targetRaw = document.getElementById('item-target').value;
      var discountRaw = document.getElementById('item-discount').value;
      var frequency = document.getElementById('item-frequency').value;
      var wantsMonitor = chkMonitorar.checked;
      var email = inputEmail.value.trim();
      var telegram = document.getElementById('dest-telegram').value.trim();
      var whatsapp = document.getElementById('dest-whatsapp').value.trim();

      var sources = Array.from(document.querySelectorAll('.src-chk:checked')).map(function (el) { return el.value; });
      var channels = Array.from(document.querySelectorAll('.chn-chk:checked')).map(function (el) { return el.value; });

      if (!name) return showError('Informe o nome do produto, software ou jogo.');
      if (!sources.length) return showError('Selecione pelo menos uma fonte de busca.');
      if (!targetRaw && !discountRaw) return showError('Informe um preço-alvo ou um desconto mínimo (%).');

      if (wantsMonitor) {
        if (!email || !isValidEmail(email)) {
          inputEmail.classList.add('input-error');
          inputEmail.focus();
          return showError('Como você marcou a opção de monitorar, o cadastro de um e-mail válido é obrigatório.');
        }
        if (channels.indexOf('E-mail') === -1) channels.push('E-mail');
      }

      var newItem = {
        id: generateId(),
        name: name,
        category: category,
        currency_filter: currency_filter,
        target_price: targetRaw ? parseFloat(targetRaw) : null,
        min_discount: discountRaw ? parseFloat(discountRaw) : null,
        sources: sources,
        channels: channels.length ? channels : ['Painel'],
        destinations: { 'E-mail': email, Telegram: telegram, WhatsApp: whatsapp },
        frequency: frequency,
        active: wantsMonitor,
        created_at: new Date().toISOString(),
        last_checked: new Date().toISOString()
      };

      var items = getItems();
      items.unshift(newItem);
      saveItems(items);

      document.getElementById('item-name').value = '';
      document.getElementById('item-target').value = '';
      document.getElementById('item-discount').value = '';
      renderMonitors();

      showSuccess('Monitoramento de "' + name + '" salvo! Verificando ofertas atuais...');

      var previewCard = document.getElementById('quick-search-card');
      var previewOut = document.getElementById('quick-search-output');
      previewCard.style.display = 'block';
      previewOut.innerHTML = '<p style="color:var(--muted);">Verificando ofertas em tempo real para "' + escapeHtml(name) + '"...</p>';

      btnSaveItem.disabled = true;
      try {
        if (wantsMonitor) {
          var scanOut = await executeRealScan([newItem]);
          var first = scanOut.results[0];
          if (first) {
            previewOut.innerHTML = renderOfferListHTML(first.offers, first.errors, {
              detected_category: first.detected_category,
              usd_to_brl_rate: first.usd_to_brl_rate
            });
            if (first.alerts && first.alerts.length) {
              var allAlerts = getAlerts().concat(first.alerts);
              saveAlerts(allAlerts);
              renderAlerts();
              showSuccess('Monitoramento salvo e ' + first.alerts.length + ' alerta(s) disparado(s)!');
            }
          }
        } else {
          var searchRes = await executeRealSearch(name, sources, currency_filter, category);
          previewOut.innerHTML = renderOfferListHTML(searchRes.offers, searchRes.errors, {
            detected_category: searchRes.detected_category,
            usd_to_brl_rate: searchRes.usd_to_brl_rate
          });
        }
      } finally {
        btnSaveItem.disabled = false;
      }
    });
  }

  // --- Renderização dos Monitoramentos ---
  function renderMonitors() {
    var items = getItems();
    var container = document.getElementById('monitors-container');
    if (!container) return;

    if (!items.length) {
      container.innerHTML = '<p style="color: var(--muted); font-size: 0.92rem;">Nenhum monitoramento cadastrado ainda. Preencha o formulário acima para começar.</p>';
      return;
    }

    container.innerHTML = items.map(function (item) {
      var currFilter = item.currency_filter || 'ALL';
      var sym = currFilter === 'USD' ? 'US$ ' : 'R$ ';
      var lastCheckedTxt = item.last_checked ? new Date(item.last_checked).toLocaleString('pt-BR') : 'Ainda não verificado';
      return (
        '<div class="list-item" data-id="' + escapeHtml(item.id) + '">' +
          '<div>' +
            '<div style="display:flex; align-items:center; gap:6px; margin-bottom:4px; flex-wrap:wrap;">' +
              '<strong style="font-size:1rem;">' + escapeHtml(item.name) + '</strong>' +
              '<span class="tag">' + escapeHtml(item.category || 'Auto') + '</span>' +
              '<span class="tag">' + escapeHtml(formatCurrLabel(currFilter)) + '</span>' +
              '<span class="tag ' + (item.active ? 'green' : 'paused') + '">' + (item.active ? 'Monitorando' : 'Pausado') + '</span>' +
            '</div>' +
            '<div style="font-size:0.83rem; color: var(--muted);">' +
              'Alvo: <strong>' + (item.target_price ? escapeHtml(sym) + Number(item.target_price).toFixed(2) : 'Não definido') + '</strong> • ' +
              'Desconto mín.: <strong>' + (item.min_discount ? escapeHtml(item.min_discount) + '%' : 'Não definido') + '</strong> • ' +
              'Fontes: ' + escapeHtml((item.sources || []).join(', ')) +
            '</div>' +
            '<div style="font-size:0.8rem; color: var(--muted); margin-top:2px;">' +
              'E-mail: <strong>' + escapeHtml((item.destinations && item.destinations['E-mail']) || 'Não informado') + '</strong> • ' +
              'Frequência: ' + escapeHtml(item.frequency || 'A cada hora') + ' • Última checagem: ' + escapeHtml(lastCheckedTxt) +
            '</div>' +
          '</div>' +
          '<div class="action-row">' +
            '<button type="button" class="btn btn-primary btn-sm js-check-one" data-id="' + escapeHtml(item.id) + '">Buscar ofertas</button>' +
            '<button type="button" class="btn btn-outline btn-sm js-toggle-one" data-id="' + escapeHtml(item.id) + '">' + (item.active ? 'Pausar' : 'Ativar') + '</button>' +
            '<button type="button" class="btn btn-danger js-delete-one" data-id="' + escapeHtml(item.id) + '">Excluir</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    container.querySelectorAll('.js-check-one').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = btn.getAttribute('data-id');
        var item = getItems().find(function (i) { return i.id === id; });
        if (!item) return;
        btn.disabled = true;
        btn.textContent = 'Buscando...';
        var previewCard = document.getElementById('quick-search-card');
        var previewOut = document.getElementById('quick-search-output');
        previewCard.style.display = 'block';
        previewOut.innerHTML = '<p style="color:var(--muted);">Consultando ofertas para "' + escapeHtml(item.name) + '"...</p>';
        try {
          var res = await executeRealSearch(item.name, item.sources, item.currency_filter || 'ALL', item.category || 'Auto');
          previewOut.innerHTML = renderOfferListHTML(res.offers, res.errors, {
            detected_category: res.detected_category,
            usd_to_brl_rate: res.usd_to_brl_rate
          });
        } finally {
          btn.disabled = false;
          btn.textContent = 'Buscar ofertas';
        }
      });
    });

    container.querySelectorAll('.js-toggle-one').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var list = getItems();
        var item = list.find(function (i) { return i.id === id; });
        if (!item) return;
        if (!item.active) {
          var email = (item.destinations && item.destinations['E-mail']) || '';
          if (!isValidEmail(email)) {
            alert('Este item não possui um e-mail válido cadastrado. Exclua e cadastre novamente informando seu e-mail.');
            return;
          }
        }
        item.active = !item.active;
        saveItems(list);
        renderMonitors();
      });
    });

    container.querySelectorAll('.js-delete-one').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var list = getItems().filter(function (i) { return i.id !== id; });
        saveItems(list);
        renderMonitors();
      });
    });
  }

  // --- Varredura de Todos os Monitoramentos Ativos via /api/scan ---
  async function runScanForItems(targetItems, showPreview) {
    if (!targetItems.length) return { offersCount: 0, alertsCount: 0 };

    var scanOut = await executeRealScan(targetItems);
    var allFoundOffers = [];
    var allErrors = [];
    var newAlerts = [];
    var nowIso = new Date().toISOString();

    scanOut.results.forEach(function (r) {
      (r.offers || []).forEach(function (o) { allFoundOffers.push(o); });
      (r.errors || []).forEach(function (e) { allErrors.push(r.item + ': ' + e); });
      (r.alerts || []).forEach(function (a) { newAlerts.push(a); });
    });

    // Atualiza last_checked nos itens escaneados
    var scannedIds = {};
    targetItems.forEach(function (it) { scannedIds[it.id] = true; });
    var updatedItems = getItems().map(function (it) {
      return scannedIds[it.id] ? Object.assign({}, it, { last_checked: nowIso }) : it;
    });
    saveItems(updatedItems);
    renderMonitors();

    if (newAlerts.length > 0) {
      saveAlerts(getAlerts().concat(newAlerts));
      renderAlerts();
    }

    if (showPreview) {
      var previewCard = document.getElementById('quick-search-card');
      var previewOut = document.getElementById('quick-search-output');
      previewCard.style.display = 'block';
      previewOut.innerHTML = renderOfferListHTML(allFoundOffers, allErrors, {
        usd_to_brl_rate: scanOut.results[0] && scanOut.results[0].usd_to_brl_rate
      });
    }

    return { offersCount: allFoundOffers.length, alertsCount: newAlerts.length, viaServer: scanOut.viaServer };
  }

  var btnScanNow = document.getElementById('btn-scan-now');
  if (btnScanNow) {
    btnScanNow.addEventListener('click', async function () {
      var activeItems = getItems().filter(function (i) { return i.active; });
      if (!activeItems.length) {
        alert('Cadastre pelo menos um monitoramento ativo antes de verificar.');
        return;
      }

      btnScanNow.disabled = true;
      btnScanNow.textContent = 'Verificando lojas...';
      try {
        var summary = await runScanForItems(activeItems, true);
        showSuccess(
          'Varredura concluída' + (summary.viaServer ? ' via servidor' : ' localmente') + '! ' +
          summary.offersCount + ' oferta(s) consultada(s) e ' + summary.alertsCount + ' novo(s) alerta(s) disparado(s).'
        );
      } finally {
        btnScanNow.disabled = false;
        btnScanNow.textContent = 'Verificar todos agora';
      }
    });
  }

  // --- Agendador Automático no Cliente (respeita frequency de cada item) ---
  function frequencyToMs(freq) {
    if (freq === 'A cada 15 min') return 15 * 60 * 1000;
    if (freq === 'A cada 6 horas') return 6 * 60 * 60 * 1000;
    if (freq === 'Uma vez por dia') return 24 * 60 * 60 * 1000;
    return 60 * 60 * 1000; // A cada hora
  }

  function updateSchedulerBadge() {
    var badge = document.getElementById('scheduler-status');
    if (!badge) return;
    var cfg = getConfig();
    if (cfg.auto_scan === 'off') {
      badge.textContent = 'Agendador pausado';
      badge.className = 'tag paused';
    } else {
      badge.textContent = 'Agendador ativo';
      badge.className = 'tag green';
    }
  }

  async function runDueScheduledScans() {
    var cfg = getConfig();
    if (cfg.auto_scan === 'off' || isAutoScanning) return;
    var now = Date.now();
    var dueItems = getItems().filter(function (item) {
      if (!item.active) return false;
      var lastMs = item.last_checked ? Date.parse(item.last_checked) : 0;
      return !lastMs || (now - lastMs) >= frequencyToMs(item.frequency);
    });
    if (!dueItems.length) return;

    isAutoScanning = true;
    try {
      await runScanForItems(dueItems, false);
    } catch (e) {
    } finally {
      isAutoScanning = false;
    }
  }

  // --- Aba Pesquisar (Pesquisa Livre com Categoria) ---
  var btnRunSearch = document.getElementById('btn-run-search');
  var inputSearchTerm = document.getElementById('search-term');
  var selectSearchCategory = document.getElementById('search-category');
  var selectSearchCurrency = document.getElementById('search-currency');

  function updateSearchCategorySources() {
    var cat = selectSearchCategory ? selectSearchCategory.value : 'Auto';
    renderSourceChips('search-chips-container', cat, 'search-src-chk');
  }

  async function triggerSearchTab() {
    var term = inputSearchTerm.value.trim();
    var category = selectSearchCategory ? selectSearchCategory.value : 'Auto';
    var currFilter = selectSearchCurrency ? selectSearchCurrency.value : 'ALL';
    var sources = Array.from(document.querySelectorAll('.search-src-chk:checked')).map(function (el) { return el.value; });
    var out = document.getElementById('search-output');

    if (!term || !sources.length) {
      out.innerHTML = '<p style="color:#fca5a5;">Digite o nome do produto/jogo e mantenha ao menos uma fonte selecionada.</p>';
      return;
    }

    btnRunSearch.disabled = true;
    btnRunSearch.textContent = 'Buscando ofertas...';
    out.innerHTML = '<p style="color:var(--muted);">Consultando fontes compatíveis para "' + escapeHtml(term) + '"...</p>';

    try {
      var data = await executeRealSearch(term, sources, currFilter, category);
      out.innerHTML = renderOfferListHTML(data.offers, data.errors, {
        detected_category: data.detected_category,
        usd_to_brl_rate: data.usd_to_brl_rate
      });
    } finally {
      btnRunSearch.disabled = false;
      btnRunSearch.textContent = 'Buscar nas lojas';
    }
  }

  if (selectSearchCategory) {
    selectSearchCategory.addEventListener('change', function () {
      updateSearchCategorySources();
      if (inputSearchTerm && inputSearchTerm.value.trim()) triggerSearchTab();
    });
  }
  if (btnRunSearch) btnRunSearch.addEventListener('click', triggerSearchTab);
  if (inputSearchTerm) {
    inputSearchTerm.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') triggerSearchTab();
    });
  }
  if (selectSearchCurrency) {
    selectSearchCurrency.addEventListener('change', function () {
      if (inputSearchTerm && inputSearchTerm.value.trim()) triggerSearchTab();
    });
  }

  // --- Aba Alertas ---
  function renderAlerts() {
    var alerts = getAlerts().slice().reverse();
    var badge = document.getElementById('alert-count-badge');
    if (badge) badge.textContent = String(alerts.length);
    var container = document.getElementById('alerts-container');
    if (!container) return;

    if (!alerts.length) {
      container.innerHTML = '<p style="color:var(--muted); font-size:0.92rem;">Nenhum alerta disparado até o momento.</p>';
      return;
    }

    container.innerHTML = alerts.map(function (a) {
      var sym = formatCurrencySymbol(a.currency);
      var deliveryBadge = formatDeliveryBadge(a.delivery_type || detectDeliveryType(a.name, a.store));
      var linkUrl = safeUrl(a.url);
      return (
        '<div class="list-item">' +
          '<div>' +
            '<strong>' + escapeHtml(a.name) + '</strong> ' +
            deliveryBadge +
            '<span class="tag green">' + escapeHtml(sym) + ' ' + Number(a.price).toFixed(2) + ' (-' + Math.round(Number(a.discount || 0)) + '%)</span>' +
            '<div style="font-size:0.82rem; color:var(--muted); margin-top:4px;">' +
              'Loja: ' + escapeHtml(a.store) + ' • Moeda: ' + escapeHtml(a.currency) +
              ' • Via: ' + escapeHtml(a.notified || 'Painel') +
              ' • ' + escapeHtml(new Date(a.created_at).toLocaleString('pt-BR')) +
            '</div>' +
          '</div>' +
          '<a href="' + escapeHtml(linkUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">Ver oferta ↗</a>' +
        '</div>'
      );
    }).join('');
  }

  var btnClearAlerts = document.getElementById('btn-clear-alerts');
  if (btnClearAlerts) {
    btnClearAlerts.addEventListener('click', function () {
      saveAlerts([]);
      renderAlerts();
    });
  }

  var btnExportCsv = document.getElementById('btn-export-csv');
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', function () {
      var alerts = getAlerts();
      if (!alerts.length) return alert('Não há alertas para exportar.');

      var header = ['data', 'item', 'tipo_entrega', 'loja', 'moeda', 'preco_original', 'preco', 'desconto_pct', 'notificado_via', 'url'];
      var rows = alerts.map(function (a) {
        return [
          sanitizeCsvCell(a.created_at),
          sanitizeCsvCell(a.name),
          sanitizeCsvCell(a.delivery_type || detectDeliveryType(a.name, a.store)),
          sanitizeCsvCell(a.store),
          sanitizeCsvCell(a.currency),
          Number(a.original_price || 0).toFixed(2),
          Number(a.price || 0).toFixed(2),
          Math.round(Number(a.discount || 0)),
          sanitizeCsvCell(a.notified || 'Painel'),
          sanitizeCsvCell(safeUrl(a.url))
        ].join(';');
      });

      var blob = new Blob(['\ufeff' + [header.join(';')].concat(rows).join('\n')], { type: 'text/csv;charset=utf-8;' });
      var blobUrl = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'alertas_monitordepromocoes.csv';
      link.click();
      setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 2000);
    });
  }

  // --- Aba Configurações ---
  function loadSavedConfig() {
    var cfg = getConfig();
    if (cfg.default_email) {
      var el = document.getElementById('cfg-email-default');
      if (el) el.value = cfg.default_email;
      if (inputEmail && !inputEmail.value) inputEmail.value = cfg.default_email;
    }
    var tgChat = document.getElementById('cfg-telegram-chat');
    if (tgChat && cfg.telegram_chat_id) tgChat.value = cfg.telegram_chat_id;

    var rssEl = document.getElementById('cfg-rss-url');
    if (rssEl && cfg.rss_feeds && cfg.rss_feeds[0] && cfg.rss_feeds[0].url) {
      rssEl.value = cfg.rss_feeds[0].url;
    }

    var autoEl = document.getElementById('cfg-auto-scan');
    if (autoEl && cfg.auto_scan) {
      autoEl.value = cfg.auto_scan;
    }
    updateSchedulerBadge();
  }

  var btnSaveConfig = document.getElementById('btn-save-config');
  if (btnSaveConfig) {
    btnSaveConfig.addEventListener('click', function () {
      var default_email = document.getElementById('cfg-email-default').value.trim();
      var telegram_chat_id = document.getElementById('cfg-telegram-chat').value.trim();
      var rssUrl = document.getElementById('cfg-rss-url').value.trim();
      var auto_scan = document.getElementById('cfg-auto-scan').value;

      if (rssUrl && safeUrl(rssUrl) === '#') {
        alert('Informe uma URL de Feed RSS válida começando com https:// ou http://.');
        return;
      }

      var cfg = {
        default_email: default_email,
        telegram_chat_id: telegram_chat_id,
        rss_feeds: rssUrl ? [{ name: 'Feed RSS Personalizado', url: rssUrl }] : [],
        auto_scan: auto_scan
      };

      localStorage.setItem(STORAGE_CFG_KEY, JSON.stringify(cfg));
      if (default_email && inputEmail && !inputEmail.value) inputEmail.value = default_email;
      updateSchedulerBadge();
      alert('Configurações salvas com sucesso!');
    });
  }

  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  // Inicialização
  updateCategorySources();
  updateCurrencyLabel();
  updateSearchCategorySources();
  syncMonitorEmailRule();
  loadSavedConfig();
  checkServerHealth();
  renderMonitors();
  renderAlerts();

  // Verifica periodicamente (a cada 60s) se algum monitoramento ativo atingiu o intervalo configurado
  setInterval(runDueScheduledScans, 60 * 1000);
})();
