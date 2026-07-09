import type { AppSettings } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  answerProvider: 'codex',
  model: 'gpt-4.1-mini',
  codexModel: 'gpt-5.5',
  transcriptionModel: 'gpt-realtime-whisper',
  language: 'ru',
  captureSource: 'microphone',
  autoAnswer: true,
  answerCooldownMs: 12000,
  chunkMs: 100,
  startInTray: false,
};

export const SYSTEM_PROMPT = [
  'You are RepGlass, a discreet meeting and screen assistant.',
  'Answer the latest spoken question directly and helpfully.',
  'Keep answers concise by default, but include steps when the question is technical, mathematical, or procedural.',
  'If the transcript is ambiguous, state the best likely interpretation first.',
].join('\n');
