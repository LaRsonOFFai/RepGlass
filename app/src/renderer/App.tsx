import {
  AudioLines,
  Bot,
  BookOpen,
  Briefcase,
  Bug,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Code2,
  Copy,
  EyeOff,
  FileText,
  FileUp,
  Gauge,
  Image as ImageIcon,
  KeyRound,
  Lightbulb,
  LogIn,
  LogOut,
  MessageSquareText,
  Mic,
  Minus,
  Monitor,
  Pause,
  Pin,
  PinOff,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRoundCog,
  Volume2,
  X,
} from 'lucide-react';
import { isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CodexModel } from '../main/codexService';
import { PROFILE_LABELS } from '../main/defaults';
import { DEFAULT_INTERVIEW_CONTEXT } from '../main/interviewContext';
import type {
  AnswerDetail,
  AnswerPayload,
  AssistantRequestPayload,
  AppSettings,
  AuthState,
  InterviewAnswerStyle,
  InterviewCoachPayload,
  InterviewContextDocumentKind,
  InterviewContextState,
  NarrativeNavigationRequest,
  InterviewProfile,
  ReasoningEffort,
  ScreenCapturePayload,
  ScreenContextMode,
  SessionInsightsPayload,
  SessionPhase,
  SessionSummaryPayload,
  TranscriptTurn,
  TranscriptionDelay,
} from '../main/types';
import { AudioCapture } from './audioCapture';

const APP_NAME = 'RepGlass';
const API_KEYS_URL = 'https://platform.openai.com/api-keys';
const API_MODEL_OPTIONS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5'];
const FALLBACK_CODEX_MODELS = ['gpt-5.4-mini', 'gpt-5.5'];

type View = 'workspace' | 'settings';
type ListenMode = 'transcript' | 'insights' | 'summary';
type SettingsTab = 'connection' | 'profile' | 'audio' | 'privacy';

