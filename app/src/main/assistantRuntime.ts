import type { WebContents } from 'electron';
import crypto from 'node:crypto';
import { CodexService } from './codexService';
import { OpenAIService } from './openaiService';
import { classifyQuestion, shouldAttachScreen, shouldAutoAnswer, signatureFor } from './questionDetector';
import { RealtimeTranscriptionService } from './realtimeTranscriptionService';
import type { CapturedScreen } from './screenCaptureService';
import type {
  AnswerPayload,
  AppSettings,
  AskRequest,
  AudioInputSource,
  LabeledAudioChunkPayload,
  SessionStatePayload,
  SessionSummaryPayload,
  TranscriptTurn,
} from './types';

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
  private readonly realtime: Record<AudioInputSource, RealtimeTranscriptionService> = {
    microphone: new RealtimeTranscriptionService(),
    system: new RealtimeTranscriptionService(),
  };
  private readonly transcript: TranscriptTurn[] = [];
  private readonly context: string[] = [];
  private readonly answers: AnswerPayload[] = [];
  private transcriptCount = 0;
  private summary: SessionSummaryPayload | null = null;
  private summaryTask: Promise<SessionSummaryPayload> | null = null;
  private summaryTaskGeneration = -1;
  private sessionGeneration = 0;
  private listening = false;
  private processingAnswer = false;
  private lastSignature = '';
  private lastAnswerAt = 0;
  private readonly reconnectAttempts: Record<AudioInputSource, number> = { microphone: 0, system: 0 };
  private readonly reconnectTimers: Record<AudioInputSource, NodeJS.Timeout | null> = {
    microphone: null,
    system: null,
  };
  private queuedQuestion = '';
  private queuedTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RuntimeDeps) {
    this.codex = deps.codex;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    if (!this.deps.getApiKey()) throw new Error('Для realtime-транскрипции нужен OpenAI API key');

    this.listening = true;
    this.reconnectAttempts.microphone = 0;
    this.reconnectAttempts.system = 0;
    this.emit('listen:state', { listening: true });
    try {
      const sources = this.activeAudioSources();
      await Promise.all(sources.map((source) => this.connectRealtime(source)));
    } catch (error) {
      this.listening = false;
      this.clearReconnectTimers();
      this.realtime.microphone.stop(false);
      this.realtime.system.stop(false);
      this.emit('listen:state', { listening: false });
      throw error;
    }
  }

  stop(): void {
    this.listening = false;
    this.clearReconnectTimers();
    this.realtime.microphone.stop(true);
    this.realtime.system.stop(true);
    this.emit('listen:state', { listening: false });
    this.emit('status', 'Прослушивание остановлено');
  }

  isListening(): boolean {
    return this.listening;
  }

  hasConversation(): boolean {
    return this.context.length > 0;
  }

  getSessionState(): SessionStatePayload {
    return {
      transcript: this.transcript.map((turn) => ({ ...turn })),
      answers: this.answers.map((answer) => ({ ...answer })).reverse(),
      summary: this.summary ? { ...this.summary } : null,
    };
  }

  handleAudioChunk(payload: LabeledAudioChunkPayload): void {
    if (!this.listening || !this.isAudioSource(payload.source)) return;
    this.realtime[payload.source].appendAudio(payload);
  }

  commitAudio(source: AudioInputSource): void {
    if (this.listening && this.isAudioSource(source)) this.realtime[source].commit();
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

  async askSmart(typedQuestion = ''): Promise<AnswerPayload> {
    const typed = typedQuestion.trim();
    if (typed) return await this.answer(typed, true);
    const interviewerTurns = this.transcript.filter((turn) => turn.speaker === 'them');
    const recentTurns = interviewerTurns.length ? interviewerTurns : this.transcript;
    const recentAudio = recentTurns
      .slice(-3)
      .map((turn) => `${turn.speaker === 'me' ? 'Вы' : 'Собеседник'}: ${turn.text}`)
      .join('\n')
      .trim();
    const question = recentAudio || 'Проанализируй актуальный снимок экрана и помоги решить видимую задачу.';
    return await this.answer(question, true);
  }

  clearSession(): void {
    this.transcript.length = 0;
    this.context.length = 0;
    this.answers.length = 0;
    this.transcriptCount = 0;
    this.summary = null;
    this.sessionGeneration += 1;
    this.codex.resetConversation();
    this.lastSignature = '';
    this.lastAnswerAt = 0;
    this.queuedQuestion = '';
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    this.queuedTimer = null;
    this.emit('session:cleared', {});
    this.emit('status', this.listening ? 'Слушаю' : 'Готово');
  }

  async summarizeSession(): Promise<SessionSummaryPayload> {
    if (this.summaryTask && this.summaryTaskGeneration === this.sessionGeneration) return await this.summaryTask;
    if (!this.context.length) throw new Error('В текущей сессии пока нет диалога для итогов');
    const generation = this.sessionGeneration;
    const task = this.createSummary(generation);
    this.summaryTask = task;
    this.summaryTaskGeneration = generation;
    try {
      return await task;
    } finally {
      if (this.summaryTask === task) {
        this.summaryTask = null;
        this.summaryTaskGeneration = -1;
      }
    }
  }

  private activeAudioSources(): AudioInputSource[] {
    const source = this.deps.getSettings().captureSource;
    if (source === 'microphone') return ['microphone'];
    if (source === 'system') return ['system'];
    return ['microphone', 'system'];
  }

  private isAudioSource(source: unknown): source is AudioInputSource {
    return source === 'microphone' || source === 'system';
  }

  private async connectRealtime(source: AudioInputSource): Promise<void> {
    const apiKey = this.deps.getApiKey();
    if (!apiKey || !this.listening) return;
    const settings = this.deps.getSettings();
    this.emit('status', this.reconnectAttempts[source] ? 'Переподключаю транскрипцию' : 'Подключаю транскрипцию');

    await this.realtime[source].start({
      apiKey,
      language: settings.language,
      delay: settings.transcriptionDelay,
      callbacks: {
        onPartial: (itemId, text) => this.emitTranscript(source, itemId, text, true),
        onFinal: (itemId, text) => void this.handleFinalTranscript(source, itemId, text),
        onError: (message) => this.emit('error', `${source === 'microphone' ? 'Микрофон' : 'Системный звук'}: ${message}`),
        onClose: () => this.scheduleReconnect(source),
      },
    });

    this.reconnectAttempts[source] = 0;
    this.emit('status', 'Слушаю в реальном времени');
  }

  private scheduleReconnect(source: AudioInputSource): void {
    if (!this.listening || this.reconnectTimers[source]) return;
    this.reconnectAttempts[source] += 1;
    const delay = Math.min(10_000, 1_000 * 2 ** Math.min(this.reconnectAttempts[source] - 1, 3));
    this.emit('status', `Связь потеряна, повтор через ${Math.ceil(delay / 1_000)} с`);
    this.reconnectTimers[source] = setTimeout(() => {
      this.reconnectTimers[source] = null;
      void this.connectRealtime(source).catch((error) => {
        this.emit('error', error instanceof Error ? error.message : 'Не удалось переподключить транскрипцию');
        this.scheduleReconnect(source);
      });
    }, delay);
  }

  private clearReconnectTimers(): void {
    for (const source of ['microphone', 'system'] as const) {
      if (this.reconnectTimers[source]) clearTimeout(this.reconnectTimers[source]);
      this.reconnectTimers[source] = null;
    }
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

  private emitTranscript(source: AudioInputSource, id: string, text: string, partial: boolean): void {
    if (!text) return;
    this.emit('listen:transcript', {
      id: `${source}:${id}`,
      speaker: source === 'microphone' ? 'me' : 'them',
      text,
      createdAt: Date.now(),
      partial,
    } satisfies TranscriptTurn);
  }

  private async handleFinalTranscript(source: AudioInputSource, id: string, text: string): Promise<void> {
    const speaker = source === 'microphone' ? 'me' : 'them';
    const turn: TranscriptTurn = {
      id: `${source}:${id}`,
      speaker,
      text,
      createdAt: Date.now(),
      partial: false,
    };
    this.transcript.push(turn);
    this.transcriptCount += 1;
    if (this.transcript.length > 100) this.transcript.splice(0, this.transcript.length - 100);
    this.context.push(`${speaker === 'me' ? 'Вы' : 'Собеседник'}: ${text}`);
    this.emit('listen:transcript', turn);
    this.emit('status', this.listening ? 'Слушаю в реальном времени' : 'Готово');

    const settings = this.deps.getSettings();
    const isQuestionSource = source === 'system' || settings.captureSource === 'microphone';
    if (isQuestionSource && settings.autoAnswer) {
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
      const conversation = [...this.context];
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
      this.answers.push(payload);
      this.context.push(`Вопрос: ${question}`, `Ответ RepGlass: ${answer}`);
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

  private async createSummary(generation: number): Promise<SessionSummaryPayload> {
    await this.waitForAnswerIdle();
    const settings = this.deps.getSettings();
    const question = [
      'Сформируй итоги текущего интервью на русском языке.',
      'Структура: краткое резюме разговора; заданные вопросы; сильные ответы; ответы, которые стоит улучшить; технические темы; следующие шаги.',
      'Не выдумывай факты и явно отмечай, если данных для раздела недостаточно.',
    ].join(' ');
    const conversation = [...this.context];
    const emitPartial = (text: string) => {
      if (generation !== this.sessionGeneration) return;
      this.emit('session:summary', {
        text,
        createdAt: Date.now(),
        partial: true,
        transcriptCount: this.transcriptCount,
        answerCount: this.answers.length,
      } satisfies SessionSummaryPayload);
    };

    if (generation === this.sessionGeneration) this.emit('session:summary-state', { loading: true });
    try {
      const text =
        settings.answerProvider === 'codex'
          ? await this.codex.answerQuestion({ question, conversation, settings, onDelta: emitPartial })
          : await this.openai.answerQuestion({
              apiKey: this.requireApiKey(),
              question,
              conversation,
              settings,
              onDelta: emitPartial,
            });
      const summary: SessionSummaryPayload = {
        text,
        createdAt: Date.now(),
        transcriptCount: this.transcriptCount,
        answerCount: this.answers.length,
      };
      if (generation === this.sessionGeneration) {
        this.summary = summary;
        this.emit('session:summary', summary);
      }
      return summary;
    } catch (error) {
      if (generation === this.sessionGeneration) this.reportAnswerError(error);
      throw error;
    } finally {
      if (generation === this.sessionGeneration) this.emit('session:summary-state', { loading: false });
    }
  }

  private async waitForAnswerIdle(): Promise<void> {
    const deadline = Date.now() + 180_000;
    while (this.processingAnswer && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.processingAnswer) throw new Error('Не удалось дождаться завершения текущего ответа');
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
