import type { AnswerCategory } from './types';

const QUESTION_HINTS = [
  /\?/u,
  /\b(what|why|how|when|where|which|who|can you|could you|would you|should we|do we|are we|is it)\b/iu,
  /(?:^|[^\p{L}\p{N}])(что|почему|зачем|как|когда|где|куда|откуда|какой|какая|какие|кто|сколько|можешь|можно|нужно ли|надо ли|стоит ли)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}\p{N}])(explain|describe|summarize|answer|solve|compare|define|implement|write|расскажи|опиши|объясни|ответь|реши|сравни|определи|реализуй|напиши)(?=$|[^\p{L}\p{N}])/iu,
];

const SCREEN_HINT =
  /(?:^|[^\p{L}\p{N}])(на экране|на скриншоте|видишь|задач[ауеи]|услови[ея]|код|ошибк[ауеи]|интерфейс|screen|screenshot|task|code|error|stack trace)(?=$|[^\p{L}\p{N}])/iu;

const MIN_TEXT_LENGTH = 7;

export function shouldAutoAnswer(text: string): boolean {
  const normalized = text.trim();
  return normalized.length >= MIN_TEXT_LENGTH && QUESTION_HINTS.some((pattern) => pattern.test(normalized));
}

export function shouldAttachScreen(text: string): boolean {
  return SCREEN_HINT.test(text.trim());
}

export function classifyQuestion(text: string, usedScreen = false): AnswerCategory {
  if (usedScreen) return 'screen';
  if (/(?:^|[^\p{L}\p{N}])(код\p{L}*|функци\p{L}*|алгоритм\p{L}*|typescript|javascript|python|java|c#|sql|api|code|algorithm)(?=$|[^\p{L}\p{N}])/iu.test(text)) {
    return 'code';
  }
  if (/(?:^|[^\p{L}\p{N}])(тест\p{L}*|баг\p{L}*|дефект\p{L}*|qa|quality|selenium|playwright|jmeter|нагруз\p{L}*)(?=$|[^\p{L}\p{N}])/iu.test(text)) return 'testing';
  if (/(?:^|[^\p{L}\p{N}])(архитектур\p{L}*|системн\p{L}*|масштаб\p{L}*|очеред\p{L}*|баз[аыу]|кэш\p{L}*|architecture|system design|database|cache)(?=$|[^\p{L}\p{N}])/iu.test(text)) {
    return 'system-design';
  }
  return 'general';
}

export function signatureFor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
