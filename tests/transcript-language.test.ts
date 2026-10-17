import { describe, expect, it } from 'vitest';
import { checkTranscript, cyrillicScores, latinGuess } from '../src/main/transcript-language';
import type { Language } from '../src/shared/types';

const SAMPLES = {
  ru: 'Сегодня мы рассмотрим уравнение теплопроводности и его решение методом разделения переменных.',
  uk: 'Сьогодні ми розглянемо рівняння теплопровідності та його розв’язання методом відокремлення змінних.',
  pl: 'Dzisiaj omówimy równanie przewodnictwa cieplnego i jego rozwiązanie metodą rozdzielenia zmiennych, które jest ważne.',
  en: 'Today we will look at the heat equation and its solution by separation of variables, which is the classic method.',
  zh: '今天我们讨论热传导方程以及用分离变量法求解。',
  ja: '今日は熱伝導方程式について説明します。',
  ko: '오늘은 열전도 방정식에 대해 이야기하겠습니다.',
  ar: 'اليوم سنناقش معادلة الحرارة وحلها بطريقة فصل المتغيرات.',
};
const status = (text: string, language: Language) => checkTranscript(text, language).status;

describe('transcript language enforcement', () => {
  it('accepts the lecture language and English, rejects other scripts for every lecture language', () => {
    const matrix: Record<Language, Record<keyof typeof SAMPLES, 'ok' | 'reject'>> = {
      ru: { ru: 'ok', uk: 'reject', pl: 'reject', en: 'ok', zh: 'reject', ja: 'reject', ko: 'reject', ar: 'reject' },
      uk: { ru: 'reject', uk: 'ok', pl: 'reject', en: 'ok', zh: 'reject', ja: 'reject', ko: 'reject', ar: 'reject' },
      pl: { ru: 'reject', uk: 'reject', pl: 'ok', en: 'ok', zh: 'reject', ja: 'reject', ko: 'reject', ar: 'reject' },
      en: { ru: 'reject', uk: 'reject', pl: 'reject', en: 'ok', zh: 'reject', ja: 'reject', ko: 'reject', ar: 'reject' },
    };
    for (const [language, row] of Object.entries(matrix) as [Language, Record<string, string>][])
      for (const [sample, expected] of Object.entries(row))
        expect([language, sample, status(SAMPLES[sample as keyof typeof SAMPLES], language)]).toEqual([
          language,
          sample,
          expected,
        ]);
  });
  it('allows English terms and a little Greek mathematics inside the lecture language', () => {
    expect(status('Это так называемый gradient descent, или градиентный спуск, для функции потерь.', 'ru')).toBe('ok');
    expect(status('Weźmy kąt α oraz β i policzmy sumę Σ dla wszystkich elementów zbioru.', 'pl')).toBe('ok');
    expect(checkTranscript('αβγδεζηθ λμνξ', 'pl')).toMatchObject({ status: 'reject', reason: 'foreign-script' });
    // A few CJK letters inside a long Russian sentence stay below the 5% share.
    expect(status(`${SAMPLES.ru} ${SAMPLES.ru} 熱`, 'ru')).toBe('ok');
    expect(checkTranscript(`${SAMPLES.ru} 今天我们讨论`, 'ru')).toMatchObject({ status: 'reject', reason: 'foreign-script' });
  });
  it('treats empty output and known subtitle hallucinations as silence (no retry)', () => {
    for (const text of [
      '',
      '...',
      '♪ ♪',
      '12 34',
      'Продолжение следует...',
      'Субтитры сделал DimaTorzok',
      'Редактор субтитров А.Синецкая Корректор А.Егорова',
      'Дякую за перегляд!',
      'Thanks for watching!',
      'Napisy stworzone przez społeczność Amara.org',
      '字幕由Amara.org社区提供',
      '請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目',
      'MBC 뉴스 이덕영입니다.',
    ])
      expect([text, checkTranscript(text, 'ru').status]).toEqual([text, 'silent']);
    // A real closing phrase is speech, not a hallucination.
    expect(status('Dziękuję za uwagę.', 'pl')).toBe('ok');
    // A hallucinated credit inside real speech does not discard the speech.
    expect(status(`${SAMPLES.ru} Продолжение следует.`, 'ru')).toBe('ok');
  });
  it('rejects runaway repetition and implausibly dense text', () => {
    expect(checkTranscript('да да да да да да да да', 'ru')).toMatchObject({ status: 'reject', reason: 'repetition' });
    expect(status('да да да да да да да', 'ru')).toBe('ok');
    expect(checkTranscript(SAMPLES.en, 'en', { voicedMs: 1000 })).toMatchObject({ reason: 'repetition' });
    expect(status(SAMPLES.en, 'en')).toBe('ok');
    expect(checkTranscript(SAMPLES.en, 'en', { voicedMs: 8000 }).status).toBe('ok');
  });
  it('uses detected languages when the model reports them', () => {
    expect(checkTranscript(SAMPLES.pl, 'pl', { detected: [{ code: 'pl' }] }).status).toBe('ok');
    expect(checkTranscript(SAMPLES.en, 'pl', { detected: ['en'] }).status).toBe('ok');
    expect(checkTranscript('Hola a todos, hoy vamos a hablar.', 'pl', { detected: [{ code: 'es' }] })).toMatchObject({
      status: 'reject',
      reason: 'detected-language',
    });
    expect(checkTranscript(SAMPLES.pl, 'pl', { detected: [] }).status).toBe('ok');
  });
  it('drops subtitle credits in German, Spanish, French, Italian and Portuguese as silence', () => {
    const credits: [string, Language][] = [
      ['Untertitel im Auftrag des ZDF für funk, 2017', 'ru'],
      ['Untertitel im Auftrag des ZDF für funk, 2017', 'pl'],
      ['Untertitelung des ZDF, 2020', 'uk'],
      ['Untertitel der Amara.org-Community', 'en'],
      ['Subtítulos realizados por la comunidad de Amara.org', 'ru'],
      ['Sous-titres réalisés par la communauté d’Amara.org', 'pl'],
      ["Sous-titres réalisés par la communauté d'Amara.org", 'en'],
      ['Sottotitoli creati dalla comunità Amara.org', 'uk'],
      ['Legendas pela comunidade Amara.org', 'pl'],
    ];
    for (const [text, language] of credits)
      expect([text, language, checkTranscript(text, language)]).toEqual([
        text,
        language,
        { status: 'silent', reason: 'hallucination' },
      ]);
  });
  it('rejects other Latin-script languages in every lecture language', () => {
    const SPANISH =
      'Hola a todos, hoy vamos a hablar de la ecuación del calor y su solución por separación de variables.';
    const GERMAN = 'Heute sprechen wir über die Wärmeleitungsgleichung und ihre Lösung durch Trennung der Variablen.';
    const CZECH = 'Dnes budeme mluvit o rovnici vedení tepla, která je velmi důležitá pro fyziku.';
    const FRENCH = "Aujourd'hui nous allons parler de l'équation de la chaleur et de sa solution.";
    const ITALIAN = "Oggi parliamo dell'equazione del calore e della sua soluzione con il metodo.";
    const PORTUGUESE = 'Hoje vamos falar sobre a equação do calor e a sua solução pela separação de variáveis.';
    const cases: [string, Language, string][] = [
      [SPANISH, 'ru', 'Spanish text'],
      [SPANISH, 'uk', 'Spanish text'],
      [SPANISH, 'pl', 'Spanish text'],
      [GERMAN, 'pl', 'German text'],
      [GERMAN, 'en', 'German text'],
      [GERMAN, 'ru', 'German text'],
      [CZECH, 'pl', 'Czech text'],
      [FRENCH, 'en', 'French text'],
      [ITALIAN, 'pl', 'Italian text'],
      [PORTUGUESE, 'en', 'Portuguese text'],
    ];
    for (const [text, language, detail] of cases)
      expect([language, checkTranscript(text, language)]).toEqual([
        language,
        { status: 'reject', reason: 'wrong-language', detail },
      ]);
  });
  it('rejects Bulgarian and Russian passages in Ukrainian lectures and Bulgarian in Russian ones', () => {
    const BULGARIAN =
      'Днес ще говорим за уравнението на топлопроводността и неговото решение, което е много важно за физиката.';
    expect(checkTranscript(BULGARIAN, 'uk')).toEqual({
      status: 'reject',
      reason: 'wrong-language',
      detail: 'Bulgarian text',
    });
    expect(checkTranscript(BULGARIAN, 'ru')).toMatchObject({ status: 'reject', detail: 'Bulgarian text' });
    expect(checkTranscript('Във физиката това е важно, защото със тези уравнения работим всеки ден.', 'uk')).toMatchObject(
      { status: 'reject', detail: 'Bulgarian text' },
    );
    // Russian without ы/э/ё still has Russian-only words.
    expect(checkTranscript('Как видно на графике, скорость растет, потому что сила постоянна.', 'uk')).toEqual({
      status: 'reject',
      reason: 'wrong-language',
      detail: 'Russian text',
    });
    expect(cyrillicScores('Объём газа растёт').bg).toBe(0); // Russian separator ъ is not Bulgarian.
  });
  it('keeps genuine lecture speech with English terms, names and Latin terminology', () => {
    const genuine: [string, Language][] = [
      [
        'Teraz używamy algorytmu gradient descent oraz backpropagation, żeby zoptymalizować funkcję straty w naszym modelu.',
        'pl',
      ],
      ['Mamy tu deep learning pipeline z feature extraction oraz attention layers.', 'pl'],
      ['Rozważmy parę liczb, czyli para punktów na płaszczyźnie, i policzmy odległość.', 'pl'],
      ['As shown by Smith et al. in their paper, the method converges quickly for convex functions.', 'en'],
      ['The Schrödinger equation describes how the quantum state of a system changes over time.', 'en'],
      ['We will now look at the gradient descent algorithm and its convergence.', 'ru'],
      ['Musculus biceps brachii, musculus triceps brachii, musculus deltoideus.', 'ru'],
      ['Musculus biceps brachii, musculus triceps brachii, musculus deltoideus.', 'uk'],
      ['Отже, ця формула дуже проста, правда?', 'uk'],
      ['Добре, тепер подивимося на графік цієї функції.', 'uk'],
      ['Объём газа увеличивается, если температура растёт.', 'ru'],
      ['Это так называемый gradient descent, или градиентный спуск, для функции потерь.', 'ru'],
      ['Hola, Fourier!', 'ru'],
    ];
    for (const [text, language] of genuine)
      expect([text, language, checkTranscript(text, language).status]).toEqual([text, language, 'ok']);
  });
  it('guesses Polish versus English for Latin text', () => {
    expect(latinGuess(SAMPLES.pl)).toMatchObject({ language: 'pl', confident: true });
    expect(latinGuess(SAMPLES.en)).toMatchObject({ language: 'en' });
    expect(latinGuess('Fourier transform')).toMatchObject({ language: 'unknown' });
  });
});
