import type { Language } from '../shared/types';

/**
 * Pure language enforcement for transcripts: a transcript may contain only the selected lecture
 * language plus English. Known silence hallucinations are dropped (no retry); text in another
 * script/language is rejected so the caller retries with a strict language hint.
 */
export type TranscriptCheck =
  | { status: 'ok' }
  | { status: 'silent'; reason: 'no-letters' | 'hallucination' }
  | {
      status: 'reject';
      reason: 'foreign-script' | 'wrong-alphabet' | 'wrong-language' | 'detected-language' | 'repetition';
      detail: string;
    };

/** Subtitle credits and channel phrases that speech models emit for silence or noise. */
const SILENCE_HALLUCINATIONS = [
  /продолжение следует/g,
  /субтитры (?:сделал|создавал|создал|подготовил)(?: \S+)? ?dimatorzok/g,
  /редактор субтитров(?: [а-яa-z]{1,3}\s?[а-яa-z]+)?/g,
  /корректор(?: [а-яa-z]{1,3})? ?егорова/g,
  /спасибо за просмотр/g,
  /подписывайтесь на (?:наш )?канал/g,
  /дякую за перегляд/g,
  /thanks? (?:you )?for watching/g,
  /please subscribe(?: to (?:my|our|the) channel)?/g,
  /subscribe to (?:my|our|the) channel/g,
  /napisy stworzone przez społeczność amara ?org/g,
  /字幕由 ?amara ?org ?社[区區]提供/g,
  /請不吝點贊 ?訂閱(?: ?轉發 ?打賞支持明鏡與點點欄目)?/g,
  /请不吝点赞 ?订阅/g,
  /mbc ?뉴스(?: [가-힣]+)?/g,
  // German, Spanish, French, Italian, Portuguese and Dutch subtitle credits (ZDF/funk, Amara.org).
  /untertitel(?:ung)?(?: im auftrag)? (?:des|vom) zdf(?: für funk)?(?: \d{4})?/g,
  /untertitel(?:ung)? der amara ?org ?community/g,
  /untertitel von stephanie geiges/g,
  /subt[ií]tulos (?:realizados )?por la comunidad de amara ?org/g,
  /sous titres? (?:réalisés )?(?:par|pour) la communauté d ?amara ?org/g,
  /sous titrage (?:st 501|société radio canada)/g,
  /sottotitoli (?:creati )?dalla comunit[àa] (?:di )?amara ?org/g,
  /sottotitoli e revisione a cura di qtss/g,
  /legendas pela comunidade (?:de )?amara ?org/g,
  /ondertiteling door de amara ?org gemeenschap/g,
  // Any short credit naming Amara.org (never said in a lecture).
  /(?:\p{L}+ ){0,6}amara ?org(?: \p{L}+){0,2}/gu,
];
/**
 * Latin-script language profiles: distinctive stop words (×2) and characteristic letters (×1).
 * Words shared with Polish or English (to, on, na, nie, a, in, do, no, as, per, non, come…) are left
 * out so genuine Polish/English speech never scores as a foreign language.
 */
const LATIN_PROFILES: Record<string, { words: Set<string>; letters: RegExp }> = {
  en: {
    words: new Set(
      'the and of is that this with are it for be were can which from have has not or but you they these there what its their our would should about into than then when how been more some will'.split(
        ' ',
      ),
    ),
    letters: /(?:tion|ing|ness)\b/g,
  },
  pl: {
    words: new Set(
      'się nie jest że oraz który która które którzy dla przez jako czy są być może tym jak też już więc gdzie tylko bardzo jeszcze można także żeby'.split(
        ' ',
      ),
    ),
    letters: /[ąćęłńóśźż]/g,
  },
  de: {
    words: new Set(
      'der die das und ist nicht ein eine einen mit den dem des von für auf auch sich wir zu im sie wird werden oder aber wenn dass heute über'.split(
        ' ',
      ),
    ),
    letters: /[äöüß]/g,
  },
  es: {
    words: new Set(
      'el los las del que y por con una es se lo como más pero sus su este esta hoy vamos muy también al'.split(' '),
    ),
    letters: /[ñ¿¡áíú]/g,
  },
  fr: {
    words: new Set(
      'le les des et est une du qui dans pour pas sur avec nous vous ce cette sont au aux aujourd hui'.split(' '),
    ),
    letters: /[çàèùâêîûëïœ]/g,
  },
  it: {
    words: new Set('il gli di che è della delle dei sono questo questa anche nel nella alla oggi'.split(' ')),
    letters: /[àèìòù]/g,
  },
  pt: {
    words: new Set('os das dos em uma que não com por mais é são pela pelo também muito você isso hoje'.split(' ')),
    letters: /[ãõçâêô]/g,
  },
  cs: {
    words: new Set('jsou není také který která které tento toto pro při podle jsem jsme byl bylo že'.split(' ')),
    letters: /[řěůčšžý]/g,
  },
  sk: {
    words: new Set('sú sa ako aj ktorý ktorá ktoré pre pri podľa tento táto toto som sme bol bolo že'.split(' ')),
    letters: /[ľĺŕäôčšžý]/g,
  },
};
const LATIN_NAMES: Record<string, string> = {
  en: 'English',
  pl: 'Polish',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  cs: 'Czech',
  sk: 'Slovak',
};
/** Cyrillic markers: letters and frequent words that occur in only one of the three languages. */
const UKRAINIAN_WORDS = new Set(
  'що це ця цей ці як також дуже отже який яка яке які щоб бо він вона вони від зі із лише чи'.split(' '),
);
const RUSSIAN_WORDS = new Set(
  'что как который которая которые которое был была было были если чтобы только очень нет можно нужно он она они его сейчас'.split(
    ' ',
  ),
);
const BULGARIAN_WORDS = new Set(
  'са във със това които който която което днес тук нещо защото също сме сте съм тези този тази трябва обаче тъй вече кога бъде е'.split(
    ' ',
  ),
);
const LANGUAGE_NAMES: Record<Language, string> = { ru: 'Russian', uk: 'Ukrainian', en: 'English', pl: 'Polish' };
export const languageName = (language: Language) => LANGUAGE_NAMES[language];

