export type CaptureSource = 'microphone' | 'system';
export type AnswerProvider = 'codex' | 'openai-api';

export type AppSettings = {
  answerProvider: AnswerProvider;
  model: string;
  codexModel: string;
  transcriptionModel: string;
  language: string;
  captureSource: CaptureSource;
  autoAnswer: boolean;
  answerCooldownMs: number;
  chunkMs: number;
  startInTray: boolean;
};

export type AuthState = {
  mode: 'none' | 'openai-api-key' | 'codex-chatgpt';
  hasApiKey: boolean;
  hasCodexAuth: boolean;
  maskedKey?: string;
  codexStatus?: string;
  codexVersion?: string;
  codexError?: string;
};

export type AudioChunkPayload = {
  base64: string;
  sampleRate: number;
};

export type TranscriptTurn = {
  id: string;
  speaker: 'audio';
  text: string;
  createdAt: number;
  partial?: boolean;
};

export type AnswerPayload = {
  question: string;
  answer: string;
  createdAt: number;
};
