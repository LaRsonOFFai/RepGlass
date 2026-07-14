import type { WebContents } from 'electron';
import crypto from 'node:crypto';
import { CodexService } from './codexService';
import { OpenAIService } from './openaiService';
import { classifyQuestion, shouldAttachScreen, shouldAutoAnswer, signatureFor } from './questionDetector';
import { RealtimeTranscriptionService } from './realtimeTranscriptionService';
import type { CapturedScreen } from './screenCaptureService';
import { isLikelyTranscriptDuplicate } from './transcriptDedup';
import { buildInterviewCoach, buildInterviewContextPacket, hasInterviewContext } from './interviewContext';
import type {
  AnswerPayload,
  AppSettings,
  AskRequest,
  AssistantRequestPayload,
  AudioInputSource,
  InterviewCoachPayload,
  InterviewContextState,
  LabeledAudioChunkPayload,
  RequestSource,
  RequestTrigger,
  SessionInsightsPayload,
  SessionPhase,
  SessionStatePayload,
  SessionSummaryPayload,
  TranscriptTurn,
} from './types';

type RuntimeDeps = {
  codex: CodexService;
  getApiKey: () => string | null;
  getSettings: () => AppSettings;
  getInterviewContext: () => InterviewContextState;
  webContents: () => WebContents | null;
  captureScreen: () => Promise<CapturedScreen>;
};

type ContextEntry = {
  id: string;
  text: string;
};

type AnswerOptions = {
  trigger: RequestTrigger;
  sources: RequestSource[];
  forceScreen?: boolean;
  speaker?: TranscriptTurn['speaker'];
  transcriptTurnIds?: string[];
};

type QueuedAnswer = {
  question: string;
  options: AnswerOptions;
};

const MAX_TRANSCRIPT_TURNS = 200;
const MAX_ANSWERS = 40;
const ECHO_WINDOW_MS = 12_000;
const INSIGHTS_INTERVAL_TURNS = 5;

