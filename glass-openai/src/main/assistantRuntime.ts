import type { WebContents } from 'electron';
import { CodexService } from './codexService';
import { OpenAIService } from './openaiService';
import { shouldAutoAnswer, signatureFor } from './questionDetector';
import { RealtimeTranscriptionService } from './realtimeTranscriptionService';
import type { AnswerPayload, AppSettings, AudioChunkPayload, TranscriptTurn } from './types';

type RuntimeDeps = {
  getApiKey: () => string | null;
  getSettings: () => AppSettings;
  webContents: () => WebContents | null;
};

export class AssistantRuntime {
  private readonly openai = new OpenAIService();
  private readonly codex = new CodexService();
  private readonly realtime = new RealtimeTranscriptionService();
  private readonly transcript: TranscriptTurn[] = [];
  private listening = false;
  private processingAnswer = false;
  private lastSignature = '';
  private lastAnswerAt = 0;

  constructor(private readonly deps: RuntimeDeps) {}

  async start(): Promise<void> {
    if (this.listening) return;

    const apiKey = this.deps.getApiKey();
    if (!apiKey) throw new Error('OpenAI API key required for realtime transcription');

    const settings = this.deps.getSettings();
    this.emit('status', 'Connecting realtime transcription');
    await this.realtime.start({
      apiKey,
      language: settings.language,
      callbacks: {
        onPartial: (itemId, text) => this.emitTranscript(itemId, text, true),
        onFinal: (itemId, text) => void this.handleFinalTranscript(itemId, text),
        onError: (message) => this.emit('error', message),
        onClose: () => {
          if (!this.listening) return;
          this.listening = false;
          this.emit('listen:state', { listening: false });
          this.emit('status', 'Realtime transcription disconnected');
        },
      },
    });

    this.listening = true;
    this.emit('listen:state', { listening: true });
    this.emit('status', 'Listening live');
  }

  stop(): void {
    this.listening = false;
    this.realtime.stop(true);
    this.emit('listen:state', { listening: false });
    this.emit('status', 'Paused');
  }

  isListening(): boolean {
    return this.listening;
  }

  handleAudioChunk(payload: AudioChunkPayload): void {
    if (!this.listening) return;
    this.realtime.appendAudio(payload);
  }

  commitAudio(): void {
    if (!this.listening) return;
    this.realtime.commit();
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

  private emitTranscript(id: string, text: string, partial: boolean): void {
    if (!text) return;
    this.emit('listen:transcript', {
      id,
      speaker: 'audio',
      text,
      createdAt: Date.now(),
      partial,
    } satisfies TranscriptTurn);
  }

  private async handleFinalTranscript(id: string, text: string): Promise<void> {
    const turn: TranscriptTurn = {
      id,
      speaker: 'audio',
      text,
      createdAt: Date.now(),
      partial: false,
    };
    this.transcript.push(turn);
    this.emit('listen:transcript', turn);
    this.emit('status', this.listening ? 'Listening live' : 'Paused');

    if (this.deps.getSettings().autoAnswer) {
      await this.maybeAnswer(text);
    }
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
