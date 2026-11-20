export type DeliveryType = 'Chave (Key)' | 'Conta' | 'Ativação Direta (Conta)';

export type CurrencyCode = 'BRL' | 'USD';
export type CurrencyFilter = 'ALL' | CurrencyCode;
export type ProductCategory = 'Auto' | 'Jogos' | 'Software' | 'Hardware' | 'Eletrônicos' | 'Outros';

export interface Offer {
  name: string;
  store: string;
  kind: 'Loja oficial' | 'Revendedor' | 'Comparador / Loja' | 'RSS';
  delivery_type: DeliveryType;
  currency: CurrencyCode;
  original_price: number;
  price: number;
  price_brl_estimated?: number;
  discount: number;
  url: string;
  thumb?: string;
  relevance?: number;
  checked_at?: string;
}

export interface RssFeedConfig {
  name?: string;
  url: string;
}

export interface MonitorItem {
  id: string;
  name: string;
  category: string;
  currency_filter?: CurrencyFilter;
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

export interface AlertRecord extends Offer {
  id: string;
  item_id: string;
  dedup_key: string;
  created_at: string;
  notified: string;
  notification_errors?: string[];
}

export interface RuntimeConfig {
  rss_feeds?: RssFeedConfig[];
  telegram_bot_token?: string;
  telegram_chat_id?: string;
  whatsapp_token?: string;
  whatsapp_phone_number_id?: string;
  whatsapp_api_version?: string;
  smtp_host?: string;
  smtp_port?: number | string;
  smtp_user?: string;
  smtp_password?: string;
  smtp_from?: string;
}

export interface ScanItemResult {
  item_id: string;
  item: string;
  offers: Offer[];
  alerts: AlertRecord[];
  errors: string[];
  usd_to_brl_rate: number | null;
  detected_category?: ProductCategory;
}