export function normalizeTranscript(text: string) {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokensOf = (text: string) => text.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];

/** Scores of a Latin-script passage per language (stop words ×2, characteristic letters ×1). */
export function latinScores(text: string): Record<string, number> {
  const lower = text.toLocaleLowerCase();
  const tokens = tokensOf(lower);
  const scores: Record<string, number> = {};
  for (const [code, profile] of Object.entries(LATIN_PROFILES))
    scores[code] =
      2 * tokens.filter((token) => profile.words.has(token)).length + (lower.match(profile.letters)?.length ?? 0);
  return scores;
}

/**
 * Rough Latin-script language guess. 'unknown' means no language has clear signals (for example a
 * list of technical terms or proper names); `confident` means the winner clearly beats the rest.
 */
export function latinGuess(text: string): { language: string; confident: boolean; score: number } {
  const ranked = Object.entries(latinScores(text)).sort((a, b) => b[1] - a[1]);
  const [best, score] = ranked[0];
  const second = ranked[1][1];
  if (score < 2 || score === second) return { language: 'unknown', confident: false, score };
  return { language: best, confident: score >= 4 && score >= 2 * second + 2, score };
}

/** Best-scoring language outside `allowed`, compared with the combined score of the allowed ones. */
function foreignLatin(text: string, allowed: string[]) {
  const scores = latinScores(text);
  const allowedScore = allowed.reduce((sum, code) => sum + scores[code], 0);
  const [language, score] = Object.entries(scores)
    .filter(([code]) => !allowed.includes(code))
    .sort((a, b) => b[1] - a[1])[0];
  return { language, score, allowedScore };
}

/** Ukrainian / Russian / Bulgarian marker scores of a Cyrillic passage. */
export function cyrillicScores(text: string) {
  const lower = text.toLocaleLowerCase();
  const tokens = tokensOf(lower);
  const count = (words: Set<string>) => tokens.filter((token) => words.has(token)).length;
  const letters = (pattern: RegExp) => lower.match(pattern)?.length ?? 0;
  return {
    uk: 2 * letters(/[іїєґ]/g) + 2 * count(UKRAINIAN_WORDS),
    // Russian ъ only separates (объём); as a vowel it is Bulgarian (във, със, път).
    ru: 2 * letters(/[ыэё]/g) + 2 * letters(/ъ(?=[еёюя])/g) + 2 * count(RUSSIAN_WORDS),
    bg: 2 * letters(/ъ(?![еёюя])/g) + 2 * count(BULGARIAN_WORDS),
  };
}

function detectedCodes(detected: unknown): string[] {
  if (!Array.isArray(detected)) return [];
  return detected
    .map((value) =>
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'code' in value
          ? String((value as { code: unknown }).code)
          : '',
    )
    .map((code) => code.toLowerCase().split(/[-_]/)[0])
    .filter(Boolean);
}

