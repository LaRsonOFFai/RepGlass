const QUESTION_HINTS = [
  /\?/,
  /\b(what|why|how|when|where|which|who|can you|could you|should we|do we|are we|is it)\b/i,
  /\b(что|почему|зачем|как|когда|где|какой|какая|какие|кто|можешь|можно|надо ли|стоит ли)\b/i,
  /\b(explain|summarize|answer|solve|compare|define|расскажи|объясни|ответь|реши|сравни|определи)\b/i,
];

const MIN_TEXT_LENGTH = 12;

export function shouldAutoAnswer(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < MIN_TEXT_LENGTH) return false;
  return QUESTION_HINTS.some((pattern) => pattern.test(normalized));
}

export function signatureFor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
