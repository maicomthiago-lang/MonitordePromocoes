# Monitor de Promoções 5.1 (PWA + Vercel Serverless)

Rastreador de promoções e ofertas em Real (`BRL`) e Dólar (`USD`) com filtro de relevância, classificação automática de tipo de entrega e envio de alertas via Painel, E-mail (SMTP), Telegram e WhatsApp.

## Principais Recursos (v5.1)
- **Pesquisa Livre Inteligente (`Auto`):** detecta automaticamente se o termo é **Software** (ex.: `Windows 11`, `Office 365`), **Hardware** (`RTX 4070`, `SSD NVMe`), **Eletrônicos** ou **Jogos**, filtrando falsos positivos (ex.: jogos `"for Windows 11"`) e priorizando fontes relevantes.
- **Moedas `BRL` / `USD` com conversão em tempo real:** consulta cotação USD → BRL para exibir valor estimado em Reais e comparar preços-alvo mesmo no modo `Livre`.
- **Classificação de Entrega:** distingue `🔑 Chave (Key)`, `⚡ Ativação Direta (Conta)` e `👤 Conta`.
- **Segurança Hardened:** prevenção de XSS no frontend, CSP estrito (`script-src 'self'`), proteção SSRF em feeds RSS/Atom (via `fast-xml-parser` com `processEntities: false`), validação de payloads com `zod`, rate limiting, proteção contra CSV Formula Injection e proteção contra Path Traversal.
- **Arquitetura Unificada:** backend modular em `lib/` compartilhado entre Vercel (`api/index.ts`) e servidor local (`dev-server.mjs`), com frontend único em `public/`.

## Comandos
```bash
npm install
npm run typecheck   # Verificação TypeScript estrita
npm test            # Compila e executa toda a suíte de testes (node:test)
npm run dev         # Compila e inicia servidor local em http://127.0.0.1:8765
```

## Variáveis de Ambiente (Servidor / Vercel)
- **E-mail (SMTP):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- **Telegram:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- **WhatsApp Cloud API:** `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`
- **Cron & Segurança:** `CRON_SECRET`, `ALLOWED_ORIGIN`
- **Persistência opcional para Cron na Vercel (Upstash Redis / Vercel KV):** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (ou `KV_REST_API_URL`, `KV_REST_API_TOKEN`)
- **Feeds RSS fixos (JSON):** `RSS_FEEDS='[{"name":"Meu Feed","url":"https://exemplo.com/rss"}]'`