export function checkTranscript(
  text: string,
  language: Language,
  options: { detected?: unknown; voicedMs?: number } = {},
): TranscriptCheck {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return { status: 'silent', reason: 'no-letters' };
  const normalized = normalizeTranscript(text);
  const compact = normalized.replace(/\s/g, '');
  let rest = normalized;
  for (const pattern of SILENCE_HALLUCINATIONS) rest = rest.replace(pattern, ' ');
  const remaining = rest.replace(/\s/g, '').length;
  if (compact.length && (compact.length - remaining) / compact.length >= 0.8)
    return { status: 'silent', reason: 'hallucination' };

  const tokens = normalized.split(' ').filter(Boolean);
  for (let index = 0, run = 1; index < tokens.length; index++) {
    run = index && tokens[index] === tokens[index - 1] ? run + 1 : 1;
    if (run >= 8) return { status: 'reject', reason: 'repetition', detail: `"${tokens[index]}" repeated` };
  }
  if (options.voicedMs !== undefined && compact.length > 40) {
    const perSecond = compact.length / Math.max(1, options.voicedMs / 1000);
    if (perSecond > 40)
      return {
        status: 'reject',
        reason: 'repetition',
        detail: `${Math.round(perSecond)} characters per second of speech`,
      };
  }

  let latin = 0,
    cyrillic = 0,
    greek = 0,
    foreign = 0;
  for (const letter of letters) {
    if (/\p{Script=Latin}/u.test(letter)) latin++;
    else if (/\p{Script=Cyrillic}/u.test(letter)) cyrillic++;
    else if (/\p{Script=Greek}/u.test(letter)) greek++;
    else foreign++;
  }
  const total = letters.length;
  const percent = (count: number) => `${Math.round((count / total) * 100)}%`;
  if (foreign >= 2 && foreign / total > 0.05)
    return { status: 'reject', reason: 'foreign-script', detail: `${percent(foreign)} non-Latin/Cyrillic letters` };
  if (greek >= 2 && greek / total > 0.2)
    return { status: 'reject', reason: 'foreign-script', detail: `${percent(greek)} Greek letters` };
  if ((language === 'pl' || language === 'en') && cyrillic / total > 0.3)
    return { status: 'reject', reason: 'wrong-alphabet', detail: `${percent(cyrillic)} Cyrillic letters` };
  const latinWords = tokensOf(text).filter((token) => /\p{Script=Latin}/u.test(token)).length;
  if ((language === 'ru' || language === 'uk') && latin / total > 0.6) {
    // English terms and passages are allowed; any other identifiable language is not. A run of words
    // with no language signals at all (terms, names, Latin anatomy) is kept.
    const scores = latinScores(text);
    const other = foreignLatin(text, ['en']);
    if (other.language === 'pl' && other.score >= 2 && other.score > scores.en)
      return { status: 'reject', reason: 'wrong-language', detail: 'Polish text' };
    if (latinWords >= 6 && other.score >= 2 && other.score > scores.en)
      return { status: 'reject', reason: 'wrong-language', detail: `${LATIN_NAMES[other.language]} text` };
  }
  if ((language === 'pl' || language === 'en') && latin / total > 0.6) {
    const allowed = language === 'pl' ? ['pl', 'en'] : ['en'];
    const other = foreignLatin(text, allowed);
    // Short passages and technical terms stay safe: only a long passage that clearly reads as
    // another language is rejected.
    const clearly = other.score >= 4 && other.score >= 2 * other.allowedScore + 2;
    if (clearly && (latinWords >= 8 || (other.language === 'pl' && latinGuess(text).confident)))
      return { status: 'reject', reason: 'wrong-language', detail: `${LATIN_NAMES[other.language]} text` };
  }
  if ((language === 'uk' || language === 'ru') && cyrillic >= 20) {
    const lower = text.toLocaleLowerCase();
    const scores = cyrillicScores(text);
    const russianLetters = /[ыэъё]/.test(lower),
      ukrainianLetters = /[іїєґ]/.test(lower);
    if (language === 'uk' && !ukrainianLetters) {
      const foreign = Math.max(scores.ru, scores.bg);
      if (russianLetters || (foreign >= 4 && foreign > scores.uk))
        return {
          status: 'reject',
          reason: 'wrong-language',
          detail: scores.bg > scores.ru ? 'Bulgarian text' : 'Russian text',
        };
    }
    if (language === 'ru' && ukrainianLetters && !russianLetters)
      return { status: 'reject', reason: 'wrong-language', detail: 'Ukrainian text' };
    if (language === 'ru' && scores.bg >= 4 && scores.bg > scores.ru)
      return { status: 'reject', reason: 'wrong-language', detail: 'Bulgarian text' };
  }
  const codes = detectedCodes(options.detected);
  if (codes.length && !codes.some((code) => code === language || code === 'en'))
    return { status: 'reject', reason: 'detected-language', detail: `detected ${codes.join(', ')}` };
  return { status: 'ok' };
}
