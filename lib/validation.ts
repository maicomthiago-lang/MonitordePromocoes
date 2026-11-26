import { z } from 'zod';

export const currencyFilterSchema = z.enum(['ALL', 'BRL', 'USD']).default('ALL');

export const categorySchema = z
  .enum(['Auto', 'Jogos', 'Software', 'Hardware', 'Eletrônicos', 'Outros'])
  .default('Auto');

export const rssFeedSchema = z.object({
  name: z.string().trim().max(80).optional(),
  url: z.string().trim().url().max(1000)
});

export const searchRequestSchema = z.object({
  term: z.string().trim().min(1, 'Informe o termo de busca.').max(120, 'Termo muito longo.'),
  sources: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  rss_feeds: z.array(rssFeedSchema).max(5).optional().default([]),
  currency: currencyFilterSchema.optional().default('ALL'),
  category: categorySchema.optional().default('Auto')
});

export const monitorItemSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60).default('Jogos'),
  currency_filter: currencyFilterSchema.optional().default('ALL'),
  target_price: z.number().positive().max(1_000_000).nullable().optional().default(null),
  min_discount: z.number().min(1).max(100).nullable().optional().default(null),
  sources: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  channels: z.array(z.string().trim().min(1).max(40)).max(10).default(['Painel']),
  destinations: z.record(z.string(), z.string().trim().max(254)).default({}),
  frequency: z.string().trim().min(1).max(40).default('A cada hora'),
  active: z.boolean().default(true),
  created_at: z.string().trim().max(64).default(() => new Date().toISOString()),
  last_checked: z.string().trim().max(64).optional(),
  last_offer: z
    .object({
      store: z.string().trim().max(80),
      currency: z.enum(['BRL', 'USD']),
      original_price: z.number().nonnegative(),
      price: z.number().nonnegative(),
      discount: z.number().min(0).max(100),
      price_brl_estimated: z.number().nonnegative().optional(),
      original_price_brl_estimated: z.number().nonnegative().optional(),
      url: z.string().trim().max(2000).optional()
    })
    .optional()
});

export const runtimeConfigSchema = z
  .object({
    rss_feeds: z.array(rssFeedSchema).max(5).optional(),
    telegram_bot_token: z.string().trim().max(200).optional(),
    telegram_chat_id: z.string().trim().max(100).optional(),
    whatsapp_token: z.string().trim().max(500).optional(),
    whatsapp_phone_number_id: z.string().trim().max(100).optional(),
    whatsapp_api_version: z.string().trim().max(20).optional(),
    smtp_host: z.string().trim().max(200).optional(),
    smtp_port: z.union([z.number().int().min(1).max(65535), z.string().max(10)]).optional(),
    smtp_user: z.string().trim().max(200).optional(),
    smtp_password: z.string().trim().max(200).optional(),
    smtp_from: z.string().trim().max(200).optional()
  })
  .optional()
  .default({});

export const scanRequestSchema = z.object({
  items: z.array(monitorItemSchema).max(20, 'Máximo de 20 monitoramentos por varredura.'),
  config: runtimeConfigSchema,
  existing_alert_keys: z.array(z.string().trim().max(64)).max(500).optional().default([])
});

export const saveMonitorsRequestSchema = z.object({
  items: z.array(monitorItemSchema).max(100)
});
