import type { WebContents } from 'electron';
import { CodexService } from './codexService';
import { OpenAIService } from './openaiService';
import { shouldAutoAnswer, signatureFor } from './questionDetector';
import type { AnswerPayload, AppSettings, AudioChunkPayload, TranscriptTurn } from './types';

type RuntimeDeps = {
  getApiKey: () => string | null;
  getSettings: () => AppSettings;
  webContents: () => WebContents | null;
};

export class AssistantRuntime {
  private readonly openai = new OpenAIService();
  private readonly codex = new CodexService();
  private readonly transcript: TranscriptTurn[] = [];
  private listening = false;
  private processingAudio = false;
  private processingAnswer = false;
  private lastSignature = '';
  private lastAnswerAt = 0;

  constructor(private readonly deps: RuntimeDeps) {}

  start(): void {
    this.listening = true;
    this.emit('listen:state', { listening: true });
    this.emit('status', 'Listening');
  }

  stop(): void {
    this.listening = false;
    this.emit('listen:state', { listening: false });
    this.emit('status', 'Paused');
  }

  isListening(): boolean {
    return this.listening;
  }

  async handleAudioChunk(payload: AudioChunkPayload): Promise<void> {
    if (!this.listening || this.processingAudio) return;

    const apiKey = this.deps.getApiKey();
    if (!apiKey) {
      this.emit('status', 'OpenAI STT key required');
      return;
    }

    this.processingAudio = true;
    try {
      this.emit('status', 'Transcribing');
      const settings = this.deps.getSettings();
      const text = await this.openai.transcribeAudio({
        apiKey,
        audio: Buffer.from(payload.base64, 'base64'),
        mimeType: payload.mimeType,
        settings,
      });

      if (!text) return;

      const turn: TranscriptTurn = {
        id: crypto.randomUUID(),
        speaker: 'audio',
        text,
        createdAt: Date.now(),
      };
      this.transcript.push(turn);
      this.emit('listen:transcript', turn);
      this.emit('status', 'Listening');

      if (settings.autoAnswer) {
        await this.maybeAnswer(text);
      }
    } catch (error) {
      console.error('[AssistantRuntime] Audio processing failed:', error);
      this.emit('error', error instanceof Error ? error.message : 'Audio processing failed');
      this.emit('status', 'Listening');
    } finally {
      this.processingAudio = false;
    }
  }

  async ask(question: string): Promise<AnswerPayload> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error('Question is empty');

    return await this.answer(trimmed);
  }

  private async maybeAnswer(text: string): Promise<void> {
    const settings = this.deps.getSettings();
    const signature = signatureFor(text);
    const now = Date.now();

    if (!shouldAutoAnswer(text)) return;
    if (this.processingAnswer) return;
    if (signature && signature === this.lastSignature) return;
    if (now - this.lastAnswerAt < settings.answerCooldownMs) return;

    await this.answer(text);
  }

  private async answer(question: string): Promise<AnswerPayload> {
    this.processingAnswer = true;
    this.emit('ask:state', { loading: true });
    try {
      this.emit('status', 'Thinking');
      const settings = this.deps.getSettings();
      const conversation = this.transcript.map((turn) => turn.text);
      const answer =
        settings.answerProvider === 'codex'
          ? await this.codex.answerQuestion({ question, conversation, settings })
          : await this.answerWithOpenAI(question, conversation, settings);

      const payload: AnswerPayload = {
        question,
        answer,
        createdAt: Date.now(),
      };
      this.lastSignature = signatureFor(question);
      this.lastAnswerAt = Date.now();
      this.emit('ask:answer', payload);
      this.emit('status', this.listening ? 'Listening' : 'Ready');
      return payload;
    } finally {
      this.processingAnswer = false;
      this.emit('ask:state', { loading: false });
    }
  }

  private async answerWithOpenAI(question: string, conversation: string[], settings: AppSettings): Promise<string> {
    const apiKey = this.deps.getApiKey();
    if (!apiKey) throw new Error('OpenAI API key required');

    return await this.openai.answerQuestion({
      apiKey,
      question,
      conversation,
      settings,
    });
  }

  private emit(channel: string, payload: unknown): void {
    const contents = this.deps.webContents();
    if (!contents || contents.isDestroyed()) return;
    contents.send(channel, payload);
  }
}
