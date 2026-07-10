export type CaptureSource = 'both' | 'microphone' | 'system';
export type AnswerProvider = 'codex' | 'openai-api';
export type InterviewProfile = 'developer' | 'aqa' | 'manual-qa' | 'load-qa' | 'general' | 'custom';
export type AnswerDetail = 'brief' | 'balanced' | 'detailed';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ScreenContextMode = 'off' | 'smart' | 'always';
export type TranscriptionDelay = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type AnswerCategory = 'code' | 'testing' | 'system-design' | 'screen' | 'general';

export type AppSettings = {
  answerProvider: AnswerProvider;
  model: string;
  codexModel: string;
  transcriptionModel: string;
  transcriptionDelay: TranscriptionDelay;
  language: string;
  captureSource: CaptureSource;
  autoAnswer: boolean;
  answerCooldownMs: number;
  chunkMs: number;
  startInTray: boolean;
  hideTrayWhileListening: boolean;
  captureProtection: boolean;
  screenContext: ScreenContextMode;
  profile: InterviewProfile;
  answerDetail: AnswerDetail;
  reasoningEffort: ReasoningEffort;
  customInstructions: string;
};

export type AuthState = {
  mode: 'none' | 'openai-api-key' | 'codex-chatgpt';
  hasApiKey: boolean;
  hasCodexAuth: boolean;
  maskedKey?: string;
  codexStatus?: string;
  codexVersion?: string;
  codexEmail?: string;
  codexPlan?: string;
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
  id: string;
  question: string;
  answer: string;
  createdAt: number;
  category: AnswerCategory;
  usedScreen: boolean;
};

export type AnswerDeltaPayload = Omit<AnswerPayload, 'answer' | 'createdAt'> & {
  answer: string;
};

export type AskRequest = {
  question: string;
  includeScreen?: boolean;
};

export type ScreenCapturePayload = {
  dataUrl: string;
  displayName: string;
};
