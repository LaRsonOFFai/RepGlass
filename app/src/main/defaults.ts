import type {
  AnswerDetail,
  AppSettings,
  InterviewProfile,
  ReasoningEffort,
  ScreenContextMode,
  TranscriptionDelay,
} from './types';

export const SETTINGS_SCHEMA_VERSION = 3;

export const DEFAULT_SETTINGS: AppSettings = {
  answerProvider: 'codex',
  model: 'gpt-6-luna',
  codexModel: 'gpt-6-sol',
  transcriptionModel: 'gpt-live-transcribe',
  transcriptionDelay: 'low',
  language: 'ru',
  captureSource: 'both',
  autoAnswer: true,
  answerCooldownMs: 4_500,
  chunkMs: 100,
  startInTray: true,
  hideTrayWhileListening: true,
  captureProtection: true,
  screenContext: 'smart',
  profile: 'developer',
  answerDetail: 'balanced',
  reasoningEffort: 'low',
  customInstructions: '',
};

export const PROFILE_LABELS: Record<InterviewProfile, string> = {
  developer: 'Разработчик',
  aqa: 'AQA / Автоматизация',
  'manual-qa': 'Ручной QA',
  'load-qa': 'Нагрузочный QA',
  general: 'Общий помощник',
  custom: 'Свой профиль',
};

const PROFILE_PROMPTS: Record<InterviewProfile, string> = {
  developer:
    'Помогай с собеседованиями разработчика: сначала дай прямой ответ, затем подход, сложность, крайние случаи и короткий пример кода, если он нужен.',
  aqa:
    'Помогай как senior AQA: учитывай архитектуру автотестов, тестовую пирамиду, API/UI, CI/CD, стабильность, паттерны, код и практические компромиссы.',
  'manual-qa':
    'Помогай как senior manual QA: структурируй ответ через риски, техники тест-дизайна, позитивные и негативные проверки, приоритеты и оформление дефектов.',
  'load-qa':
    'Помогай как senior performance engineer: уточняй модель нагрузки, SLA/SLO, метрики, профиль теста, узкие места, наблюдаемость и интерпретацию результатов.',
  general: 'Отвечай как сильный универсальный ассистент для рабочих встреч и технических обсуждений.',
  custom: 'Следуй пользовательским инструкциям ниже, сохраняя точность и практичность ответа.',
};

const DETAIL_PROMPTS: Record<AnswerDetail, string> = {
  brief: 'Ответ должен быть очень кратким: 2-5 предложений или короткий список.',
  balanced: 'Дай компактный, но достаточный ответ, который удобно сразу произнести вслух.',
  detailed: 'Дай развёрнутый структурированный ответ с аргументами и примерами.',
};

export function buildAssistantInstructions(settings: AppSettings): string {
  const custom = settings.customInstructions.trim();
  return [
    'Ты RepGlass, приватный помощник для живого разговора.',
    'Отвечай на последний вопрос, не повторяй его без необходимости.',
    'Используй русский язык, если собеседник явно не перешёл на другой язык.',
    PROFILE_PROMPTS[settings.profile],
    DETAIL_PROMPTS[settings.answerDetail],
    custom ? `Персональные инструкции пользователя:\n${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const transcriptionDelays: TranscriptionDelay[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const profiles: InterviewProfile[] = ['developer', 'aqa', 'manual-qa', 'load-qa', 'general', 'custom'];
const answerDetails: AnswerDetail[] = ['brief', 'balanced', 'detailed'];
const reasoningEfforts: ReasoningEffort[] = ['low', 'medium', 'high'];
const screenModes: ScreenContextMode[] = ['off', 'smart', 'always'];
const captureSources: AppSettings['captureSource'][] = ['both', 'system', 'microphone'];

export function migrateSettings(
  candidate?: Partial<AppSettings>,
  schemaVersion = SETTINGS_SCHEMA_VERSION,
): Partial<AppSettings> {
  const migrated = { ...(candidate || {}) };
  if (schemaVersion < 2 && migrated.captureSource === 'system') migrated.captureSource = 'both';
  if (schemaVersion < 3 && migrated.model === 'gpt-5.4-mini') migrated.model = 'gpt-6-luna';
  if (schemaVersion < 3 && migrated.codexModel === 'gpt-5.4-mini') migrated.codexModel = 'gpt-6-sol';
  return migrated;
}

export function normalizeSettings(candidate?: Partial<AppSettings>): AppSettings {
  const next = { ...DEFAULT_SETTINGS, ...(candidate || {}) };
  return {
    ...next,
    answerProvider: next.answerProvider === 'openai-api' ? 'openai-api' : 'codex',
    model: stringValue(next.model, DEFAULT_SETTINGS.model),
    codexModel: stringValue(next.codexModel, DEFAULT_SETTINGS.codexModel),
    transcriptionModel: 'gpt-live-transcribe',
    transcriptionDelay: includes(transcriptionDelays, next.transcriptionDelay, DEFAULT_SETTINGS.transcriptionDelay),
    language: stringValue(next.language, DEFAULT_SETTINGS.language).slice(0, 12),
    captureSource: includes(captureSources, next.captureSource, DEFAULT_SETTINGS.captureSource),
    autoAnswer: Boolean(next.autoAnswer),
    answerCooldownMs: clampNumber(next.answerCooldownMs, 2_000, 60_000, DEFAULT_SETTINGS.answerCooldownMs),
    chunkMs: clampNumber(next.chunkMs, 40, 500, DEFAULT_SETTINGS.chunkMs),
    startInTray: Boolean(next.startInTray),
    hideTrayWhileListening: Boolean(next.hideTrayWhileListening),
    captureProtection: next.captureProtection !== false,
    screenContext: includes(screenModes, next.screenContext, DEFAULT_SETTINGS.screenContext),
    profile: includes(profiles, next.profile, DEFAULT_SETTINGS.profile),
    answerDetail: includes(answerDetails, next.answerDetail, DEFAULT_SETTINGS.answerDetail),
    reasoningEffort: includes(reasoningEfforts, next.reasoningEffort, DEFAULT_SETTINGS.reasoningEffort),
    customInstructions: typeof next.customInstructions === 'string' ? next.customInstructions.slice(0, 8_000) : '',
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function includes<T extends string>(values: T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : fallback;
}
