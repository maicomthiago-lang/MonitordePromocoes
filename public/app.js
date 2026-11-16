(function () {
  var STORAGE_ITEMS_KEY = 'monitordepromocoes_items_v5';
  var STORAGE_ALERTS_KEY = 'monitordepromocoes_alerts_v5';
  var STORAGE_CFG_KEY = 'promo_cfg';

  function getItems() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_ITEMS_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveItems(items) {
    try {
      localStorage.setItem(STORAGE_ITEMS_KEY, JSON.stringify(items));
    } catch (e) {}
  }

  function getAlerts() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_ALERTS_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveAlerts(alerts) {
    try {
      localStorage.setItem(STORAGE_ALERTS_KEY, JSON.stringify(alerts));
    } catch (e) {}
  }

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  }

  // Classificador automático se o item encontrado é Chave (Key) ou Conta
  function detectDeliveryType(title, store, extraText) {
    var combined = (String(title || '') + ' ' + String(extraText || '')).toLowerCase();
    var accountKeywords = [
      'conta ', 'conta-', 'account', 'offline', 'compartilhada', 'primária', 'primaria',
      'secundária', 'secundaria', 'steam account', 'psn account', 'xbox account', 'acesso completo'
    ];
    for (var i = 0; i < accountKeywords.length; i++) {
      if (combined.indexOf(accountKeywords[i]) !== -1) {
        return 'Conta';
      }
    }
    return 'Chave (Key)';
  }

  function formatDeliveryBadge(deliveryType) {
    var dtype = deliveryType || 'Chave (Key)';
    if (dtype === 'Conta') {
      return '<span class="tag account-badge">👤 Conta</span>';
    }
    return '<span class="tag key-badge">🔑 Chave (Key)</span>';
  }

  function formatCurrencySymbol(curr) {
    return curr === 'USD' ? 'US$' : 'R$';
  }

  var SOURCES_BY_CATEGORY = {
    Jogos: [
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'Steam', defaultChecked: true },
      { name: 'Epic Games', defaultChecked: true },
      { name: 'GOG', defaultChecked: true },
      { name: 'Nuuvem', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: false },
      { name: 'Sites de cupons', defaultChecked: true },
      { name: 'CheapShark (USD)', defaultChecked: true }
    ],
    Default: [
      { name: 'Google Shopping', defaultChecked: true },
      { name: 'Amazon', defaultChecked: true },
      { name: 'Promobit (RSS)', defaultChecked: true },
      { name: 'Sites de cupons', defaultChecked: true }
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
    var list = SOURCES_BY_CATEGORY[category] || SOURCES_BY_CATEGORY.Default;
    container.innerHTML = list.map(function (src) {
      return (
        '<label class="source-chip ' + (src.defaultChecked ? 'selected' : '') + '">' +
          '<input type="checkbox" class="' + inputClass + '" value="' + src.name + '" ' + (src.defaultChecked ? 'checked' : '') + ' />' +
          '<span>' + src.name + '</span>' +
        '</label>'
      );
    }).join('');

    var chips = container.querySelectorAll('.source-chip');
    for (var i = 0; i < chips.length; i++) {
      (function (chip) {
        var chk = chip.querySelector('input');
        chk.addEventListener('change', function () {
          if (chk.checked) chip.classList.add('selected');
          else chip.classList.remove('selected');
        });
      })(chips[i]);
    }
  }

  var categorySelect = document.getElementById('item-category');
  var sourcesLegend = document.getElementById('sources-legend');
  var currencySelect = document.getElementById('item-currency');
  var targetLabel = document.getElementById('label-item-target');

  function updateCategorySources() {
    if (!categorySelect || !sourcesLegend) return;
    var cat = categorySelect.value;
    sourcesLegend.textContent = 'Fontes (' + cat + ')';
    renderSourceChips('sources-chips-container', cat, 'src-chk');
  }

  function updateCurrencyLabel() {
    if (!currencySelect || !targetLabel) return;
    var val = currencySelect.value;
    if (val === 'USD') {
      targetLabel.textContent = 'Preço-alvo (US$)';
    } else if (val === 'BRL') {
      targetLabel.textContent = 'Preço-alvo (R$)';
    } else {
      targetLabel.textContent = 'Preço-alvo (R$ / Livre)';
    }
  }

  if (categorySelect) categorySelect.addEventListener('change', updateCategorySources);
  if (currencySelect) currencySelect.addEventListener('change', updateCurrencyLabel);

  var tabButtons = document.querySelectorAll('.nav-tab');
  for (var t = 0; t < tabButtons.length; t++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var j = 0; j < tabButtons.length; j++) tabButtons[j].classList.remove('active');
        var panels = document.querySelectorAll('.tab-panel');
        for (var k = 0; k < panels.length; k++) panels[k].classList.remove('active');
        btn.classList.add('active');
        var targetPanel = document.getElementById(btn.getAttribute('data-tab'));
        if (targetPanel) targetPanel.classList.add('active');
      });
    })(tabButtons[t]);
  }

  // Busca Real Híbrida com filtro de Moeda (ALL / BRL / USD) e identificação de Chave (Key) ou Conta
  async function directBrowserSearch(term, sources, currencyFilter) {
    var offers = [];
    var errors = [];
    var currMode = currencyFilter || 'ALL';

    var tasks = sources.map(async function (src) {
      try {
        if (src === 'CheapShark (USD)' || src === 'CheapShark') {
          var csUrl = 'https://www.cheapshark.com/api/1.0/deals?title=' + encodeURIComponent(term) + '&pageSize=12&sortBy=Price';
          var r = await fetch(csUrl);
          if (r.ok) {
            var data = await r.json();
            data.forEach(function (d) {
              var stName = CS_STORES[String(d.storeID)] || ('CheapShark #' + d.storeID);
              var title = d.title || term;
              offers.push({
                name: title,
                store: stName,
                kind: 'Revendedor',
                delivery_type: detectDeliveryType(title, stName),
                currency: 'USD',
                price: parseFloat(d.salePrice || '0'),
                original_price: parseFloat(d.normalPrice || '0'),
                discount: parseFloat(d.savings || '0'),
                url: 'https://www.cheapshark.com/redirect?dealID=' + (d.dealID || ''),
                thumb: d.thumb || ''
              });
            });
          }
        } else if (src === 'Steam') {
          var steamFound = false;
          try {
            var proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(term) + '&cc=br&l=brazilian');
            var sr = await fetch(proxyUrl);
            if (sr.ok) {
              var sdata = await sr.json();
              var sitems = (sdata.items || []).slice(0, 6);
              sitems.forEach(function (app) {
                if (app.price && app.price.final) {
                  steamFound = true;
                  var finalPrice = app.price.final / 100;
                  var initPrice = (app.price.initial || app.price.final) / 100;
                  var disc = initPrice > finalPrice ? Math.round(((initPrice - finalPrice) / initPrice) * 100) : 0;
                  var title = app.name || term;
                  offers.push({
                    name: title,
                    store: 'Steam',
                    kind: 'Loja oficial',
                    delivery_type: detectDeliveryType(title, 'Steam'),
                    currency: 'BRL',
                    price: finalPrice,
                    original_price: initPrice,
                    discount: disc,
                    url: 'https://store.steampowered.com/app/' + app.id + '/',
                    thumb: app.tiny_image || ''
                  });
                }
              });
            }
          } catch (e) {}

          if (!steamFound) {
            var stCs = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=1&title=' + encodeURIComponent(term) + '&pageSize=6');
            if (stCs.ok) {
              var stData = await stCs.json();
              stData.forEach(function (d) {
                var title = d.title || term;
                offers.push({
                  name: title,
                  store: 'Steam',
                  kind: 'Loja oficial',
                  delivery_type: detectDeliveryType(title, 'Steam'),
                  currency: 'USD',
                  price: parseFloat(d.salePrice || '0'),
                  original_price: parseFloat(d.normalPrice || '0'),
                  discount: parseFloat(d.savings || '0'),
                  url: d.steamAppID ? ('https://store.steampowered.com/app/' + d.steamAppID + '/') : ('https://www.cheapshark.com/redirect?dealID=' + d.dealID),
                  thumb: d.thumb || ''
                });
              });
            }
          }
        } else if (src === 'Epic Games') {
          var epRes = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=25&title=' + encodeURIComponent(term) + '&pageSize=6');
          var epAdded = false;
          if (epRes.ok) {
            var epData = await epRes.json();
            epData.forEach(function (d) {
              epAdded = true;
              var title = d.title || term;
              offers.push({
                name: title,
                store: 'Epic Games',
                kind: 'Loja oficial',
                delivery_type: detectDeliveryType(title, 'Epic Games'),
                currency: 'USD',
                price: parseFloat(d.salePrice || '0'),
                original_price: parseFloat(d.normalPrice || '0'),
                discount: parseFloat(d.savings || '0'),
                url: 'https://www.cheapshark.com/redirect?dealID=' + (d.dealID || ''),
                thumb: d.thumb || ''
              });
            });
          }
          if (!epAdded) {
            offers.push({
              name: term + ' (Ver na Epic Games Store)',
              store: 'Epic Games',
              kind: 'Comparador / Loja',
              delivery_type: detectDeliveryType(term, 'Epic Games'),
              currency: 'BRL',
              price: 0,
              original_price: 0,
              discount: 0,
              url: 'https://store.epicgames.com/pt-BR/browse?q=' + encodeURIComponent(term) + '&sortBy=relevancy'
            });
          }
        } else if (src === 'GOG') {
          var gogRes = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=7&title=' + encodeURIComponent(term) + '&pageSize=6');
          var gogAdded = false;
          if (gogRes.ok) {
            var gogData = await gogRes.json();
            gogData.forEach(function (d) {
              gogAdded = true;
              var title = d.title || term;
              offers.push({
                name: title,
                store: 'GOG',
                kind: 'Loja oficial',
                delivery_type: detectDeliveryType(title, 'GOG'),
                currency: 'USD',
                price: parseFloat(d.salePrice || '0'),
                original_price: parseFloat(d.normalPrice || '0'),
                discount: parseFloat(d.savings || '0'),
                url: 'https://www.cheapshark.com/redirect?dealID=' + (d.dealID || ''),
                thumb: d.thumb || ''
              });
            });
          }
          if (!gogAdded) {
            offers.push({
              name: term + ' (Catálogo GOG)',
              store: 'GOG',
              kind: 'Comparador / Loja',
              delivery_type: detectDeliveryType(term, 'GOG'),
              currency: 'BRL',
              price: 0,
              original_price: 0,
              discount: 0,
              url: 'https://www.gog.com/en/games?query=' + encodeURIComponent(term)
            });
          }
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
            name: term + ' (Chaves e Contas no Google Shopping)',
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
            name: term + ' (Ofertas na Comunidade Promobit)',
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
    return { offers: offers, errors: errors };
  }

  async function executeRealSearch(term, sources, currencyFilter) {
    var currMode = currencyFilter || 'ALL';
    var savedCfg = JSON.parse(localStorage.getItem(STORAGE_CFG_KEY) || '{}');
    if (window.location.protocol.startsWith('http')) {
      try {
        var res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            term: term,
            sources: sources,
            currency: currMode,
            rss_feeds: savedCfg.rss_feeds || []
          })
        });
        if (res.ok) {
          var data = await res.json();
          if (data && Array.isArray(data.offers)) return data;
        }
      } catch (e) {}
    }
    return await directBrowserSearch(term, sources, currMode);
  }

  function renderOfferListHTML(offers, errors) {
    if (!offers || !offers.length) {
      return '<p style="color:var(--muted);">Nenhuma oferta encontrada com o filtro de moeda selecionado. ' + (errors || []).join(' ') + '</p>';
    }
    return offers.map(function (o) {
      var hasPrice = Number(o.price) > 0;
      var sym = formatCurrencySymbol(o.currency);
      var deliveryBadge = formatDeliveryBadge(o.delivery_type || detectDeliveryType(o.name, o.store));

      var priceHtml = hasPrice
        ? '<span style="color:#34d399; font-weight:700; font-size:0.98rem;">' + sym + ' ' + Number(o.price).toFixed(2) + ' (' + o.currency + ')</span>' +
          (Number(o.original_price) > Number(o.price) ? ' <s style="color:var(--muted); font-size:0.8rem;">' + sym + ' ' + Number(o.original_price).toFixed(2) + '</s>' : '') +
          (Number(o.discount) > 0 ? '<span class="tag green" style="margin-left:8px;">-' + Math.round(o.discount) + '%</span>' : '')
        : '<span class="tag">Catálogo (' + o.currency + ')</span>';

      var thumbHtml = o.thumb
        ? '<img src="' + o.thumb + '" alt="" class="offer-thumb" loading="lazy" />'
        : '';

      return (
        '<div class="list-item">' +
          '<div class="offer-left">' +
            thumbHtml +
            '<div>' +
              '<strong>' + o.name + '</strong>' +
              '<div style="font-size:0.84rem; color:var(--muted); margin-top:4px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">' +
                '<span class="tag">' + o.store + '</span>' +
                deliveryBadge +
                priceHtml +
              '</div>' +
            '</div>' +
          '</div>' +
          '<a href="' + o.url + '" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="text-decoration:none;">Abrir Oferta ↗</a>' +
        '</div>'
      );
    }).join('');
  }

  async function checkServerHealth() {
    var pill = document.getElementById('server-status');
    var txt = document.getElementById('status-text');
    if (!pill || !txt) return;
    if (window.location.protocol.startsWith('http')) {
      try {
        var res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          pill.classList.remove('offline');
          txt.textContent = 'Servidor online (API ativa)';
          return;
        }
      } catch (e) {}
    }
    pill.classList.remove('offline');
    txt.textContent = 'Busca Direta Ativa (PWA)';
  }

  var chkMonitorar = document.getElementById('chk-monitorar');
  var inputEmail = document.getElementById('dest-email');
  var emailReqStar = document.getElementById('email-req-star');
  var monitorBadgeState = document.getElementById('monitor-badge-state');
  var chkChannelEmail = document.getElementById('chn-email');

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

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function qualifiesOffer(item, offer) {
    if (Number(offer.price) <= 0) return false;
    var filterCurr = item.currency_filter || 'ALL';
    if (filterCurr !== 'ALL' && offer.currency !== filterCurr) return false;

    var hasRule = item.target_price !== null || item.min_discount !== null;
    if (!hasRule) return false;

    var priceOk =
      item.target_price !== null &&
      (filterCurr === 'ALL' ? offer.currency === 'BRL' : offer.currency === filterCurr) &&
      Number(offer.price) <= Number(item.target_price);
    var discountOk = item.min_discount !== null && Number(offer.discount) >= Number(item.min_discount);
    return priceOk || discountOk;
  }

  var btnQuickCheck = document.getElementById('btn-quick-check');
  if (btnQuickCheck) {
    btnQuickCheck.addEventListener('click', async function () {
      showError('');
      var name = document.getElementById('item-name').value.trim();
      var currFilter = document.getElementById('item-currency').value;
      var sources = Array.from(document.querySelectorAll('.src-chk:checked')).map(function (el) { return el.value; });
      if (!name) return showError('Digite o nome do produto ou jogo para pesquisar.');
      if (!sources.length) return showError('Selecione pelo menos uma fonte.');

      var previewCard = document.getElementById('quick-search-card');
      var previewOut = document.getElementById('quick-search-output');
      previewCard.style.display = 'block';
      previewOut.innerHTML = '<p style="color:var(--muted);">Consultando preços reais nas lojas selecionadas...</p>';
      btnQuickCheck.disabled = true;

      try {
        var result = await executeRealSearch(name, sources, currFilter);
        previewOut.innerHTML = renderOfferListHTML(result.offers, result.errors);
      } finally {
        btnQuickCheck.disabled = false;
      }
    });
  }

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

      if (!name) return showError('Informe o nome do produto ou jogo.');
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
        channels: channels,
        destinations: { 'E-mail': email, Telegram: telegram, WhatsApp: whatsapp },
        frequency: frequency,
        active: wantsMonitor,
        created_at: new Date().toISOString()
      };

      var items = getItems();
      items.unshift(newItem);
      saveItems(items);

      document.getElementById('item-name').value = '';
      document.getElementById('item-target').value = '';
      document.getElementById('item-discount').value = '';
      renderMonitors();

      showSuccess('Monitoramento de "' + name + '" salvo! Buscando ofertas atuais...');

      var previewCard = document.getElementById('quick-search-card');
      var previewOut = document.getElementById('quick-search-output');
      previewCard.style.display = 'block';
      previewOut.innerHTML = '<p style="color:var(--muted);">Verificando ofertas em tempo real para "' + name + '"...</p>';

      var searchRes = await executeRealSearch(name, sources, currency_filter);
      previewOut.innerHTML = renderOfferListHTML(searchRes.offers, searchRes.errors);

      if (wantsMonitor && searchRes.offers && searchRes.offers.length) {
        var alerts = getAlerts();
        var triggeredCount = 0;
        searchRes.offers.forEach(function (off) {
          if (qualifiesOffer(newItem, off)) {
            alerts.push({
              id: generateId(),
              item_id: newItem.id,
              name: off.name,
              store: off.store,
              delivery_type: off.delivery_type || detectDeliveryType(off.name, off.store),
              currency: off.currency,
              original_price: off.original_price,
              price: off.price,
              discount: off.discount,
              url: off.url,
              created_at: new Date().toISOString(),
              notified: channels.join(', ')
            });
            triggeredCount++;
          }
        });
        if (triggeredCount > 0) {
          saveAlerts(alerts);
          renderAlerts();
          showSuccess('Monitoramento salvo e ' + triggeredCount + ' alerta(s) encontrado(s) imediatamente!');
        }
      }
    });
  }

  function formatCurrLabel(curr) {
    if (curr === 'BRL') return 'Somente Real (R$)';
    if (curr === 'USD') return 'Somente Dólar (US$)';
    return 'Livre (BRL + USD)';
  }

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
      return (
        '<div class="list-item" data-id="' + item.id + '">' +
          '<div>' +
            '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap;">' +
              '<strong style="font-size:1rem;">' + item.name + '</strong>' +
              '<span class="tag">' + item.category + '</span>' +
              '<span class="tag">' + formatCurrLabel(currFilter) + '</span>' +
              '<span class="tag ' + (item.active ? 'green' : 'paused') + '">' + (item.active ? 'Monitorando' : 'Pausado') + '</span>' +
            '</div>' +
            '<div style="font-size:0.83rem; color: var(--muted);">' +
              'Alvo: <strong>' + (item.target_price ? sym + Number(item.target_price).toFixed(2) : 'Não definido') + '</strong> • ' +
              'Desconto mín.: <strong>' + (item.min_discount ? item.min_discount + '%' : 'Não definido') + '</strong> • ' +
              'Fontes: ' + item.sources.join(', ') +
            '</div>' +
            '<div style="font-size:0.8rem; color: var(--muted); margin-top:2px;">' +
              'E-mail: <strong>' + ((item.destinations && item.destinations['E-mail']) || 'Não informado') + '</strong> • Frequência: ' + item.frequency +
            '</div>' +
          '</div>' +
          '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
            '<button class="btn btn-primary btn-sm js-check-one" data-id="' + item.id + '">Buscar ofertas</button>' +
            '<button class="btn btn-outline btn-sm js-toggle-one" data-id="' + item.id + '">' + (item.active ? 'Pausar' : 'Ativar') + '</button>' +
            '<button class="btn btn-danger js-delete-one" data-id="' + item.id + '">Excluir</button>' +
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
        previewOut.innerHTML = '<p style="color:var(--muted);">Consultando ofertas para "' + item.name + '"...</p>';
        try {
          var res = await executeRealSearch(item.name, item.sources, item.currency_filter || 'ALL');
          previewOut.innerHTML = renderOfferListHTML(res.offers, res.errors);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Buscar ofertas';
        }
      });
    });

    container.querySelectorAll('.js-toggle-one').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var items = getItems();
        var item = items.find(function (i) { return i.id === id; });
        if (!item) return;
        if (!item.active) {
          var email = (item.destinations && item.destinations['E-mail']) || '';
          if (!isValidEmail(email)) {
            alert('Este item não possui um e-mail válido cadastrado. Exclua e cadastre novamente informando seu e-mail.');
            return;
          }
        }
        item.active = !item.active;
        saveItems(items);
        renderMonitors();
      });
    });

    container.querySelectorAll('.js-delete-one').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var items = getItems().filter(function (i) { return i.id !== id; });
        saveItems(items);
        renderMonitors();
      });
    });
  }

  var btnScanNow = document.getElementById('btn-scan-now');
  if (btnScanNow) {
    btnScanNow.addEventListener('click', async function () {
      var items = getItems();
      var activeItems = items.filter(function (i) { return i.active; });

      if (!activeItems.length) {
        alert('Cadastre pelo menos um monitoramento ativo antes de verificar.');
        return;
      }

      btnScanNow.disabled = true;
      btnScanNow.textContent = 'Verificando lojas...';

      var allFoundOffers = [];
      var newAlertsCount = 0;
      var alerts = getAlerts();

      try {
        for (var i = 0; i < activeItems.length; i++) {
          var item = activeItems[i];
          var res = await executeRealSearch(item.name, item.sources, item.currency_filter || 'ALL');
          (res.offers || []).forEach(function (off) {
            allFoundOffers.push(off);
            if (qualifiesOffer(item, off)) {
              alerts.push({
                id: generateId(),
                item_id: item.id,
                name: off.name,
                store: off.store,
                delivery_type: off.delivery_type || detectDeliveryType(off.name, off.store),
                currency: off.currency,
                original_price: off.original_price,
                price: off.price,
                discount: off.discount,
                url: off.url,
                created_at: new Date().toISOString(),
                notified: (item.channels || ['Painel']).join(', ')
              });
              newAlertsCount++;
            }
          });
        }

        saveAlerts(alerts);
        renderAlerts();

        var previewCard = document.getElementById('quick-search-card');
        var previewOut = document.getElementById('quick-search-output');
        previewCard.style.display = 'block';
        previewOut.innerHTML = renderOfferListHTML(allFoundOffers, []);
        showSuccess('Varredura concluída! ' + allFoundOffers.length + ' oferta(s) consultada(s) e ' + newAlertsCount + ' alerta(s) disparado(s).');
      } finally {
        btnScanNow.disabled = false;
        btnScanNow.textContent = 'Verificar todos agora';
      }
    });
  }

  var btnRunSearch = document.getElementById('btn-run-search');
  var inputSearchTerm = document.getElementById('search-term');
  var selectSearchCurrency = document.getElementById('search-currency');

  async function triggerSearchTab() {
    var term = inputSearchTerm.value.trim();
    var currFilter = selectSearchCurrency ? selectSearchCurrency.value : 'ALL';
    var sources = Array.from(document.querySelectorAll('.search-src-chk:checked')).map(function (el) { return el.value; });
    var out = document.getElementById('search-output');

    if (!term || !sources.length) {
      out.innerHTML = '<p style="color:#fca5a5;">Digite o nome do jogo/produto e mantenha ao menos uma fonte selecionada.</p>';
      return;
    }

    btnRunSearch.disabled = true;
    btnRunSearch.textContent = 'Buscando ofertas reais...';
    out.innerHTML = '<p style="color:var(--muted);">Consultando APIs da Steam, CheapShark, GOG, Epic e lojas...</p>';

    try {
      var data = await executeRealSearch(term, sources, currFilter);
      out.innerHTML = renderOfferListHTML(data.offers, data.errors);
    } finally {
      btnRunSearch.disabled = false;
      btnRunSearch.textContent = 'Buscar nas lojas';
    }
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
      return (
        '<div class="list-item">' +
          '<div>' +
            '<strong>' + a.name + '</strong> ' +
            deliveryBadge +
            '<span class="tag green" style="margin-left:4px;">' + sym + ' ' + Number(a.price).toFixed(2) + ' (-' + Math.round(a.discount) + '%)</span>' +
            '<div style="font-size:0.82rem; color:var(--muted); margin-top:4px;">' +
              'Loja: ' + a.store + ' • Moeda: ' + a.currency + ' • Via: ' + (a.notified || 'Painel') + ' • ' + new Date(a.created_at).toLocaleString('pt-BR') +
            '</div>' +
          '</div>' +
          '<a href="' + a.url + '" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="text-decoration:none;">Ver oferta</a>' +
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

      var header = ['data', 'item', 'tipo_entrega', 'loja', 'moeda', 'preco_original', 'preco', 'desconto_pct', 'url'];
      var rows = alerts.map(function (a) {
        return [
          a.created_at,
          '"' + String(a.name || '').split('"').join('""') + '"',
          a.delivery_type || detectDeliveryType(a.name, a.store),
          a.store,
          a.currency,
          a.original_price,
          a.price,
          a.discount,
          a.url
        ].join(';');
      });

      var blob = new Blob(['\ufeff' + [header.join(';')].concat(rows).join('\n')], { type: 'text/csv;charset=utf-8;' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'alertas_monitordepromocoes.csv';
      link.click();
    });
  }

  function loadSavedConfig() {
    var cfg = JSON.parse(localStorage.getItem(STORAGE_CFG_KEY) || '{}');
    if (cfg.default_email) {
      var el = document.getElementById('cfg-email-default');
      if (el) el.value = cfg.default_email;
      if (inputEmail && !inputEmail.value) inputEmail.value = cfg.default_email;
    }
    if (cfg.telegram_bot_token) document.getElementById('cfg-telegram-token').value = cfg.telegram_bot_token;
    if (cfg.telegram_chat_id) document.getElementById('cfg-telegram-chat').value = cfg.telegram_chat_id;
    if (cfg.rss_feeds && cfg.rss_feeds[0] && cfg.rss_feeds[0].url) {
      document.getElementById('cfg-rss-url').value = cfg.rss_feeds[0].url;
    }
  }

  var btnSaveConfig = document.getElementById('btn-save-config');
  if (btnSaveConfig) {
    btnSaveConfig.addEventListener('click', function () {
      var default_email = document.getElementById('cfg-email-default').value.trim();
      var telegram_bot_token = document.getElementById('cfg-telegram-token').value.trim();
      var telegram_chat_id = document.getElementById('cfg-telegram-chat').value.trim();
      var rssUrl = document.getElementById('cfg-rss-url').value.trim();

      var cfg = {
        default_email: default_email,
        telegram_bot_token: telegram_bot_token,
        telegram_chat_id: telegram_chat_id,
        rss_feeds: rssUrl ? [{ name: 'Promobit (RSS)', url: rssUrl }] : []
      };

      localStorage.setItem(STORAGE_CFG_KEY, JSON.stringify(cfg));
      if (default_email && inputEmail && !inputEmail.value) inputEmail.value = default_email;
      alert('Configurações salvas com sucesso!');
    });
  }

  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  updateCategorySources();
  updateCurrencyLabel();
  renderSourceChips('search-chips-container', 'Jogos', 'search-src-chk');
  syncMonitorEmailRule();
  loadSavedConfig();
  checkServerHealth();
  renderMonitors();
  renderAlerts();
})();