export function App() {
  const capture = useRef(new AudioCapture());
  const toggleListenRef = useRef<() => void>(() => undefined);
  const smartSubmitRef = useRef<() => void>(() => undefined);
  const finishSessionRef = useRef<() => void>(() => undefined);
  const questionInputRef = useRef<HTMLInputElement>(null);
  const [auth, setAuth] = useState<AuthState>({ mode: 'none', hasApiKey: false, hasCodexAuth: false });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [view, setView] = useState<View>('workspace');
  const [listenMode, setListenMode] = useState<ListenMode>('transcript');
  const [askOpen, setAskOpen] = useState(true);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  const [status, setStatus] = useState('Готово');
  const [errorMessage, setErrorMessage] = useState('');
  const [listening, setListening] = useState(false);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [loadingAnswer, setLoadingAnswer] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiBusy, setApiBusy] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [includeScreen, setIncludeScreen] = useState(false);
  const [screenPreview, setScreenPreview] = useState<ScreenCapturePayload | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [answers, setAnswers] = useState<AnswerPayload[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState<AnswerPayload | null>(null);
  const [activeRequest, setActiveRequest] = useState<AssistantRequestPayload | null>(null);
  const [insights, setInsights] = useState<SessionInsightsPayload | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [summary, setSummary] = useState<SessionSummaryPayload | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [interviewContext, setInterviewContext] = useState<InterviewContextState>(DEFAULT_INTERVIEW_CONTEXT);
  const [contextBusy, setContextBusy] = useState(false);
  const [coach, setCoach] = useState<InterviewCoachPayload | null>(null);

  useEffect(() => {
    const audioCapture = capture.current;
    void Promise.all([
      window.glass.auth.getState(),
      window.glass.settings.get(),
      window.glass.session.getState(),
      window.glass.context.get(),
    ])
      .then(([nextAuth, nextSettings, sessionState, nextInterviewContext]) => {
        setAuth(nextAuth);
        setSettings(nextSettings);
        setTranscript(sessionState.transcript);
        setAnswers(sessionState.answers);
        setPhase(sessionState.phase);
        setInsights(sessionState.insights);
        setSummary(sessionState.summary);
        setCoach(sessionState.coach);
        setInterviewContext(nextInterviewContext);
        const ready = nextSettings.answerProvider === 'codex' ? nextAuth.hasCodexAuth : nextAuth.hasApiKey;
        if (!ready) {
          setView('settings');
          setSettingsTab('connection');
        }
      })
      .catch((error) => setErrorMessage(error instanceof Error ? error.message : 'Ошибка запуска'));
    void window.glass.auth.getCodexModels().then(setCodexModels).catch(() => undefined);

    const offStatus = window.glass.events.onStatus((message) => {
      setStatus(message);
      if (!/ошиб|failed|error/iu.test(message)) setErrorMessage('');
    });
    const offError = window.glass.events.onError((message) => {
      setStatus('Требуется внимание');
      setErrorMessage(message);
    });
    const offListen = window.glass.events.onListenState((payload) => setListening(payload.listening));
    const offPhase = window.glass.events.onSessionPhase((payload) => setPhase(payload.phase));
    const offTranscript = window.glass.events.onTranscript((turn) => {
      setTranscript((current) => {
        const existingIndex = current.findIndex((item) => item.id === turn.id);
        if (existingIndex < 0) return [...current.slice(-99), turn];
        const next = [...current];
        next[existingIndex] = turn;
        return next;
      });
    });
    const offTranscriptRemoved = window.glass.events.onTranscriptRemoved((payload) => {
      setTranscript((current) => current.filter((turn) => turn.id !== payload.id));
    });
    const offAskState = window.glass.events.onAskState((payload) => setLoadingAnswer(payload.loading));
    const offRequest = window.glass.events.onRequest((request) => {
      setView('workspace');
      setAskOpen(true);
      setActiveRequest(request);
    });
    const offAnswerDelta = window.glass.events.onAnswerDelta((payload) => {
      setView('workspace');
      setAskOpen(true);
      setActiveRequest(payload.request);
      setStreamingAnswer({ ...payload, createdAt: Date.now() });
    });
    const offAnswer = window.glass.events.onAnswer((answer) => {
      setView('workspace');
      setAskOpen(true);
      setActiveRequest(answer.request);
      setStreamingAnswer(null);
      setAnswers((current) => [answer, ...current.filter((item) => item.id !== answer.id)].slice(0, 20));
    });
    const offPreview = window.glass.events.onScreenPreview(setScreenPreview);
    const offToggle = window.glass.events.onListenToggleRequested(() => toggleListenRef.current());
    const offSmartSubmit = window.glass.events.onSmartSubmitRequested(() => smartSubmitRef.current());
    const offFinishRequested = window.glass.events.onSessionFinishRequested(() => finishSessionRef.current());
    const offFocusComposer = window.glass.events.onComposerFocusRequested(() => {
      setView('workspace');
      setAskOpen(true);
      window.requestAnimationFrame(() => questionInputRef.current?.focus());
    });
    const offNavigation = window.glass.events.onNavigation((payload) => {
      if (payload.view === 'settings') {
        setView('settings');
        return;
      }
      setView('workspace');
      if (payload.view === 'answers') setAskOpen(true);
      if (payload.view === 'transcript') setListenMode('transcript');
      if (payload.view === 'summary') setListenMode('summary');
    });
    const offCleared = window.glass.events.onSessionCleared(() => {
      setTranscript([]);
      setAnswers([]);
      setStreamingAnswer(null);
      setActiveRequest(null);
      setScreenPreview(null);
      setInsights(null);
      setSummary(null);
      setCoach(null);
    });
    const offSummary = window.glass.events.onSummary((payload) => {
      setSummary(payload);
    });
    const offSummaryState = window.glass.events.onSummaryState((payload) => setSummaryLoading(payload.loading));
    const offInsights = window.glass.events.onInsights(setInsights);
    const offInsightsState = window.glass.events.onInsightsState((payload) => setInsightsLoading(payload.loading));
    const offCoach = window.glass.events.onCoach(setCoach);

    return () => {
      offStatus();
      offError();
      offListen();
      offPhase();
      offTranscript();
      offTranscriptRemoved();
      offAskState();
      offRequest();
      offAnswerDelta();
      offAnswer();
      offPreview();
      offToggle();
      offSmartSubmit();
      offFinishRequested();
      offFocusComposer();
      offNavigation();
      offCleared();
      offSummary();
      offSummaryState();
      offInsights();
      offInsightsState();
      offCoach();
      audioCapture.stop();
    };
  }, []);

  const answerAuthReady = Boolean(
    settings && (settings.answerProvider === 'codex' ? auth.hasCodexAuth : auth.hasApiKey),
  );
  const activeModelLabel = settings?.answerProvider === 'codex' ? settings.codexModel : settings?.model;

  const refreshAuth = useCallback(async () => {
    const nextAuth = await window.glass.auth.getState();
    setAuth(nextAuth);
    return nextAuth;
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.glass.settings.update(patch);
    setSettings(next);
    return next;
  }, []);

  const startListening = useCallback(async () => {
    if (!settings) return;
    if (!auth.hasApiKey) {
      setView('settings');
      setSettingsTab('connection');
      setErrorMessage('Добавьте OpenAI API key для realtime-транскрипции');
      return;
    }

    if (phase === 'finished') await window.glass.session.clear();
    setView('workspace');
    setListenMode('transcript');
    setErrorMessage('');
    const result = await window.glass.listen.start();
    if (!result.success) {
      setErrorMessage(result.error || 'Не удалось начать прослушивание');
      return;
    }

    try {
      await capture.current.start(
        settings,
        (source, payload) => window.glass.listen.sendAudioChunk({ ...payload, source }),
        (source) => window.glass.listen.commitAudio(source),
      );
    } catch (error) {
      await window.glass.listen.stop();
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось получить аудио');
    }
  }, [auth.hasApiKey, phase, settings]);

  const stopListening = useCallback(async () => {
    capture.current.stop();
    await window.glass.listen.stop();
  }, []);

  const saveInterviewContext = useCallback(async (candidate: Partial<InterviewContextState>) => {
    setContextBusy(true);
    setErrorMessage('');
    try {
      const next = await window.glass.context.save(candidate);
      setInterviewContext(next);
      setStatus('Профиль интервью сохранён');
      return next;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось сохранить профиль интервью');
      throw error;
    } finally {
      setContextBusy(false);
    }
  }, []);

  const importInterviewFile = useCallback(async (
    kind: InterviewContextDocumentKind,
    draft: InterviewContextState,
  ) => {
    setContextBusy(true);
    setErrorMessage('');
    try {
      const saved = await window.glass.context.save(draft);
      setInterviewContext(saved);
      const result = await window.glass.context.importFile({ kind });
      setInterviewContext(result.state);
      return result.state;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось импортировать материал');
      throw error;
    } finally {
      setContextBusy(false);
    }
  }, []);

  const removeInterviewDocument = useCallback(async (documentId: string, draft: InterviewContextState) => {
    setContextBusy(true);
    setErrorMessage('');
    try {
      await window.glass.context.save(draft);
      const next = await window.glass.context.removeDocument(documentId);
      setInterviewContext(next);
      return next;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось удалить материал');
      throw error;
    } finally {
      setContextBusy(false);
    }
  }, []);

  const clearInterviewContext = useCallback(async () => {
    setContextBusy(true);
    setErrorMessage('');
    try {
      const next = await window.glass.context.clear();
      setInterviewContext(next);
      setStatus('Профиль интервью очищен');
      return next;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось очистить профиль интервью');
      throw error;
    } finally {
      setContextBusy(false);
    }
  }, []);

  const navigateNarrative = useCallback(async (request: NarrativeNavigationRequest) => {
    try {
      const next = await window.glass.context.navigateNarrative(request);
      setCoach(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось переместиться по рассказу');
    }
  }, []);

  toggleListenRef.current = () => void (listening ? stopListening() : startListening());

  const sendQuestion = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed || !settings || loadingAnswer) return;
    if (!answerAuthReady) {
      setView('settings');
      setSettingsTab('connection');
      setErrorMessage(settings.answerProvider === 'codex' ? 'Подключите OpenAI Codex' : 'Добавьте OpenAI API key');
      return;
    }

    setQuestion('');
    const shouldIncludeScreen = includeScreen;
    setIncludeScreen(false);
    setScreenPreview(null);
    setErrorMessage('');
    try {
      await window.glass.ask.send(shouldIncludeScreen ? { question: trimmed, includeScreen: true } : { question: trimmed });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось получить ответ');
    }
  }, [answerAuthReady, includeScreen, loadingAnswer, question, settings]);

  const smartSubmit = useCallback(async () => {
    if (!settings || loadingAnswer) return;
    if (!answerAuthReady) {
      setView('settings');
      setSettingsTab('connection');
      setErrorMessage(settings.answerProvider === 'codex' ? 'Подключите OpenAI Codex' : 'Добавьте OpenAI API key');
      return;
    }

    const typed = question.trim();
    if (typed) setQuestion('');
    setIncludeScreen(false);
    setScreenPreview(null);
    setView('workspace');
    setAskOpen(true);
    setErrorMessage('');
    try {
      await window.glass.ask.smart(typed);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось выполнить умный запрос');
    }
  }, [answerAuthReady, loadingAnswer, question, settings]);

  smartSubmitRef.current = () => void smartSubmit();

  const generateSummary = useCallback(async () => {
    if (summaryLoading) return;
    setView('workspace');
    setListenMode('summary');
    setErrorMessage('');
    try {
      await window.glass.session.summarize();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось сформировать итоги');
    }
  }, [summaryLoading]);

  const refreshInsights = useCallback(async () => {
    if (insightsLoading) return;
    setListenMode('insights');
    try {
      await window.glass.session.refreshInsights();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось обновить живые выводы');
    }
  }, [insightsLoading]);

  const finishSession = useCallback(async () => {
    if (summaryLoading || phase === 'finishing') return;
    capture.current.stop();
    if (listening) await window.glass.listen.stop();
    setView('workspace');
    setListenMode('summary');
    setErrorMessage('');
    try {
      await window.glass.session.finish();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось завершить сессию');
    }
  }, [listening, phase, summaryLoading]);

  finishSessionRef.current = () => void finishSession();

  const askFromInsight = useCallback(
    async (text: string) => {
      if (!text.trim() || loadingAnswer) return;
      setView('workspace');
      setAskOpen(true);
      try {
        await window.glass.ask.send({ question: text.trim(), trigger: 'insight' });
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Не удалось открыть вывод в Ask');
      }
    },
    [loadingAnswer],
  );

  const askFromCoach = useCallback(
    async (text: string) => {
      if (!text.trim() || loadingAnswer) return;
      setView('workspace');
      setAskOpen(true);
      try {
        await window.glass.ask.send({ question: text.trim(), trigger: 'coach' });
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Не удалось подготовить ответ из профиля');
      }
    },
    [loadingAnswer],
  );

  const toggleScreen = useCallback(async () => {
    if (includeScreen) {
      setIncludeScreen(false);
      setScreenPreview(null);
      return;
    }
    try {
      const preview = await window.glass.screen.capturePreview();
      setScreenPreview(preview);
      setIncludeScreen(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось получить экран');
    }
  }, [includeScreen]);

  const clearSession = useCallback(async () => {
    await window.glass.session.clear();
    setListenMode('transcript');
  }, []);

  const connectCodex = useCallback(async () => {
    setCodexBusy(true);
    setErrorMessage('');
    setStatus('Открываю вход OpenAI');
    try {
      await window.glass.auth.startCodexLogin();
      await refreshAuth();
      const models = await window.glass.auth.getCodexModels().catch(() => []);
      if (models.length) setCodexModels(models);
      setStatus('Codex подключён');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось подключить Codex');
    } finally {
      setCodexBusy(false);
    }
  }, [refreshAuth]);

  const disconnectCodex = useCallback(async () => {
    setCodexBusy(true);
    try {
      await window.glass.auth.logoutCodex();
      await refreshAuth();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось выйти из Codex');
    } finally {
      setCodexBusy(false);
    }
  }, [refreshAuth]);

  const saveApiKey = useCallback(async () => {
    if (!apiKey.trim()) return;
    setApiBusy(true);
    setErrorMessage('');
    try {
      const result = await window.glass.auth.saveApiKey(apiKey);
      if (!result.success) {
        setErrorMessage(result.error);
        return;
      }
      setAuth(result.auth);
      setApiKey('');
      setStatus('OpenAI API подключён');
    } finally {
      setApiBusy(false);
    }
  }, [apiKey]);

  const clearApiKey = useCallback(async () => {
    if (listening) await stopListening();
    setAuth(await window.glass.auth.clearApiKey());
    setApiKey('');
  }, [listening, stopListening]);

  if (!settings) {
    return (
      <main className="app-stage loading-stage">
        <div className="loading-capsule">
          <span className="brand-mark" />
          <span>{APP_NAME}</span>
        </div>
      </main>
    );
  }

  const hasConversation = Boolean(transcript.length || answers.length);

  return (
    <main className={`app-stage original-shell phase-${phase}`}>
      <header className="command-capsule">
        <button
          className={`listen-control ${listening ? 'active' : ''}`}
          title={`${listening ? 'Поставить на паузу' : 'Начать прослушивание'} — Ctrl+Shift+L`}
          onClick={listening ? stopListening : startListening}
        >
          {listening ? <Pause size={14} /> : <Play size={14} />}
          <span>{listening ? 'Пауза' : phase === 'paused' ? 'Продолжить' : 'Слушать'}</span>
          {listening && <span className="live-dot" />}
        </button>

        <button
          className={askOpen && view === 'workspace' ? 'header-action active' : 'header-action'}
          title="Открыть Ask — Ctrl+Shift+Q"
          onClick={() => {
            setView('workspace');
            setAskOpen((current) => !current);
            window.requestAnimationFrame(() => questionInputRef.current?.focus());
          }}
        >
          <MessageSquareText size={14} />
          <span>Ask</span>
          <kbd>Ctrl ↵</kbd>
        </button>

        <button className="header-action" title="Скрыть RepGlass — Ctrl+\\" onClick={() => window.glass.window.hide()}>
          <EyeOff size={14} />
          <span>Скрыть</span>
        </button>

        <div className="capsule-spacer" />
        <span className={`session-label ${listening ? 'live' : ''}`}>{errorMessage || phaseLabel(phase, status)}</span>
        {activeModelLabel && (
          <span className="model-label" title="Активная модель ответов">
            <Bot size={12} />
            {activeModelLabel}
          </span>
        )}
        <span className="privacy-indicator" title="Окно защищено от захвата экрана">
          <EyeOff size={14} />
        </span>
        <button className="icon-button" title="Начать новую сессию" onClick={clearSession} disabled={!hasConversation}>
          <Trash2 size={14} />
        </button>
        <button
          className="icon-button"
          title="Профиль кандидата и вакансия"
          onClick={() => {
            setView('settings');
            setSettingsTab('profile');
          }}
        >
          <Briefcase size={14} />
        </button>
        <button className="icon-button" title="Настройки и авторизация" onClick={() => setView('settings')}>
          <Settings2 size={15} />
        </button>
        <button className="icon-button capsule-hide" title="Скрыть" onClick={() => window.glass.window.hide()}>
          <Minus size={15} />
        </button>
      </header>

      {view === 'settings' ? (
        <section className="workspace-panel settings-workspace">
          <div className="workspace-head">
            <div className="workspace-title">
              <span className="brand-mark" />
              <div>
                <strong>Настройки RepGlass</strong>
                <span className={errorMessage ? 'status error-status' : 'status'}>{errorMessage || status}</span>
              </div>
            </div>
            <button className="secondary-button" onClick={() => setView('workspace')}>Вернуться</button>
          </div>
          <div className="workspace-body">
            <SettingsView
              tab={settingsTab}
              onTabChange={setSettingsTab}
              auth={auth}
              settings={settings}
              codexModels={codexModels}
              apiKey={apiKey}
              apiBusy={apiBusy}
              codexBusy={codexBusy}
              listening={listening}
              interviewContext={interviewContext}
              contextBusy={contextBusy}
              onApiKeyChange={setApiKey}
              onSaveApiKey={saveApiKey}
              onClearApiKey={clearApiKey}
              onConnectCodex={connectCodex}
              onDisconnectCodex={disconnectCodex}
              onRefreshAuth={refreshAuth}
              onOpenApiKeys={() => window.glass.window.openExternal(API_KEYS_URL)}
              onUpdateSettings={updateSettings}
              onSaveInterviewContext={saveInterviewContext}
              onImportInterviewFile={importInterviewFile}
              onRemoveInterviewDocument={removeInterviewDocument}
              onClearInterviewContext={clearInterviewContext}
            />
          </div>
        </section>
      ) : (
        <section className={askOpen ? 'glass-workspace ask-visible' : 'glass-workspace'}>
          <ListenPanel
            mode={listenMode}
            onModeChange={setListenMode}
            transcript={transcript}
            insights={insights}
            insightsLoading={insightsLoading}
            summary={summary}
            summaryLoading={summaryLoading}
            listening={listening}
            phase={phase}
            hasConversation={hasConversation}
            onRefreshInsights={refreshInsights}
            onGenerateSummary={generateSummary}
            onFinish={finishSession}
            onAskInsight={askFromInsight}
          />

          {askOpen && (
            <section className="feature-panel ask-panel">
              <AnswersView
                answers={answers}
                streaming={streamingAnswer}
                request={activeRequest}
                loading={loadingAnswer}
                listening={listening}
                status={status}
                authReady={answerAuthReady}
                coach={coach}
                onClose={() => setAskOpen(false)}
                onAskCoach={askFromCoach}
                onNavigateNarrative={navigateNarrative}
                onOpenSettings={() => {
                  setView('settings');
                  setSettingsTab('connection');
                }}
                onOpenProfile={() => {
                  setView('settings');
                  setSettingsTab('profile');
                }}
              />
              <Composer
                question={question}
                loading={loadingAnswer}
                includeScreen={includeScreen}
                preview={screenPreview}
                inputRef={questionInputRef}
                onQuestionChange={setQuestion}
                onToggleScreen={toggleScreen}
                onSend={sendQuestion}
              />
            </section>
          )}
        </section>
      )}
    </main>
  );
}

