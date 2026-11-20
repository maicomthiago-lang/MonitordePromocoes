import type { ProductCategory } from './types.js';

const STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'a',
  'o',
  'as',
  'os',
  'em',
  'para',
  'por',
  'com',
  'the',
  'of',
  'and',
  'for',
  'to',
  'in',
  'on'
]);

const SOFTWARE_PATTERNS: RegExp[] = [
  /\bwindows\s*(7|8|10|11|server|pro|home|enterprise|ltsc)?\b/i,
  /\b(microsoft\s*)?office\s*(365|2016|2019|2021|2024|home|pro|professional)?\b/i,
  /\bmicrosoft\s*365\b/i,
  /\b(adobe|photoshop|illustrator|premiere|acrobat|lightroom|coreldraw|autocad|solidworks)\b/i,
  /\b(antiv[ií]rus|kaspersky|norton|bitdefender|mcafee|avast|eset|malwarebytes)\b/i,
  /\b(vmware|parallels|jetbrains|nordvpn|expressvpn|surfshark|canva\s*pro|chatgpt|copilot)\b/i,
  /\b(licen[çc]a\s+digital|chave\s+windows|serial\s+windows|sistema\s+operacional)\b/i
];

const HARDWARE_PATTERNS: RegExp[] = [
  /\b(rtx|gtx|rx|radeon)\s*\d{3,4}\b/i,
  /\b(ryzen\s*[3579]|core\s*i[3579]|xeon|threadripper)\b/i,
  /\b(ssd|nvme|hd\s*externo|ddr[45]|mem[óo]ria\s*ram|placa\s*de\s*v[ií]deo|placa\s*m[ãa]e)\b/i,
  /\b(water\s*cooler|fonte\s*\d+w|gabinete|monitor\s*gamer|teclado\s*mec[âa]nico|mouse\s*gamer|headset)\b/i
];

const ELECTRONICS_PATTERNS: RegExp[] = [
  /\b(iphone|ipad|macbook|airpods|apple\s*watch|samsung\s*galaxy|xiaomi|redmi|motorola|moto\s*g)\b/i,
  /\b(notebook|laptop|ultrabook|smart\s*tv|tv\s*4k|oled|qled|kindle|alexa|echo\s*dot|chromecast)\b/i,
  /\b(playstation\s*5|ps5\s*console|xbox\s*series|nintendo\s*switch|steam\s*deck|rog\s*ally)\b/i
];

/**
 * Normaliza texto para comparação semântica:
 * - Remove acentos (NFD)
 * - Converte para minúsculas
 * - Separa fronteiras letra<->número (ex.: "Windows11" -> "windows 11", "RTX4070" -> "rtx 4070")
 * - Remove pontuação
 */
export function normalizeForSearch(text: string): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function extractSearchTokens(term: string): string[] {
  const normalized = normalizeForSearch(term);
  if (!normalized) return [];
  const all = normalized.split(' ').filter(Boolean);
  const filtered = all.filter((tok) => !STOPWORDS.has(tok));
  return filtered.length > 0 ? filtered : all;
}

export function detectQueryCategory(term: string): Exclude<ProductCategory, 'Auto'> {
  const normalized = normalizeForSearch(term);
  if (SOFTWARE_PATTERNS.some((re) => re.test(normalized) || re.test(term))) {
    return 'Software';
  }
  if (HARDWARE_PATTERNS.some((re) => re.test(normalized) || re.test(term))) {
    return 'Hardware';
  }
  if (ELECTRONICS_PATTERNS.some((re) => re.test(normalized) || re.test(term))) {
    return 'Eletrônicos';
  }
  return 'Jogos';
}

function tokenMatchesTitleTokens(searchToken: string, titleTokens: string[]): boolean {
  for (const t of titleTokens) {
    if (t === searchToken) return true;
    // Permite plural simples apenas para palavras alfabéticas com >= 4 letras
    if (/^[a-z]{4,}$/.test(searchToken)) {
      if (t === `${searchToken}s` || searchToken === `${t}s`) return true;
    }
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detecta falsos positivos do tipo "Absolute Skat for Windows 11" ou "Capa para iPhone 15",
 * onde o termo buscado aparece apenas após preposições de compatibilidade ("for", "para", "on").
 */
function isCompatibilityOnlyMention(normTitle: string, normTerm: string): boolean {
  if (!normTerm) return false;
  // Se o próprio usuário buscou "para" ou "for" (ex.: "capa para iphone"), não bloqueia
  if (/\b(for|para|compativel|compatible)\b/.test(normTerm)) {
    return false;
  }

  const escaped = escapeRegex(normTerm);
  const compatRegex = new RegExp(`\\b(for|para|on|compativel\\s+com|compatible\\s+with)\\s+${escaped}\\b`, 'g');
  if (!compatRegex.test(normTitle)) {
    return false;
  }

  // Se o título também menciona o termo fora da cláusula "for/para <termo>", mantém
  const stripped = normTitle.replace(compatRegex, ' ').replace(/\s+/g, ' ').trim();
  const strippedTokens = stripped.split(' ').filter(Boolean);
  const queryTokens = extractSearchTokens(normTerm);
  return !queryTokens.every((qTok) => tokenMatchesTitleTokens(qTok, strippedTokens));
}

/**
 * Verifica se o título de uma oferta realmente corresponde ao termo pesquisado.
 * - Exige que TODOS os tokens relevantes do termo apareçam como palavras distintas.
 * - Rejeita falsos positivos como "Absolute Skat for Windows 11" quando a busca é "windows 11".
 */
export function matchesSearchTerm(offerTitle: string, searchTerm: string): boolean {
  const queryTokens = extractSearchTokens(searchTerm);
  if (queryTokens.length === 0) return true;

  const normalizedTitle = normalizeForSearch(offerTitle);
  const normalizedTerm = normalizeForSearch(searchTerm);
  if (!normalizedTitle) return false;

  if (isCompatibilityOnlyMention(normalizedTitle, normalizedTerm)) {
    return false;
  }

  const titleTokens = normalizedTitle.split(' ').filter(Boolean);
  for (const qTok of queryTokens) {
    if (!tokenMatchesTitleTokens(qTok, titleTokens)) {
      return false;
    }
  }

  return true;
}

/**
 * Calcula pontuação de relevância (0 a 115) para ordenar ofertas mais aderentes no topo.
 */
export function scoreOfferRelevance(offerTitle: string, searchTerm: string): number {
  if (!matchesSearchTerm(offerTitle, searchTerm)) return 0;

  const normTitle = normalizeForSearch(offerTitle);
  const normTerm = normalizeForSearch(searchTerm);
  const queryTokens = extractSearchTokens(searchTerm);
  const titleTokens = normTitle.split(' ').filter(Boolean);

  let score = 50;

  if (normTerm && ` ${normTitle} `.includes(` ${normTerm} `)) {
    score += 30;
  }

  if (normTerm && normTitle.startsWith(normTerm)) {
    score += 20;
  }

  if (titleTokens.length > 0) {
    const density = Math.min(1, queryTokens.length / titleTokens.length);
    score += Math.round(density * 15);
  }

  return score;
}
