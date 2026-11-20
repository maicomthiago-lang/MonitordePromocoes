import type { DeliveryType } from './types.js';

const ACCOUNT_PATTERNS: RegExp[] = [
  /\bconta\s+(compartilhada|prim[aá]ria|secund[aá]ria|offline|steam|psn|xbox|epic|completa)\b/i,
  /\b(steam|psn|xbox|epic|gog|origin|ea|ubisoft|microsoft)\s+account\b/i,
  /\b(shared|offline|full\s+access)\s+account\b/i,
  /\bconta\s*[-:]\s*(steam|psn|xbox|offline|prim[aá]ria|secund[aá]ria)\b/i,
  /\b(prim[aá]ria|secund[aá]ria)\s+(ps4|ps5|psn|xbox)\b/i,
  /\bacesso\s+completo\s+(?:a|à)\s+conta\b/i
];

const KEY_PATTERNS: RegExp[] = [
  /\b(cd[-\s]?key|steam\s+key|global\s+key|epic\s+key|gog\s+key|xbox\s+key|psn\s+key|product\s+key)\b/i,
  /\b(chave\s+de\s+ativa[çc][ãa]o|c[óo]digo\s+digital|gift\s+card|voucher|key\s+global|key\s+br)\b/i,
  /\b(licen[çc]a\s+digital|chave\s+original|serial|esd|oem|retail|fpp|key|chave)\b/i
];

const KEY_RESELLER_STORES = [
  'nuuvem',
  'green man',
  'humble',
  'fanatical',
  'gamersgate',
  'wingamestore',
  'gamebillet',
  'voidu',
  'gamesplanet',
  'gamesload',
  '2game',
  'indiegala',
  'dlgamer',
  'noctre',
  'dreamgame',
  'cheapshark'
];

const DIRECT_OFFICIAL_STORES = ['steam', 'epic games', 'epic', 'gog', 'ubisoft store', 'blizzard shop'];

/**
 * Classifica o tipo de entrega da oferta:
 * - 'Conta': venda de conta de terceiros (compartilhada/primária/secundária/offline)
 * - 'Chave (Key)': código/chave/licença de ativação (revendedores autorizados ou menção explícita)
 * - 'Ativação Direta (Conta)': loja oficial onde a licença vai direto para a conta do comprador
 */
export function detectDeliveryType(title: string, store: string, extraText = ''): DeliveryType {
  const combined = `${title || ''} ${extraText || ''}`;

  for (const pattern of ACCOUNT_PATTERNS) {
    if (pattern.test(combined)) {
      return 'Conta';
    }
  }

  for (const pattern of KEY_PATTERNS) {
    if (pattern.test(combined)) {
      return 'Chave (Key)';
    }
  }

  const normalizedStore = (store || '').trim().toLowerCase();

  if (KEY_RESELLER_STORES.some((s) => normalizedStore.includes(s))) {
    return 'Chave (Key)';
  }

  if (DIRECT_OFFICIAL_STORES.some((s) => normalizedStore === s || normalizedStore.includes(s))) {
    return 'Ativação Direta (Conta)';
  }

  return 'Chave (Key)';
}