export class AssistantRuntime {
  private readonly openai = new OpenAIService();
  private readonly codex: CodexService;
  private readonly realtime: Record<AudioInputSource, RealtimeTranscriptionService> = {
    microphone: new RealtimeTranscriptionService(),
    system: new RealtimeTranscriptionService(),
  };
  private readonly transcript: TranscriptTurn[] = [];
  private readonly context: ContextEntry[] = [];
  private readonly answers: AnswerPayload[] = [];
  private transcriptCount = 0;
  private phase: SessionPhase = 'idle';
  private insights: SessionInsightsPayload | null = null;
  private summary: SessionSummaryPayload | null = null;
  private coach: InterviewCoachPayload | null = null;
  private insightsTask: Promise<SessionInsightsPayload> | null = null;
  private insightsTimer: NodeJS.Timeout | null = null;
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
  private queuedAnswer: QueuedAnswer | null = null;
  private queuedTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RuntimeDeps) {
    this.codex = deps.codex;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    if (this.phase === 'finished') throw new Error('Сессия завершена. Начните новую сессию.');
    if (!this.deps.getApiKey()) throw new Error('Для realtime-транскрипции нужен OpenAI API key');

    const previousPhase = this.phase;
    this.listening = true;
    this.setPhase('listening');
    this.reconnectAttempts.microphone = 0;
    this.reconnectAttempts.system = 0;
    this.emit('listen:state', { listening: true });
    try {
      await Promise.all(this.activeAudioSources().map((source) => this.connectRealtime(source)));
    } catch (error) {
      this.listening = false;
      this.setPhase(previousPhase === 'paused' ? 'paused' : 'idle');
      this.clearReconnectTimers();
      this.realtime.microphone.stop(false);
      this.realtime.system.stop(false);
      this.emit('listen:state', { listening: false });
      throw error;
    }
  }

  pause(): void {
    if (!this.listening) return;
    this.stopRealtime();
    this.setPhase(this.hasConversation() ? 'paused' : 'idle');
    this.emit('status', this.hasConversation() ? 'Пауза. Контекст сохранён' : 'Готово');
  }

  stop(): void {
    this.pause();
  }

  async finishSession(): Promise<SessionSummaryPayload> {
    if (this.listening) this.stopRealtime();
    if (!this.hasConversation()) throw new Error('В текущей сессии пока нет диалога');
    this.setPhase('finishing');
    try {
      const summary = await this.summarizeSession();
      this.setPhase('finished');
      this.emit('status', 'Сессия завершена');
      return summary;
    } catch (error) {
      this.setPhase('paused');
      throw error;
    }
  }

  isListening(): boolean {
    return this.listening;
  }

  hasConversation(): boolean {
    return this.context.length > 0;
  }

  getSessionState(): SessionStatePayload {
    return {
      phase: this.phase,
      transcript: this.transcript.map((turn) => ({ ...turn })),
      answers: this.answers.map((answer) => cloneAnswer(answer)).reverse(),
      insights: this.insights ? { ...this.insights } : null,
      summary: this.summary ? { ...this.summary } : null,
      coach: this.coach ? cloneCoach(this.coach) : null,
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
    return await this.answer(question, {
      trigger: normalized.trigger || 'manual',
      sources: ['text'],
      forceScreen: normalized.includeScreen,
    });
  }

  async askLatest(includeScreen = false): Promise<AnswerPayload> {
    const turns = this.latestInterviewerTurns(3);
    if (!turns.length) throw new Error('В транскрипции пока нет вопроса');
    return await this.answer(
      turns.map((turn) => turn.text).join(' '),
      {
        trigger: 'manual',
        sources: ['audio'],
        forceScreen: includeScreen,
        speaker: 'them',
        transcriptTurnIds: turns.map((turn) => turn.id),
      },
    );
  }

  async askSmart(typedQuestion = ''): Promise<AnswerPayload> {
    const typed = typedQuestion.trim();
    if (typed) {
      return await this.answer(typed, { trigger: 'hotkey', sources: ['text'], forceScreen: true });
    }

    const unanswered = [...this.transcript]
      .reverse()
      .find(
        (turn) =>
          turn.speaker === 'them' &&
          !this.answers.some((answer) => answer.request.transcriptTurnIds?.includes(turn.id)),
      );
    const latest = unanswered || this.latestInterviewerTurns(1)[0];
    if (latest) {
      return await this.answer(latest.text, {
        trigger: 'hotkey',
        sources: ['audio'],
        forceScreen: true,
        speaker: 'them',
        transcriptTurnIds: [latest.id],
      });
    }

    return await this.answer('Проанализируй актуальный снимок экрана и помоги решить видимую задачу.', {
      trigger: 'hotkey',
      sources: ['screen'],
      forceScreen: true,
    });
  }

  clearSession(): void {
    this.transcript.length = 0;
    this.context.length = 0;
    this.answers.length = 0;
    this.transcriptCount = 0;
    this.insights = null;
    this.summary = null;
    this.coach = null;
    this.sessionGeneration += 1;
    this.codex.resetConversation();
    this.lastSignature = '';
    this.lastAnswerAt = 0;
    this.queuedAnswer = null;
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    if (this.insightsTimer) clearTimeout(this.insightsTimer);
    this.queuedTimer = null;
    this.insightsTimer = null;
    this.setPhase(this.listening ? 'listening' : 'idle');
    this.emit('session:cleared', {});
    this.refreshInterviewContext();
    this.emit('status', this.listening ? 'Слушаю' : 'Готово');
  }

  async summarizeSession(): Promise<SessionSummaryPayload> {
    if (this.summaryTask && this.summaryTaskGeneration === this.sessionGeneration) return await this.summaryTask;
    if (!this.context.length) throw new Error('В текущей сессии пока нет диалога для итогов');
    if (this.insightsTask) await this.insightsTask.catch(() => undefined);
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

  async refreshInsights(): Promise<SessionInsightsPayload> {
    if (this.insightsTask) return await this.insightsTask;
    if (this.transcriptCount < 2) throw new Error('Для живых выводов пока недостаточно реплик');
    const generation = this.sessionGeneration;
    const task = this.createInsights(generation);
    this.insightsTask = task;
    try {
      return await task;
    } finally {
      if (this.insightsTask === task) this.insightsTask = null;
    }
  }

  refreshInterviewContext(): InterviewCoachPayload | null {
    const state = this.deps.getInterviewContext();
    if (!state.enabled || !state.predictiveAssist || !hasInterviewContext(state)) {
      this.coach = null;
      this.emit('context:coach', null);
      return null;
    }
    const latestQuestion = [...this.transcript].reverse().find((turn) => turn.speaker === 'them')?.text || '';
    this.coach = buildInterviewCoach(state, latestQuestion, this.context.map((entry) => entry.text));
    this.emit('context:coach', this.coach);
    return cloneCoach(this.coach);
  }

  private stopRealtime(): void {
    this.listening = false;
    this.clearReconnectTimers();
    this.realtime.microphone.stop(true);
    this.realtime.system.stop(true);
    this.emit('listen:state', { listening: false });
  }

  private setPhase(phase: SessionPhase): void {
    this.phase = phase;
    this.emit('session:phase', { phase });
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

  private async maybeAnswer(turn: TranscriptTurn): Promise<void> {
    const recent = this.latestInterviewerTurns(3)
      .map((item) => item.text)
      .join(' ');
    const question = [turn.text, recent].find((candidate) => shouldAutoAnswer(candidate));
    if (!question) return;

    const queued: QueuedAnswer = {
      question,
      options: {
        trigger: 'auto',
        sources: ['audio'],
        speaker: 'them',
        transcriptTurnIds: [turn.id],
      },
    };
    const signature = signatureFor(question);
    if (signature && signature === this.lastSignature) return;
    if (this.processingAnswer) {
      this.queuedAnswer = queued;
      return;
    }

    const cooldown = this.deps.getSettings().answerCooldownMs;
    const wait = cooldown - (Date.now() - this.lastAnswerAt);
    if (wait > 0) {
      this.queuedAnswer = queued;
      this.scheduleQueuedAnswer(wait);
      return;
    }

    await this.answer(question, queued.options);
  }

  private scheduleQueuedAnswer(delay = 350): void {
    if (this.queuedTimer) clearTimeout(this.queuedTimer);
    this.queuedTimer = setTimeout(() => {
      this.queuedTimer = null;
      const queued = this.queuedAnswer;
      this.queuedAnswer = null;
      if (!queued || !this.listening) return;
      void this.answer(queued.question, queued.options).catch((error) => this.reportAnswerError(error));
    }, Math.max(250, delay));
  }

  private latestInterviewerTurns(limit: number): TranscriptTurn[] {
    const interviewer = this.transcript.filter((turn) => turn.speaker === 'them');
    const source = interviewer.length ? interviewer : this.transcript;
    return source.slice(-limit);
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
    const cleanText = text.trim();
    if (!cleanText) return;
    const turn: TranscriptTurn = {
      id: `${source}:${id}`,
      speaker: source === 'microphone' ? 'me' : 'them',
      text: cleanText,
      createdAt: Date.now(),
      partial: false,
    };

    if (turn.speaker === 'me' && this.isMicrophoneEcho(turn)) {
      this.emit('listen:transcript-removed', { id: turn.id, reason: 'system-echo' });
      return;
    }
    if (turn.speaker === 'them') this.removeEarlierMicrophoneEcho(turn);

    this.transcript.push(turn);
    this.transcriptCount += 1;
    if (this.transcript.length > MAX_TRANSCRIPT_TURNS) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT_TURNS);
    this.context.push({ id: `transcript:${turn.id}`, text: `${turn.speaker === 'me' ? 'Вы' : 'Собеседник'}: ${turn.text}` });
    this.emit('listen:transcript', turn);
    this.emit('status', this.listening ? 'Слушаю в реальном времени' : 'Пауза');

    const settings = this.deps.getSettings();
    if (turn.speaker === 'them') this.refreshInterviewContext();
    const isQuestionSource = source === 'system' || settings.captureSource === 'microphone';
    if (isQuestionSource && settings.autoAnswer) {
      try {
        await this.maybeAnswer(turn);
      } catch (error) {
        this.reportAnswerError(error);
      }
    }
    this.scheduleInsightsRefresh();
  }

  private isMicrophoneEcho(turn: TranscriptTurn): boolean {
    if (this.deps.getSettings().captureSource !== 'both') return false;
    return this.transcript.some(
      (candidate) =>
        candidate.speaker === 'them' &&
        Math.abs(turn.createdAt - candidate.createdAt) <= ECHO_WINDOW_MS &&
        isLikelyTranscriptDuplicate(turn.text, candidate.text),
    );
  }

  private removeEarlierMicrophoneEcho(systemTurn: TranscriptTurn): void {
    if (this.deps.getSettings().captureSource !== 'both') return;
    const duplicate = [...this.transcript]
      .reverse()
      .find(
        (candidate) =>
          candidate.speaker === 'me' &&
          Math.abs(systemTurn.createdAt - candidate.createdAt) <= ECHO_WINDOW_MS &&
          isLikelyTranscriptDuplicate(systemTurn.text, candidate.text),
      );
    if (!duplicate) return;

    const index = this.transcript.findIndex((turn) => turn.id === duplicate.id);
    if (index >= 0) this.transcript.splice(index, 1);
    const contextIndex = this.context.findIndex((entry) => entry.id === `transcript:${duplicate.id}`);
    if (contextIndex >= 0) this.context.splice(contextIndex, 1);
    this.transcriptCount = Math.max(0, this.transcriptCount - 1);
    this.emit('listen:transcript-removed', { id: duplicate.id, reason: 'system-echo' });
  }

  private scheduleInsightsRefresh(): void {
    if (this.transcriptCount < INSIGHTS_INTERVAL_TURNS || this.transcriptCount % INSIGHTS_INTERVAL_TURNS !== 0) return;
    if (this.insightsTimer) clearTimeout(this.insightsTimer);
    this.insightsTimer = setTimeout(() => {
      this.insightsTimer = null;
      void this.refreshInsights().catch((error) => {
        console.warn('[AssistantRuntime] Live insights failed:', error);
      });
    }, 1_500);
  }

  private async answer(question: string, options: AnswerOptions): Promise<AnswerPayload> {
    this.processingAnswer = true;
    this.emit('ask:state', { loading: true });
    const settings = this.deps.getSettings();
    const wantsScreen =
      options.forceScreen === true ||
      (options.forceScreen !== false &&
        (settings.screenContext === 'always' || (settings.screenContext === 'smart' && shouldAttachScreen(question))));
    let capture: CapturedScreen | null = null;
    const id = crypto.randomUUID();

    try {
      this.emit('status', wantsScreen ? 'Смотрю на экран' : 'Готовлю ответ');
      if (wantsScreen) {
        try {
          capture = await this.deps.captureScreen();
        } catch (error) {
          if (options.forceScreen) throw error;
          this.emit('error', error instanceof Error ? error.message : 'Не удалось добавить экран');
        }
      }

      const conversation = this.context.map((entry) => entry.text);
      const interviewPacket = buildInterviewContextPacket(this.deps.getInterviewContext(), question, conversation);
      if (interviewPacket.coach.profileReady || interviewPacket.coach.vacancyReady) {
        this.coach = interviewPacket.coach;
        this.emit('context:coach', this.coach);
      }
      const request: AssistantRequestPayload = {
        id,
        question,
        trigger: options.trigger,
        sources: uniqueSources([...options.sources, ...(capture ? (['screen'] as const) : [])]),
        createdAt: Date.now(),
        speaker: options.speaker,
        transcriptTurnIds: options.transcriptTurnIds,
        screen: capture ? { dataUrl: capture.dataUrl, displayName: capture.displayName } : undefined,
        contextReferences: interviewPacket.references,
      };
      this.emit('ask:request', request);

      const category = classifyQuestion(question, Boolean(capture));
      const onDelta = (text: string) =>
        this.emit('ask:delta', { id, request, question, answer: text, category, usedScreen: Boolean(capture) });
      const answer =
        settings.answerProvider === 'codex'
          ? await this.codex.answerQuestion({
              question,
              conversation,
              settings,
              interviewContext: interviewPacket.prompt,
              imagePath: capture?.path,
              onDelta,
            })
          : await this.openai.answerQuestion({
              apiKey: this.requireApiKey(),
              question,
              conversation,
              settings,
              interviewContext: interviewPacket.prompt,
              imagePath: capture?.path,
              onDelta,
            });

      const payload: AnswerPayload = {
        id,
        request,
        question,
        answer,
        createdAt: Date.now(),
        category,
        usedScreen: Boolean(capture),
      };
      this.lastSignature = signatureFor(question);
      this.lastAnswerAt = Date.now();
      this.answers.push(payload);
      if (this.answers.length > MAX_ANSWERS) this.answers.splice(0, this.answers.length - MAX_ANSWERS);
      this.context.push(
        { id: `question:${id}`, text: `Вопрос: ${question}` },
        { id: `answer:${id}`, text: `Ответ RepGlass: ${answer}` },
      );
      this.emit('ask:answer', payload);
      this.emit('status', this.listening ? 'Слушаю' : this.phase === 'paused' ? 'Пауза' : 'Готово');
      return payload;
    } catch (error) {
      this.reportAnswerError(error);
      throw error;
    } finally {
      capture?.dispose();
      this.processingAnswer = false;
      this.emit('ask:state', { loading: false });
      if (this.queuedAnswer) this.scheduleQueuedAnswer();
    }
  }

  private async createInsights(generation: number): Promise<SessionInsightsPayload> {
    await this.waitForAnswerIdle();
    const settings = this.deps.getSettings();
    const question = [
      'Обнови живые выводы по текущему интервью на русском языке.',
      'Верни короткие разделы: **Сейчас обсуждают**, **Ключевые факты**, **Вероятный следующий вопрос**.',
      'Не оценивай кандидата и не выдумывай факты. Не более 8 коротких пунктов.',
    ].join(' ');
    const conversation = this.context.map((entry) => entry.text);
    const interviewContext = buildInterviewContextPacket(this.deps.getInterviewContext(), question, conversation).prompt;
    const emitPartial = (text: string) => {
      if (generation !== this.sessionGeneration) return;
      this.emit('session:insights', {
        text,
        createdAt: Date.now(),
        partial: true,
        transcriptCount: this.transcriptCount,
      } satisfies SessionInsightsPayload);
    };

    this.emit('session:insights-state', { loading: true });
    try {
      const text = await this.runModel(question, conversation, settings, emitPartial, interviewContext);
      const insights: SessionInsightsPayload = {
        text,
        createdAt: Date.now(),
        transcriptCount: this.transcriptCount,
      };
      if (generation === this.sessionGeneration) {
        this.insights = insights;
        this.emit('session:insights', insights);
      }
      return insights;
    } finally {
      if (generation === this.sessionGeneration) this.emit('session:insights-state', { loading: false });
    }
  }

  private async createSummary(generation: number): Promise<SessionSummaryPayload> {
    await this.waitForAnswerIdle();
    const settings = this.deps.getSettings();
    const question = [
      'Сформируй финальные итоги текущего интервью на русском языке.',
      'Структура: краткое резюме; заданные вопросы; сильные ответы; ответы, которые стоит улучшить; экранные и технические задачи; следующие шаги.',
      'Используй весь контекст сессии, не выдумывай факты и явно отмечай отсутствие данных.',
    ].join(' ');
    const conversation = this.context.map((entry) => entry.text);
    const interviewContext = buildInterviewContextPacket(this.deps.getInterviewContext(), question, conversation).prompt;
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
      const text = await this.runModel(question, conversation, settings, emitPartial, interviewContext);
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

  private async runModel(
    question: string,
    conversation: string[],
    settings: AppSettings,
    onDelta: (text: string) => void,
    interviewContext = '',
  ): Promise<string> {
    return settings.answerProvider === 'codex'
      ? await this.codex.answerQuestion({ question, conversation, settings, onDelta, interviewContext })
      : await this.openai.answerQuestion({
          apiKey: this.requireApiKey(),
          question,
          conversation,
          settings,
          onDelta,
          interviewContext,
        });
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

function uniqueSources(sources: RequestSource[]): RequestSource[] {
  return [...new Set(sources)];
}

function cloneAnswer(answer: AnswerPayload): AnswerPayload {
  return {
    ...answer,
    request: {
      ...answer.request,
      sources: [...answer.request.sources],
      transcriptTurnIds: answer.request.transcriptTurnIds ? [...answer.request.transcriptTurnIds] : undefined,
      screen: answer.request.screen ? { ...answer.request.screen } : undefined,
      contextReferences: answer.request.contextReferences?.map((reference) => ({ ...reference })),
    },
  };
}

function cloneCoach(coach: InterviewCoachPayload): InterviewCoachPayload {
  return {
    ...coach,
    relevantFacts: coach.relevantFacts.map((reference) => ({ ...reference })),
    vacancySignals: [...coach.vacancySignals],
    likelyQuestions: [...coach.likelyQuestions],
    alerts: [...coach.alerts],
  };
}