function ViewButton(props: { active: boolean; label: string; title?: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button className={props.active ? 'view-button active' : 'view-button'} title={props.title} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function ListenPanel(props: {
  mode: ListenMode;
  onModeChange: (mode: ListenMode) => void;
  transcript: TranscriptTurn[];
  insights: SessionInsightsPayload | null;
  insightsLoading: boolean;
  summary: SessionSummaryPayload | null;
  summaryLoading: boolean;
  listening: boolean;
  phase: SessionPhase;
  hasConversation: boolean;
  onRefreshInsights: () => void;
  onGenerateSummary: () => void;
  onFinish: () => void;
  onAskInsight: (text: string) => void;
}) {
  return (
    <section className="feature-panel listen-panel">
      <div className="feature-bar">
        <div className="feature-title">
          <span className={props.listening ? 'audio-status active' : 'audio-status'}><AudioLines size={14} /></span>
          <div>
            <strong>{props.listening ? 'RepGlass слушает' : phaseLabel(props.phase, 'Готово')}</strong>
            <small>{props.transcript.length ? `${props.transcript.length} реплик в контексте` : 'Микрофон + системный звук'}</small>
          </div>
        </div>
        <nav className="panel-mode-switcher" aria-label="Режим Listen">
          <ViewButton active={props.mode === 'transcript'} label="Текст" title="Живая транскрипция" icon={<ScrollText size={13} />} onClick={() => props.onModeChange('transcript')} />
          <ViewButton active={props.mode === 'insights'} label="Выводы" title="Живые выводы" icon={<Lightbulb size={13} />} onClick={() => props.onModeChange('insights')} />
          <ViewButton active={props.mode === 'summary'} label="Итоги" title="Финальные итоги" icon={<FileText size={13} />} onClick={() => props.onModeChange('summary')} />
        </nav>
      </div>

      <div className="feature-content listen-content">
        {props.mode === 'transcript' && <TranscriptView turns={props.transcript} listening={props.listening} />}
        {props.mode === 'insights' && (
          <InsightsView
            insights={props.insights}
            loading={props.insightsLoading}
            hasConversation={props.hasConversation}
            onRefresh={props.onRefreshInsights}
            onAsk={props.onAskInsight}
          />
        )}
        {props.mode === 'summary' && (
          <SummaryView
            summary={props.summary}
            loading={props.summaryLoading}
            hasConversation={props.hasConversation}
            phase={props.phase}
            onGenerate={props.onGenerateSummary}
            onAsk={props.onAskInsight}
          />
        )}
      </div>

      <div className="listen-footer">
        <span>{props.listening ? 'Два независимых STT-канала активны' : props.phase === 'paused' ? 'Контекст сохранён' : 'Сессия не запущена'}</span>
        <button className="secondary-button finish-button" onClick={props.onFinish} disabled={!props.hasConversation || props.summaryLoading || props.phase === 'finishing'}>
          {props.summaryLoading || props.phase === 'finishing' ? <RefreshCw className="spin" size={13} /> : <FileText size={13} />}
          <span>Завершить</span>
        </button>
      </div>
    </section>
  );
}

function AnswersView(props: {
  answers: AnswerPayload[];
  streaming: AnswerPayload | null;
  request: AssistantRequestPayload | null;
  loading: boolean;
  listening: boolean;
  status: string;
  authReady: boolean;
  coach: InterviewCoachPayload | null;
  onClose: () => void;
  onAskCoach: (text: string) => void;
  onNavigateNarrative: (request: NarrativeNavigationRequest) => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
}) {
  const visibleAnswers = useMemo(
    () =>
      props.streaming
        ? [props.streaming, ...props.answers.filter((answer) => answer.id !== props.streaming?.id)]
        : props.answers,
    [props.answers, props.streaming],
  );
  const [answerIndex, setAnswerIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [coachOpen, setCoachOpen] = useState(true);
  const newestId = visibleAnswers[0]?.id;
  useEffect(() => setAnswerIndex(0), [newestId]);
  useEffect(() => {
    if (props.coach?.showNarrative) setCoachOpen(true);
  }, [props.coach?.generatedAt, props.coach?.showNarrative]);
  const selectedAnswer = visibleAnswers[Math.min(answerIndex, Math.max(0, visibleAnswers.length - 1))] || null;
  const showingPendingRequest = Boolean(props.loading && props.request && props.request.id !== selectedAnswer?.id);
  const activeAnswer = showingPendingRequest ? null : selectedAnswer;
  const activeRequest = showingPendingRequest ? props.request : activeAnswer?.request || props.request;
  const isStreaming = Boolean(props.streaming && activeAnswer?.id === props.streaming.id);

  return (
    <>
      <div className="feature-bar ask-bar">
        <div className="feature-title">
          <span className="ask-status"><Sparkles size={14} /></span>
          <div>
            <strong>{props.loading ? 'Готовлю ответ' : activeAnswer ? 'AI Response' : 'Ask'}</strong>
            <small>{activeRequest ? requestTriggerLabel(activeRequest.trigger) : 'Текст, аудио или экран'}</small>
          </div>
        </div>
        <div className="ask-controls">
          <button
            className={coachOpen && props.coach ? 'icon-button context-active' : 'icon-button'}
            title={props.coach ? 'Показать контекст кандидата' : 'Настроить профиль кандидата'}
            onClick={() => (props.coach ? setCoachOpen((current) => !current) : props.onOpenProfile())}
          >
            <Briefcase size={14} />
          </button>
          <button className="icon-button" title="Предыдущий ответ" disabled={answerIndex >= visibleAnswers.length - 1} onClick={() => setAnswerIndex((index) => Math.min(visibleAnswers.length - 1, index + 1))}>
            <ChevronLeft size={14} />
          </button>
          <span className="history-position">{visibleAnswers.length ? `${answerIndex + 1}/${visibleAnswers.length}` : '0/0'}</span>
          <button className="icon-button" title="Следующий ответ" disabled={answerIndex <= 0} onClick={() => setAnswerIndex((index) => Math.max(0, index - 1))}>
            <ChevronRight size={14} />
          </button>
          <button
            className="icon-button"
            title="Копировать текущий ответ"
            disabled={!activeAnswer}
            onClick={async () => {
              if (!activeAnswer) return;
              await navigator.clipboard.writeText(activeAnswer.answer);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_000);
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button className="icon-button" title="Закрыть Ask" onClick={props.onClose}><X size={14} /></button>
        </div>
      </div>

      <div className="feature-content ask-content">
        {coachOpen && props.coach && (
          <ContextCoach
            coach={props.coach}
            onAsk={props.onAskCoach}
            onNavigateNarrative={props.onNavigateNarrative}
            onOpenProfile={props.onOpenProfile}
          />
        )}
        {activeRequest && <RequestContext request={activeRequest} />}
        {activeAnswer ? (
          <AnswerCard answer={activeAnswer} streaming={isStreaming} />
        ) : (
          <div className="empty-state ask-empty">
            <div className={props.listening ? 'listening-orbit active' : 'listening-orbit'}><MessageSquareText size={25} /></div>
            <h1>{props.listening ? 'Жду вопрос собеседника' : 'Задайте вопрос'}</h1>
            <p>{props.loading ? 'Анализирую контекст' : props.status}</p>
            {!props.authReady && <button className="text-command" onClick={props.onOpenSettings}>Подключить OpenAI</button>}
          </div>
        )}
      </div>
    </>
  );
}

function ContextCoach(props: {
  coach: InterviewCoachPayload;
  onAsk: (question: string) => void;
  onNavigateNarrative: (request: NarrativeNavigationRequest) => void;
  onOpenProfile: () => void;
}) {
  const hasUsefulContext = Boolean(
    props.coach.narrativeProgress || props.coach.narrative || props.coach.relevantFacts.length || props.coach.vacancySignals.length,
  );
  return (
    <section className={props.coach.showNarrative ? 'context-coach narrative-mode' : 'context-coach'}>
      <div className="coach-heading">
        <div>
          <BookOpen size={14} />
          <strong>{props.coach.showNarrative ? 'Подготовленный рассказ' : props.coach.topic}</strong>
        </div>
        <span>{props.coach.profileReady ? 'Профиль' : ''}{props.coach.profileReady && props.coach.vacancyReady ? ' + ' : ''}{props.coach.vacancyReady ? 'Вакансия' : ''}</span>
      </div>

      {props.coach.narrativeProgress ? (
        <NarrativeProgress
          progress={props.coach.narrativeProgress}
          onNavigate={props.onNavigateNarrative}
        />
      ) : props.coach.narrative ? (
        <p className="coach-narrative">{props.coach.narrative}</p>
      ) : null}

      {!props.coach.narrativeProgress && !props.coach.narrative && props.coach.relevantFacts.length > 0 && (
        <div className="coach-facts">
          {props.coach.relevantFacts.map((fact) => (
            <p key={fact.sourceId}><strong>{fact.label}</strong>{fact.excerpt}</p>
          ))}
        </div>
      )}

      {!props.coach.narrativeProgress && !props.coach.narrative && props.coach.vacancySignals.length > 0 && (
        <div className="vacancy-signals">
          <span>Связь с вакансией</span>
          {props.coach.vacancySignals.slice(0, 2).map((signal) => <p key={signal}>{signal}</p>)}
        </div>
      )}

      {props.coach.likelyQuestions.length > 0 && (
        <div className="likely-questions">
          <span>Вероятно спросят дальше</span>
          <div>
            {props.coach.likelyQuestions.slice(0, 3).map((question) => (
              <button key={question} title="Подготовить ответ" onClick={() => props.onAsk(question)}>{question}</button>
            ))}
          </div>
        </div>
      )}

      {!hasUsefulContext && (
        <button className="text-command coach-setup" onClick={props.onOpenProfile}>Заполнить профиль и вакансию</button>
      )}
      {props.coach.alerts.map((alert) => <p className="coach-alert" key={alert}>{alert}</p>)}
    </section>
  );
}

function NarrativeProgress(props: {
  progress: NonNullable<InterviewCoachPayload['narrativeProgress']>;
  onNavigate: (request: NarrativeNavigationRequest) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [props.progress.activeBlockId]);
  const activeIndex = props.progress.blocks.findIndex((block) => block.id === props.progress.activeBlockId);
  const resumeBlock = props.progress.blocks.find((block) => block.id === props.progress.resumeBlockId);

  return (
    <div className="narrative-progress">
      <div className="narrative-status-row">
        <div className="narrative-meter" title={`${props.progress.progressPercent}% рассказа озвучено`}>
          <span style={{ width: `${props.progress.progressPercent}%` }} />
        </div>
        <output>{props.progress.progressPercent}%</output>
        <div className="narrative-controls">
          <button
            className="icon-button small"
            title="Предыдущий блок"
            disabled={activeIndex <= 0}
            onClick={() => props.onNavigate({ action: 'previous' })}
          >
            <ChevronLeft size={13} />
          </button>
          <button
            className="icon-button small"
            title="Следующий блок"
            disabled={activeIndex < 0 || activeIndex >= props.progress.blocks.length - 1}
            onClick={() => props.onNavigate({ action: 'next' })}
          >
            <ChevronRight size={13} />
          </button>
          <button
            className={props.progress.pinnedBlockId ? 'icon-button small pinned' : 'icon-button small'}
            title={props.progress.pinnedBlockId ? 'Включить автоматическое слежение' : 'Закрепить текущий блок'}
            onClick={() => props.onNavigate({ action: props.progress.pinnedBlockId ? 'unpin' : 'pin' })}
          >
            {props.progress.pinnedBlockId ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            className="icon-button small"
            title="Сбросить прогресс рассказа"
            onClick={() => props.onNavigate({ action: 'reset' })}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {props.progress.mode === 'branching' && resumeBlock && (
        <div className="narrative-branch">
          <span>Уточнение</span>
          <p>После ответа: {resumeBlock.title}</p>
        </div>
      )}

      <div className="narrative-track">
        {props.progress.blocks.map((block) => (
          <button
            ref={block.id === props.progress.activeBlockId ? activeRef : undefined}
            className={`narrative-block ${block.status}`}
            key={block.id}
            title={block.status === 'covered' ? `Озвучено на ${block.coverage}%` : block.title}
            onClick={() => props.onNavigate({ action: 'select', blockId: block.id })}
          >
            <span className="narrative-step">{block.status === 'covered' ? <Check size={11} /> : block.index + 1}</span>
            <span className="narrative-block-copy">
              <strong>{block.title}</strong>
              <span>{block.text}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RequestContext(props: { request: AssistantRequestPayload }) {
  return (
    <div className="request-context">
      <div className="request-heading">
        <div className="source-chips">
          {props.request.sources.map((source) => (
            <span className={`source-chip source-${source}`} key={source}>{requestSourceLabel(source)}</span>
          ))}
          {props.request.contextReferences?.map((reference) => (
            <span
              className={`source-chip source-context source-context-${reference.kind}`}
              key={reference.sourceId}
              title={reference.excerpt}
            >
              {contextKindLabel(reference.kind)}
            </span>
          ))}
        </div>
        <span className="request-time">{new Date(props.request.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <p>{props.request.question}</p>
      {props.request.screen && (
        <figure className="request-screen">
          <img src={props.request.screen.dataUrl} alt="Снимок, использованный для ответа" />
          <figcaption><Monitor size={12} /> Анализ экрана · {props.request.screen.displayName}</figcaption>
        </figure>
      )}
    </div>
  );
}

function AnswerCard(props: { answer: AnswerPayload; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const icon = categoryIcon(props.answer.category);
  return (
    <article className={props.streaming ? 'answer-detail streaming' : 'answer-detail'}>
      <div className="answer-meta answer-detail-meta">
        <span className={`category-icon category-${props.answer.category}`}>{icon}</span>
        <div className="answer-question">Подготовленный ответ</div>
        {props.answer.usedScreen && <span className="screen-used"><ImageIcon size={13} /> Экран учтён</span>}
        <button
          className="icon-button small"
          title="Копировать ответ"
          onClick={async () => {
            await navigator.clipboard.writeText(props.answer.answer);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_000);
          }}
        >
          {copied ? <Check size={14} /> : <Clipboard size={14} />}
        </button>
      </div>
      <div className="markdown-answer">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.answer.answer || ' '}</ReactMarkdown>
        {props.streaming && <span className="stream-caret" />}
      </div>
    </article>
  );
}

function TranscriptView(props: { turns: TranscriptTurn[]; listening: boolean }) {
  const ordered = useMemo(() => [...props.turns].reverse(), [props.turns]);
  if (!ordered.length) {
    return (
      <div className="empty-state transcript-empty">
        <div className={props.listening ? 'listening-orbit active' : 'listening-orbit'}>
          <Radio size={27} />
        </div>
        <h1>{props.listening ? 'Жду речь' : 'Транскрипция пуста'}</h1>
        <p>{props.listening ? 'Текст появится сразу после первых слов' : 'Нажмите «Слушать», чтобы начать'}</p>
      </div>
    );
  }

  return (
    <div className="transcript-feed">
      {ordered.map((turn) => (
        <div className={turn.partial ? 'transcript-item partial' : 'transcript-item'} key={turn.id}>
          <span className={`speaker-label ${turn.speaker}`}>{turn.speaker === 'me' ? 'Вы' : 'Собеседник'}</span>
          <span className="transcript-time">
            {new Date(turn.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <p>{turn.text}</p>
          {turn.partial && <span className="partial-label">live</span>}
        </div>
      ))}
    </div>
  );
}

function InsightsView(props: {
  insights: SessionInsightsPayload | null;
  loading: boolean;
  hasConversation: boolean;
  onRefresh: () => void;
  onAsk: (text: string) => void;
}) {
  if (!props.insights) {
    return (
      <div className="empty-state insights-empty">
        <div className={props.loading ? 'listening-orbit active' : 'listening-orbit'}><Lightbulb size={25} /></div>
        <h1>{props.loading ? 'Обновляю выводы' : 'Живые выводы'}</h1>
        <p>Появляются каждые пять реплик и не прерывают разговор</p>
        <button className="secondary-button" onClick={props.onRefresh} disabled={!props.hasConversation || props.loading}>
          <RefreshCw className={props.loading ? 'spin' : undefined} size={14} />
          <span>Обновить сейчас</span>
        </button>
      </div>
    );
  }

  return (
    <div className="insights-view">
      <div className="insights-meta">
        <span>{props.insights.transcriptCount} реплик проанализировано</span>
        <button className="icon-button" title="Обновить живые выводы" onClick={props.onRefresh} disabled={props.loading}>
          <RefreshCw className={props.loading ? 'spin' : undefined} size={14} />
        </button>
      </div>
      <div className="markdown-answer interactive-insights">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            li: ({ children }) => (
              <li>
                <button className="insight-action" title="Открыть в Ask" onClick={() => props.onAsk(reactNodeText(children))}>
                  {children}
                </button>
              </li>
            ),
          }}
        >
          {props.insights.text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function SummaryView(props: {
  summary: SessionSummaryPayload | null;
  loading: boolean;
  hasConversation: boolean;
  phase: SessionPhase;
  onGenerate: () => void;
  onAsk: (text: string) => void;
}) {
  if (!props.summary) {
    return (
      <div className="empty-state summary-empty">
        <div className={props.loading ? 'listening-orbit active' : 'listening-orbit'}>
          <FileText size={27} />
        </div>
        <h1>{props.loading ? 'Формирую итоги' : 'Итоги текущей сессии'}</h1>
        <p>{props.loading ? 'Анализирую полный разговор и ответы' : 'Завершите сессию, чтобы зафиксировать финальный результат'}</p>
        <button className="primary-button" onClick={props.onGenerate} disabled={!props.hasConversation || props.loading}>
          {props.loading ? <RefreshCw className="spin" size={15} /> : <FileText size={15} />}
          <span>{props.phase === 'finished' ? 'Обновить итоги' : 'Предпросмотр итогов'}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="summary-view">
      <article className={props.summary.partial ? 'answer-card streaming' : 'answer-card'}>
        <div className="answer-meta">
          <span>{props.summary.transcriptCount} реплик</span>
          <span>{props.summary.answerCount} ответов</span>
          <button className="icon-button" title="Обновить итоги" onClick={props.onGenerate} disabled={props.loading}>
            <RefreshCw className={props.loading ? 'spin' : undefined} size={14} />
          </button>
        </div>
        <div className="markdown-answer interactive-summary">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              li: ({ children }) => (
                <li>
                  <button className="insight-action" title="Открыть пункт в Ask" onClick={() => props.onAsk(reactNodeText(children))}>
                    {children}
                  </button>
                </li>
              ),
            }}
          >
            {props.summary.text}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
}

function Composer(props: {
  question: string;
  loading: boolean;
  includeScreen: boolean;
  preview: ScreenCapturePayload | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onQuestionChange: (value: string) => void;
  onToggleScreen: () => void;
  onSend: () => void;
}) {
  return (
    <div className={props.includeScreen && props.preview ? 'composer has-preview' : 'composer'}>
      {props.includeScreen && props.preview && <img className="composer-preview" src={props.preview.dataUrl} alt="Экран" />}
      <button
        className={props.includeScreen ? 'composer-tool active' : 'composer-tool'}
        title={props.includeScreen ? 'Убрать экран из запроса' : 'Добавить экран к запросу'}
        onClick={props.onToggleScreen}
      >
        <Monitor size={17} />
      </button>
      <input
        ref={props.inputRef}
        value={props.question}
        placeholder="Задать вопрос..."
        title="Текстовый вопрос — Ctrl+Shift+Q, умный запрос — Ctrl+Enter"
        onChange={(event) => props.onQuestionChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void props.onSend();
          }
        }}
      />
      <button className="send-control" title="Отправить" onClick={props.onSend} disabled={!props.question.trim() || props.loading}>
        {props.loading ? <Sparkles size={16} /> : <Send size={16} />}
      </button>
    </div>
  );
}

function SettingsView(props: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  auth: AuthState;
  settings: AppSettings;
  codexModels: CodexModel[];
  apiKey: string;
  apiBusy: boolean;
  codexBusy: boolean;
  listening: boolean;
  interviewContext: InterviewContextState;
  contextBusy: boolean;
  onApiKeyChange: (value: string) => void;
  onSaveApiKey: () => void;
  onClearApiKey: () => void;
  onConnectCodex: () => void;
  onDisconnectCodex: () => void;
  onRefreshAuth: () => void;
  onOpenApiKeys: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onSaveInterviewContext: (candidate: Partial<InterviewContextState>) => Promise<InterviewContextState>;
  onImportInterviewFile: (
    kind: InterviewContextDocumentKind,
    draft: InterviewContextState,
  ) => Promise<InterviewContextState>;
  onRemoveInterviewDocument: (documentId: string, draft: InterviewContextState) => Promise<InterviewContextState>;
  onClearInterviewContext: () => Promise<InterviewContextState>;
}) {
  return (
    <div className="settings-page">
      <nav className="settings-tabs" aria-label="Разделы настроек">
        <SettingsTabButton active={props.tab === 'connection'} icon={<KeyRound size={15} />} label="Подключение" onClick={() => props.onTabChange('connection')} />
        <SettingsTabButton active={props.tab === 'profile'} icon={<UserRoundCog size={15} />} label="Профиль" onClick={() => props.onTabChange('profile')} />
        <SettingsTabButton active={props.tab === 'audio'} icon={<Volume2 size={15} />} label="Аудио" onClick={() => props.onTabChange('audio')} />
        <SettingsTabButton active={props.tab === 'privacy'} icon={<ShieldCheck size={15} />} label="Приватность" onClick={() => props.onTabChange('privacy')} />
      </nav>

      {props.tab === 'connection' && (
        <div className="settings-scroll">
          <SettingsSection title="Провайдер ответов" description="Codex использует вход ChatGPT; API работает по отдельному ключу.">
            <Segmented
              value={props.settings.answerProvider}
              options={[
                { value: 'codex', label: 'Codex OAuth', icon: <Bot size={15} /> },
                { value: 'openai-api', label: 'OpenAI API', icon: <KeyRound size={15} /> },
              ]}
              onChange={(value) => props.onUpdateSettings({ answerProvider: value as AppSettings['answerProvider'] })}
            />
          </SettingsSection>

          <SettingsSection title="OpenAI Codex" description="Официальный вход через браузер; токены хранит Codex.">
            <div className={props.auth.hasCodexAuth ? 'connection-row connected' : 'connection-row'}>
              <span className="connection-icon"><Bot size={18} /></span>
              <div className="connection-copy">
                <strong>{props.auth.hasCodexAuth ? props.auth.codexEmail || 'ChatGPT подключён' : 'ChatGPT / Codex'}</strong>
                <span>
                  {props.auth.hasCodexAuth
                    ? [props.auth.codexPlan, props.auth.codexStatus, props.auth.codexVersion && `CLI ${props.auth.codexVersion}`]
                        .filter(Boolean)
                        .join(' · ')
                    : props.auth.codexError || 'Требуется вход'}
                </span>
              </div>
              <button className="icon-button" title="Обновить статус" onClick={props.onRefreshAuth} disabled={props.codexBusy}>
                <RefreshCw size={15} />
              </button>
              {props.auth.hasCodexAuth ? (
                <button className="secondary-button" onClick={props.onDisconnectCodex} disabled={props.codexBusy}>
                  <LogOut size={15} />
                  <span>Выйти</span>
                </button>
              ) : (
                <button className="primary-button" onClick={props.onConnectCodex} disabled={props.codexBusy}>
                  {props.codexBusy ? <RefreshCw className="spin" size={15} /> : <LogIn size={15} />}
                  <span>Войти</span>
                </button>
              )}
            </div>
          </SettingsSection>

          <SettingsSection title="OpenAI API" description="Нужен для realtime-транскрипции; расходы идут через Platform API.">
            {props.auth.hasApiKey ? (
              <div className="connection-row connected">
                <span className="connection-icon"><Check size={18} /></span>
                <div className="connection-copy">
                  <strong>API подключён</strong>
                  <span>{props.auth.maskedKey}</span>
                </div>
                <button className="secondary-button danger-button" onClick={props.onClearApiKey}>
                  <LogOut size={15} />
                  <span>Удалить</span>
                </button>
              </div>
            ) : (
              <div className="key-entry">
                <input
                  type="password"
                  value={props.apiKey}
                  placeholder="sk-..."
                  onChange={(event) => props.onApiKeyChange(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && props.onSaveApiKey()}
                />
                <button className="primary-button" onClick={props.onSaveApiKey} disabled={!props.apiKey.trim() || props.apiBusy}>
                  {props.apiBusy ? <RefreshCw className="spin" size={15} /> : <KeyRound size={15} />}
                  <span>Сохранить</span>
                </button>
                <button className="icon-button" title="Открыть страницу API keys" onClick={props.onOpenApiKeys}>
                  <Monitor size={15} />
                </button>
              </div>
            )}
          </SettingsSection>

          <SettingsSection title="Модель ответа">
            <label className="field-label">
              <span>{props.settings.answerProvider === 'codex' ? 'Модель Codex' : 'Модель API'}</span>
              <select
                value={props.settings.answerProvider === 'codex' ? props.settings.codexModel : props.settings.model}
                onChange={(event) =>
                  props.onUpdateSettings(
                    props.settings.answerProvider === 'codex'
                      ? { codexModel: event.target.value }
                      : { model: event.target.value },
                  )
                }
              >
                {props.settings.answerProvider === 'codex'
                  ? codexModelOptions(props.settings.codexModel, props.codexModels).map((model) => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))
                  : uniqueStrings(props.settings.model, API_MODEL_OPTIONS).map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
              </select>
            </label>
          </SettingsSection>
        </div>
      )}

      {props.tab === 'profile' && (
        <div className="settings-scroll">
          <InterviewContextEditor
            value={props.interviewContext}
            busy={props.contextBusy}
            onSave={props.onSaveInterviewContext}
            onImport={props.onImportInterviewFile}
            onRemoveDocument={props.onRemoveInterviewDocument}
            onClear={props.onClearInterviewContext}
          />

          <SettingsSection title="Специализация" description="Профиль меняет структуру и акценты ответа.">
            <div className="profile-grid">
              {(['developer', 'aqa', 'manual-qa', 'load-qa', 'general', 'custom'] as InterviewProfile[]).map((profile) => (
                <button
                  key={profile}
                  className={props.settings.profile === profile ? 'profile-option active' : 'profile-option'}
                  onClick={() => props.onUpdateSettings({ profile })}
                >
                  {profileIcon(profile)}
                  <span>{PROFILE_LABELS[profile]}</span>
                </button>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection title="Формат ответа">
            <div className="two-fields">
              <label className="field-label">
                <span>Подробность</span>
                <Segmented
                  value={props.settings.answerDetail}
                  options={[
                    { value: 'brief', label: 'Кратко' },
                    { value: 'balanced', label: 'Баланс' },
                    { value: 'detailed', label: 'Подробно' },
                  ]}
                  onChange={(value) => props.onUpdateSettings({ answerDetail: value as AnswerDetail })}
                />
              </label>
              <label className="field-label">
                <span>Глубина рассуждения</span>
                <Segmented
                  value={props.settings.reasoningEffort}
                  options={[
                    { value: 'low', label: 'Быстро' },
                    { value: 'medium', label: 'Средне' },
                    { value: 'high', label: 'Глубоко' },
                  ]}
                  onChange={(value) => props.onUpdateSettings({ reasoningEffort: value as ReasoningEffort })}
                />
              </label>
            </div>
          </SettingsSection>

          <SettingsSection title="Персональные инструкции" description="Например: стек, уровень, желаемый стиль и темы собеседования.">
            <textarea
              className="instructions-input"
              value={props.settings.customInstructions}
              placeholder="Мой стек: TypeScript, Playwright, REST API..."
              onChange={(event) => props.onUpdateSettings({ customInstructions: event.target.value })}
            />
          </SettingsSection>
        </div>
      )}

      {props.tab === 'audio' && (
        <div className="settings-scroll">
          <SettingsSection title="Источник звука">
            <Segmented
              value={props.settings.captureSource}
              options={[
                { value: 'both', label: 'Оба источника', icon: <AudioLines size={15} /> },
                { value: 'system', label: 'Системный звук', icon: <Volume2 size={15} /> },
                { value: 'microphone', label: 'Микрофон', icon: <Mic size={15} /> },
              ]}
              onChange={(value) => props.onUpdateSettings({ captureSource: value as AppSettings['captureSource'] })}
              disabled={props.listening}
            />
          </SettingsSection>

          <SettingsSection title="Распознавание">
            <div className="two-fields">
              <label className="field-label">
                <span>Модель</span>
                <select value={props.settings.transcriptionModel} disabled>
                  <option value="gpt-realtime-whisper">GPT-Realtime-Whisper</option>
                </select>
              </label>
              <label className="field-label">
                <span>Язык</span>
                <select value={props.settings.language} onChange={(event) => props.onUpdateSettings({ language: event.target.value })}>
                  <option value="ru">Русский</option>
                  <option value="en">English</option>
                  <option value="auto">Авто</option>
                </select>
              </label>
            </div>
            <label className="field-label">
              <span>Задержка / точность</span>
              <Segmented
                value={props.settings.transcriptionDelay}
                options={[
                  { value: 'minimal', label: 'Минимум' },
                  { value: 'low', label: 'Низкая' },
                  { value: 'medium', label: 'Баланс' },
                  { value: 'high', label: 'Точно' },
                ]}
                onChange={(value) => props.onUpdateSettings({ transcriptionDelay: value as TranscriptionDelay })}
                disabled={props.listening}
              />
            </label>
          </SettingsSection>

          <SettingsSection title="Автоматические ответы">
            <ToggleRow
              checked={props.settings.autoAnswer}
              title="Отвечать на найденные вопросы"
              description="Вопрос определяется по завершённой фразе."
              onChange={(checked) => props.onUpdateSettings({ autoAnswer: checked })}
            />
            <label className="range-field">
              <span>Пауза между ответами</span>
              <input
                type="range"
                min="2000"
                max="20000"
                step="500"
                value={props.settings.answerCooldownMs}
                onChange={(event) => props.onUpdateSettings({ answerCooldownMs: Number(event.target.value) })}
              />
              <output>{(props.settings.answerCooldownMs / 1000).toFixed(1)} с</output>
            </label>
          </SettingsSection>
        </div>
      )}

      {props.tab === 'privacy' && (
        <div className="settings-scroll">
          <SettingsSection title="Контекст экрана" description="Снимок создаётся только локально перед запросом и сразу удаляется.">
            <Segmented
              value={props.settings.screenContext}
              options={[
                { value: 'off', label: 'Выкл.' },
                { value: 'smart', label: 'Умный' },
                { value: 'always', label: 'Всегда' },
              ]}
              onChange={(value) => props.onUpdateSettings({ screenContext: value as ScreenContextMode })}
            />
          </SettingsSection>

          <SettingsSection title="Защита окна">
            <ToggleRow
              checked={props.settings.captureProtection}
              title="Исключать оверлей из захвата"
              description="Использует системную защиту Electron/Windows."
              onChange={(checked) => props.onUpdateSettings({ captureProtection: checked })}
            />
            <ToggleRow
              checked={props.settings.hideTrayWhileListening}
              title="Скрывать значок трея во время прослушивания"
              description="Окно остаётся доступным через глобальную горячую клавишу."
              onChange={(checked) => props.onUpdateSettings({ hideTrayWhileListening: checked })}
            />
            <ToggleRow
              checked={props.settings.startInTray}
              title="Следующие запуски начинать в трее"
              description="Первый запуск всегда показывает настройку."
              onChange={(checked) => props.onUpdateSettings({ startInTray: checked })}
            />
          </SettingsSection>

          <div className="privacy-note">
            <ShieldCheck size={18} />
            <p>Ключ API шифруется через Windows DPAPI. Codex OAuth обслуживается официальным Codex App Server.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function InterviewContextEditor(props: {
  value: InterviewContextState;
  busy: boolean;
  onSave: (candidate: Partial<InterviewContextState>) => Promise<InterviewContextState>;
  onImport: (kind: InterviewContextDocumentKind, draft: InterviewContextState) => Promise<InterviewContextState>;
  onRemoveDocument: (documentId: string, draft: InterviewContextState) => Promise<InterviewContextState>;
  onClear: () => Promise<InterviewContextState>;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const dirty = useMemo(
    () => interviewContextSignature(draft) !== interviewContextSignature(props.value),
    [draft, props.value],
  );
  const update = (patch: Partial<InterviewContextState>) => setDraft((current) => ({ ...current, ...patch }));
  const importFile = (kind: InterviewContextDocumentKind) => {
    void props.onImport(kind, draft).then(setDraft).catch(() => undefined);
  };

  return (
    <>
      <SettingsSection
        title="Профиль интервью"
        description="Локальная база фактов связывает ваш опыт, вакансию и текущий разговор."
      >
        <ToggleRow
          checked={draft.enabled}
          title="Учитывать профиль в ответах"
          description="В модель отправляются только фрагменты, связанные с текущим вопросом."
          onChange={(enabled) => update({ enabled })}
        />
        <ToggleRow
          checked={draft.predictiveAssist}
          title="Предсказывать следующие вопросы"
          description="Карточка справа обновляется локально после реплик собеседника."
          onChange={(predictiveAssist) => update({ predictiveAssist })}
        />
        <ToggleRow
          checked={draft.strictFacts}
          title="Не придумывать личный опыт"
          description="Если подтверждённого факта нет, помощник предложит честную нейтральную формулировку."
          onChange={(strictFacts) => update({ strictFacts })}
        />
        <label className="field-label">
          <span>Стиль подготовленного ответа</span>
          <Segmented
            value={draft.answerStyle}
            options={[
              { value: 'natural', label: 'Естественно' },
              { value: 'concise', label: 'Кратко' },
              { value: 'star', label: 'STAR' },
              { value: 'technical', label: 'Технически' },
            ]}
            onChange={(answerStyle) => update({ answerStyle: answerStyle as InterviewAnswerStyle })}
          />
        </label>
      </SettingsSection>

      <SettingsSection title="О вас" description="Подготовленный рассказ, реальные проекты, роль, действия и результаты.">
        <div className="context-title-row">
          <input
            value={draft.candidateTitle}
            placeholder="Например: Senior AQA"
            onChange={(event) => update({ candidateTitle: event.target.value })}
          />
          <button className="secondary-button" onClick={() => importFile('candidate')} disabled={props.busy}>
            <FileUp size={14} />
            <span>Файл</span>
          </button>
        </div>
        <textarea
          className="context-textarea candidate-context-input"
          value={draft.candidateText}
          placeholder="Расскажите о себе в подготовленном формате: опыт, проекты, обязанности, сложные ситуации и измеримые результаты..."
          onChange={(event) => update({ candidateText: event.target.value })}
        />
      </SettingsSection>

      <SettingsSection title="Вакансия" description="Требования роли, обязанности, компания и важные акценты.">
        <div className="context-title-row">
          <input
            value={draft.vacancyTitle}
            placeholder="Название вакансии"
            onChange={(event) => update({ vacancyTitle: event.target.value })}
          />
          <button className="secondary-button" onClick={() => importFile('vacancy')} disabled={props.busy}>
            <FileUp size={14} />
            <span>Файл</span>
          </button>
        </div>
        <textarea
          className="context-textarea"
          value={draft.vacancyText}
          placeholder="Вставьте описание вакансии целиком..."
          onChange={(event) => update({ vacancyText: event.target.value })}
        />
      </SettingsSection>

      <SettingsSection
        title="Материалы"
        description="PDF, DOCX, текст, а также аудио или видео прошлых интервью. Записи расшифровываются через OpenAI API."
      >
        <div className="material-actions">
          <button className="secondary-button" onClick={() => importFile('interview')} disabled={props.busy}>
            <FileUp size={14} />
            <span>Добавить интервью</span>
          </button>
          <span>{draft.documents.length ? `${draft.documents.length} материалов` : 'Материалов пока нет'}</span>
        </div>
        {draft.documents.length > 0 && (
          <div className="material-list">
            {draft.documents.map((document) => (
              <div className="material-row" key={document.id}>
                <span className={`material-kind material-${document.kind}`}><FileText size={13} /></span>
                <div>
                  <strong>{document.name}</strong>
                  <span>{contextKindLabel(document.kind)} · {sourceTypeLabel(document.sourceType)} · {formatCharacters(document.content.length)}</span>
                </div>
                <button
                  className="icon-button small"
                  title="Удалить материал"
                  disabled={props.busy}
                  onClick={() => void props.onRemoveDocument(document.id, draft).then(setDraft).catch(() => undefined)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <div className="context-save-bar">
        <span>{props.value.updatedAt ? `Сохранено ${new Date(props.value.updatedAt).toLocaleString('ru-RU')}` : 'Данные ещё не сохранены'}</span>
        <button
          className="secondary-button danger-button"
          disabled={props.busy || !hasInterviewContextContent(draft)}
          onClick={() => {
            if (!window.confirm('Очистить профиль, вакансию и все загруженные материалы?')) return;
            void props.onClear().then(setDraft).catch(() => undefined);
          }}
        >
          <Trash2 size={14} />
          <span>Очистить</span>
        </button>
        <button
          className="primary-button"
          disabled={props.busy || !dirty}
          onClick={() => void props.onSave(draft).then(setDraft).catch(() => undefined)}
        >
          {props.busy ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}
          <span>Сохранить</span>
        </button>
      </div>
    </>
  );
}

function SettingsTabButton(props: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={props.active ? 'settings-tab active' : 'settings-tab'} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function SettingsSection(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h2>{props.title}</h2>
        {props.description && <p>{props.description}</p>}
      </div>
      <div className="section-content">{props.children}</div>
    </section>
  );
}

function Segmented(props: {
  value: string;
  options: Array<{ value: string; label: string; icon?: ReactNode }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented-control">
      {props.options.map((option) => (
        <button
          key={option.value}
          className={props.value === option.value ? 'active' : ''}
          onClick={() => props.onChange(option.value)}
          disabled={props.disabled}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function ToggleRow(props: {
  checked: boolean;
  title: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <div>
        <strong>{props.title}</strong>
        <span>{props.description}</span>
      </div>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="toggle-track"><span /></span>
    </label>
  );
}

function phaseLabel(phase: SessionPhase, fallback: string): string {
  if (phase === 'listening') return 'Слушаю';
  if (phase === 'paused') return 'Пауза';
  if (phase === 'finishing') return 'Формирую итоги';
  if (phase === 'finished') return 'Сессия завершена';
  return fallback;
}

function requestSourceLabel(source: AssistantRequestPayload['sources'][number]): string {
  if (source === 'audio') return 'Аудио';
  if (source === 'screen') return 'Экран';
  return 'Текст';
}

function requestTriggerLabel(trigger: AssistantRequestPayload['trigger']): string {
  if (trigger === 'auto') return 'Вопрос собеседника';
  if (trigger === 'hotkey') return 'Умный запрос Ctrl+Enter';
  if (trigger === 'insight') return 'Запрос из живых выводов';
  if (trigger === 'coach') return 'Подготовка по профилю';
  return 'Ручной вопрос';
}

function contextKindLabel(kind: InterviewContextDocumentKind): string {
  if (kind === 'candidate') return 'Профиль';
  if (kind === 'vacancy') return 'Вакансия';
  return 'Интервью';
}

function sourceTypeLabel(sourceType: InterviewContextState['documents'][number]['sourceType']): string {
  if (sourceType === 'media') return 'расшифровка';
  if (sourceType === 'document') return 'документ';
  return 'текст';
}

function formatCharacters(length: number): string {
  return length >= 1_000 ? `${(length / 1_000).toFixed(1)} тыс. знаков` : `${length} знаков`;
}

function hasInterviewContextContent(context: InterviewContextState): boolean {
  return Boolean(context.candidateText.trim() || context.vacancyText.trim() || context.documents.length);
}

function interviewContextSignature(context: InterviewContextState): string {
  return JSON.stringify({
    enabled: context.enabled,
    predictiveAssist: context.predictiveAssist,
    strictFacts: context.strictFacts,
    answerStyle: context.answerStyle,
    candidateTitle: context.candidateTitle,
    candidateText: context.candidateText,
    vacancyTitle: context.vacancyTitle,
    vacancyText: context.vacancyText,
    documents: context.documents,
  });
}

function reactNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) return reactNodeText(node.props.children);
  return '';
}

function categoryIcon(category: AnswerPayload['category']): ReactNode {
  if (category === 'code') return <Code2 size={15} />;
  if (category === 'testing') return <Bug size={15} />;
  if (category === 'system-design') return <Gauge size={15} />;
  if (category === 'screen') return <Monitor size={15} />;
  return <Sparkles size={15} />;
}

function profileIcon(profile: InterviewProfile): ReactNode {
  if (profile === 'developer') return <Code2 size={17} />;
  if (profile === 'aqa') return <Bot size={17} />;
  if (profile === 'manual-qa') return <Bug size={17} />;
  if (profile === 'load-qa') return <Gauge size={17} />;
  if (profile === 'custom') return <Settings2 size={17} />;
  return <Sparkles size={17} />;
}

function codexModelOptions(current: string, models: CodexModel[]): Array<{ id: string; name: string }> {
  if (models.length) {
    const normalized = models.map((model) => ({ id: model.id, name: model.name || model.id }));
    return normalized.some((model) => model.id === current) ? normalized : [{ id: current, name: current }, ...normalized];
  }
  return uniqueStrings(current, FALLBACK_CODEX_MODELS).map((id) => ({ id, name: id }));
}

function uniqueStrings(current: string, values: string[]): string[] {
  return Array.from(new Set([current, ...values].filter(Boolean)));
}
