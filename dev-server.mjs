import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const CS_STORES = {
  '1': 'Steam', '2': 'GamersGate', '3': 'Green Man Gaming', '7': 'GOG',
  '11': 'Humble Store', '13': 'Ubisoft Store', '15': 'Fanatical', '21': 'WinGameStore',
  '23': 'GameBillet', '24': 'Voidu', '25': 'Epic Games', '27': 'Gamesplanet'
};

async function runRealSearch(term, sources) {
  const offers = [];
  const errors = [];

  await Promise.all(sources.map(async (src) => {
    try {
      if (src === 'Steam') {
        const res = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=br&l=brazilian`);
        const data = await res.json();
        for (const app of (data.items || []).slice(0, 6)) {
          if (app.price?.final) {
            const finalP = app.price.final / 100;
            const origP = (app.price.initial || app.price.final) / 100;
            const disc = origP > finalP ? Math.round(((origP - finalP) / origP) * 100) : 0;
            offers.push({
              name: app.name, store: 'Steam', kind: 'Loja oficial', currency: 'BRL',
              price: finalP, original_price: origP, discount: disc,
              url: `https://store.steampowered.com/app/${app.id}/`, thumb: app.tiny_image
            });
          }
        }
      } else if (src === 'CheapShark (USD)' || src === 'CheapShark' || src === 'Epic Games' || src === 'GOG') {
        const storeParam = src === 'Epic Games' ? '&storeID=25' : (src === 'GOG' ? '&storeID=7' : '');
        const res = await fetch(`https://www.cheapshark.com/api/1.0/deals?title=${encodeURIComponent(term)}&pageSize=8&sortBy=Price${storeParam}`);
        const data = await res.json();
        if (Array.isArray(data) && data.length) {
          for (const d of data) {
            offers.push({
              name: d.title, store: CS_STORES[String(d.storeID)] || src, kind: 'Revendedor', currency: 'USD',
              price: Number(d.salePrice), original_price: Number(d.normalPrice), discount: Number(d.savings),
              url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`, thumb: d.thumb
            });
          }
        } else if (src === 'Epic Games') {
          offers.push({ name: `${term} (Epic Games Store)`, store: 'Epic Games', kind: 'Comparador / Loja', currency: 'BRL', price: 0, original_price: 0, discount: 0, url: `https://store.epicgames.com/pt-BR/browse?q=${encodeURIComponent(term)}` });
        } else if (src === 'GOG') {
          offers.push({ name: `${term} (GOG.com)`, store: 'GOG', kind: 'Comparador / Loja', currency: 'BRL', price: 0, original_price: 0, discount: 0, url: `https://www.gog.com/en/games?query=${encodeURIComponent(term)}` });
        }
      } else if (src === 'Nuuvem') {
        offers.push({ name: `${term} (Nuuvem Brasil)`, store: 'Nuuvem', kind: 'Comparador / Loja', currency: 'BRL', price: 0, original_price: 0, discount: 0, url: `https://www.nuuvem.com/br-pt/catalog/search/${encodeURIComponent(term)}` });
      } else if (src === 'Google Shopping') {
        offers.push({ name: `${term} (Google Shopping)`, store: 'Google Shopping', kind: 'Comparador / Loja', currency: 'BRL', price: 0, original_price: 0, discount: 0, url: `https://www.google.com.br/search?tbm=shop&q=${encodeURIComponent(term)}` });
      } else if (src === 'Amazon') {
        offers.push({ name: `${term} (Amazon Brasil)`, store: 'Amazon', kind: 'Comparador / Loja', currency: 'BRL', price: 0, original_price: 0, discount: 0, url: `https://www.amazon.com.br/s?k=${encodeURIComponent(term)}` });
      } else if (src === 'Sites de cupons') {
        offers.push({ name: `${term} (Pelando Cupons)`, store: 'Sites de cupons', kind: 'Comparador / Loja', currency: 'BRL', price: 0, original_price: 0, discount: 0, url: `https://www.pelando.com.br/busca?q=${encodeURIComponent(term)}` });
      } else if (src === 'Promobit (RSS)') {
        offers.push({ name: `${term} (Promobit Ofertas)`, store: 'Promobit (RSS)', kind: 'Comparador / Loja', currency: 'BRL', price: 0, original_price: 0, discount: 0, url: `https://www.promobit.com.br/buscar/?q=${encodeURIComponent(term)}` });
      }
    } catch (e) {
      errors.push(`${src}: ${e.message}`);
    }
  }));

  offers.sort((a, b) => (a.price > 0 && b.price === 0 ? -1 : a.price === 0 && b.price > 0 ? 1 : a.price - b.price));
  return { offers, errors };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, runtime: 'Node.js Local + Vercel Ready', time: new Date().toISOString() }));
  }

  if (url.pathname === '/api/search' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { term, sources } = JSON.parse(body || '{}');
        const result = await runRealSearch(String(term || '').trim(), Array.isArray(sources) ? sources : ['Steam']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'public', 'index.html');

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Monitor de Promoções 4.0 rodando em http://127.0.0.1:${PORT}`);
});
