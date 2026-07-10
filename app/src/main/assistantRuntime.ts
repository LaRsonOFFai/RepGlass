import type { WebContents } from 'electron';
import crypto from 'node:crypto';
import { CodexService } from './codexService';
import { OpenAIService } from './openaiService';
import { classifyQuestion, shouldAttachScreen, shouldAutoAnswer, signatureFor } from './questionDetector';
import { RealtimeTranscriptionService } from './realtimeTranscriptionService';
import type { CapturedScreen } from './screenCaptureService';
import type { AnswerPayload, AppSettings, AskRequest, AudioChunkPayload, TranscriptTurn } from './types';

type RuntimeDeps = {
  codex: CodexService;
  getApiKey: () => string | null;
  getSettings: () => AppSettings;
  webContents: () => WebContents | null;
  captureScreen: () => Promise<CapturedScreen>;
};

export class AssistantRuntime {
  private readonly openai = new OpenAIService();
  private readonly codex: CodexService;
  private readonly realtime = new RealtimeTranscriptionService();
  private readonly transcript: TranscriptTurn[] = [];
  private listening = false;
  private processingAnswer = false;
  private lastSignature = '';
  private lastAnswerAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private queuedQuestion = '';
  private queuedTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RuntimeDeps) {
    this.codex = deps.codex;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    if (!this.deps.getApiKey()) throw new Error('Для realtime-транскрипции нужен OpenAI API key');

    this.listening = true;
    this.reconnectAttempt = 0;
    this.emit('listen:state', { listening: true });
    try {
      await this.connectRealtime();
    } catch (error) {
      this.listening = false;
      this.emit('listen:state', { listening: false });
      throw error;
    }
  }

  stop(): void {
    this.listening = false;
    this.clearReconnectTimer();
    this.realtime.stop(true);
    this.emit('listen:state', { listening: false });
    this.emit('status', 'Прослушивание остановлено');
  }

  isListening(): boolean {
    return this.listening;
  }

  handleAudioChunk(payload: AudioChunkPayload): void {
    if (this.listening) this.realtime.appendAudio(payload);
  }

  commitAudio(): void {
    if (this.listening) this.realtime.commit();
  }

  async ask(request: AskRequest | string): Promise<AnswerPayload> {
    const normalized = typeof request === 'string' ? { question: request } : request;
    const question = normalized.question.trim();
    if (!question) throw new Error('Введите вопрос');
    return await this.answer(question, normalized.includeScreen);
  }

  async askLatest(includeScreen = false): Promise<AnswerPayload> {
    const question = this.transcript
      .slice(-3)
      .map((turn) => turn.text)
      .join(' ')
      .trim();
    if (!question) throw new Error('В транскрипции пока нет вопроса');
    return await this.answer(question, includeScreen);
  }

  clearSession(): void {
    this.transcript.length = 0;
    this.lastSignature = '';
    this.lastAnswerAt = 0;
    this.queuedQuestion = '';
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    this.queuedTimer = null;
    this.emit('session:cleared', {});
    this.emit('status', this.listening ? 'Слушаю' : 'Готово');
  }

  private async connectRealtime(): Promise<void> {
    const apiKey = this.deps.getApiKey();
    if (!apiKey || !this.listening) return;
    const settings = this.deps.getSettings();
    this.emit('status', this.reconnectAttempt ? 'Переподключаю транскрипцию' : 'Подключаю транскрипцию');

    await this.realtime.start({
      apiKey,
      language: settings.language,
      delay: settings.transcriptionDelay,
      callbacks: {
        onPartial: (itemId, text) => this.emitTranscript(itemId, text, true),
        onFinal: (itemId, text) => void this.handleFinalTranscript(itemId, text),
        onError: (message) => this.emit('error', message),
        onClose: () => this.scheduleReconnect(),
      },
    });

    this.reconnectAttempt = 0;
    this.emit('status', 'Слушаю в реальном времени');
  }

  private scheduleReconnect(): void {
    if (!this.listening || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(10_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 3));
    this.emit('status', `Связь потеряна, повтор через ${Math.ceil(delay / 1_000)} с`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectRealtime().catch((error) => {
        this.emit('error', error instanceof Error ? error.message : 'Не удалось переподключить транскрипцию');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async maybeAnswer(text: string): Promise<void> {
    const recent = this.transcript
      .slice(-3)
      .map((turn) => turn.text)
      .join(' ');
    const question = [text, recent].find((candidate) => shouldAutoAnswer(candidate));
    if (!question) return;

    const signature = signatureFor(question);
    if (signature && signature === this.lastSignature) return;
    if (this.processingAnswer) {
      this.queuedQuestion = question;
      return;
    }

    const cooldown = this.deps.getSettings().answerCooldownMs;
    const wait = cooldown - (Date.now() - this.lastAnswerAt);
    if (wait > 0) {
      this.queuedQuestion = question;
      this.scheduleQueuedAnswer(wait);
      return;
    }

    await this.answer(question);
  }

  private scheduleQueuedAnswer(delay = 350): void {
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    this.queuedTimer = setTimeout(() => {
      this.queuedTimer = null;
      const question = this.queuedQuestion;
      this.queuedQuestion = '';
      if (!question || !this.listening) return;
      void this.maybeAnswer(question).catch((error) => this.reportAnswerError(error));
    }, Math.max(250, delay));
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
    if (this.transcript.length > 100) this.transcript.splice(0, this.transcript.length - 100);
    this.emit('listen:transcript', turn);
    this.emit('status', this.listening ? 'Слушаю в реальном времени' : 'Готово');

    if (this.deps.getSettings().autoAnswer) {
      try {
        await this.maybeAnswer(text);
      } catch (error) {
        this.reportAnswerError(error);
      }
    }
  }

  private async answer(question: string, forceScreen?: boolean): Promise<AnswerPayload> {
    this.processingAnswer = true;
    this.emit('ask:state', { loading: true });
    const settings = this.deps.getSettings();
    const wantsScreen =
      forceScreen === true ||
      (forceScreen !== false &&
        (settings.screenContext === 'always' || (settings.screenContext === 'smart' && shouldAttachScreen(question))));
    let capture: CapturedScreen | null = null;

    try {
      this.emit('status', wantsScreen ? 'Смотрю на экран' : 'Готовлю ответ');
      if (wantsScreen) {
        try {
          capture = await this.deps.captureScreen();
          this.emit('screen:preview', { dataUrl: capture.dataUrl, displayName: capture.displayName });
        } catch (error) {
          if (forceScreen) throw error;
          this.emit('error', error instanceof Error ? error.message : 'Не удалось добавить экран');
        }
      }

      const id = crypto.randomUUID();
      const category = classifyQuestion(question, Boolean(capture));
      const conversation = this.transcript.map((turn) => turn.text);
      const answer =
        settings.answerProvider === 'codex'
          ? await this.codex.answerQuestion({
              question,
              conversation,
              settings,
              imagePath: capture?.path,
              onDelta: (text) =>
                this.emit('ask:delta', { id, question, answer: text, category, usedScreen: Boolean(capture) }),
            })
          : await this.openai.answerQuestion({
              apiKey: this.requireApiKey(),
              question,
              conversation,
              settings,
              imagePath: capture?.path,
              onDelta: (text) =>
                this.emit('ask:delta', { id, question, answer: text, category, usedScreen: Boolean(capture) }),
            });

      const payload: AnswerPayload = {
        id,
        question,
        answer,
        createdAt: Date.now(),
        category,
        usedScreen: Boolean(capture),
      };
      this.lastSignature = signatureFor(question);
      this.lastAnswerAt = Date.now();
      this.emit('ask:answer', payload);
      this.emit('status', this.listening ? 'Слушаю' : 'Готово');
      return payload;
    } catch (error) {
      this.reportAnswerError(error);
      throw error;
    } finally {
      capture?.dispose();
      this.processingAnswer = false;
      this.emit('ask:state', { loading: false });
      if (this.queuedQuestion) this.scheduleQueuedAnswer();
    }
  }

  private requireApiKey(): string {
    const key = this.deps.getApiKey();
    if (!key) throw new Error('Для OpenAI API нужен ключ');
    return key;
  }

  private reportAnswerError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Не удалось получить ответ';
    this.emit('error', message);
    this.emit('status', this.listening ? 'Слушаю' : 'Ошибка ответа');
  }

  private emit(channel: string, payload: unknown): void {
    const contents = this.deps.webContents();
    if (!contents || contents.isDestroyed()) return;
    contents.send(channel, payload);
  }
}
