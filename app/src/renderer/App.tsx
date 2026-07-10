import {
  AudioLines,
  Bot,
  Bug,
  Check,
  Clipboard,
  Code2,
  Copy,
  EyeOff,
  Gauge,
  Image as ImageIcon,
  KeyRound,
  LogIn,
  LogOut,
  MessageSquareText,
  Mic,
  MicOff,
  Minus,
  Monitor,
  Radio,
  RefreshCw,
  ScrollText,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRoundCog,
  Volume2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CodexModel } from '../main/codexService';
import { PROFILE_LABELS } from '../main/defaults';
import type {
  AnswerDetail,
  AnswerPayload,
  AppSettings,
  AuthState,
  InterviewProfile,
  ReasoningEffort,
  ScreenCapturePayload,
  ScreenContextMode,
  TranscriptTurn,
  TranscriptionDelay,
} from '../main/types';
import { AudioCapture } from './audioCapture';

const APP_NAME = 'RepGlass';
const API_KEYS_URL = 'https://platform.openai.com/api-keys';
const API_MODEL_OPTIONS = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5'];
const FALLBACK_CODEX_MODELS = ['gpt-5.4-mini', 'gpt-5.5'];

type View = 'answers' | 'transcript' | 'settings';
type SettingsTab = 'connection' | 'profile' | 'audio' | 'privacy';

export function App() {
  const capture = useRef(new AudioCapture());
  const toggleListenRef = useRef<() => void>(() => undefined);
  const [auth, setAuth] = useState<AuthState>({ mode: 'none', hasApiKey: false, hasCodexAuth: false });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [view, setView] = useState<View>('answers');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection');
  const [status, setStatus] = useState('Готово');
  const [errorMessage, setErrorMessage] = useState('');
  const [listening, setListening] = useState(false);
  const [loadingAnswer, setLoadingAnswer] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiBusy, setApiBusy] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [includeScreen, setIncludeScreen] = useState(false);
  const [screenPreview, setScreenPreview] = useState<ScreenCapturePayload | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [answers, setAnswers] = useState<AnswerPayload[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState<AnswerPayload | null>(null);

  useEffect(() => {
    const audioCapture = capture.current;
    void Promise.all([window.glass.auth.getState(), window.glass.settings.get()])
      .then(([nextAuth, nextSettings]) => {
        setAuth(nextAuth);
        setSettings(nextSettings);
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
    const offTranscript = window.glass.events.onTranscript((turn) => {
      setTranscript((current) => {
        const existingIndex = current.findIndex((item) => item.id === turn.id);
        if (existingIndex < 0) return [...current.slice(-99), turn];
        const next = [...current];
        next[existingIndex] = turn;
        return next;
      });
    });
    const offAskState = window.glass.events.onAskState((payload) => setLoadingAnswer(payload.loading));
    const offAnswerDelta = window.glass.events.onAnswerDelta((payload) => {
      setView('answers');
      setStreamingAnswer({ ...payload, createdAt: Date.now() });
    });
    const offAnswer = window.glass.events.onAnswer((answer) => {
      setView('answers');
      setStreamingAnswer(null);
      setAnswers((current) => [answer, ...current.filter((item) => item.id !== answer.id)].slice(0, 20));
    });
    const offPreview = window.glass.events.onScreenPreview(setScreenPreview);
    const offToggle = window.glass.events.onListenToggleRequested(() => toggleListenRef.current());
    const offNavigation = window.glass.events.onNavigation((payload) => setView(payload.view));
    const offCleared = window.glass.events.onSessionCleared(() => {
      setTranscript([]);
      setAnswers([]);
      setStreamingAnswer(null);
      setScreenPreview(null);
    });

    return () => {
      offStatus();
      offError();
      offListen();
      offTranscript();
      offAskState();
      offAnswerDelta();
      offAnswer();
      offPreview();
      offToggle();
      offNavigation();
      offCleared();
      audioCapture.stop();
    };
  }, []);

  const answerAuthReady = Boolean(
    settings && (settings.answerProvider === 'codex' ? auth.hasCodexAuth : auth.hasApiKey),
  );
  const latestAnswer = streamingAnswer || answers[0];
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

    setErrorMessage('');
    const result = await window.glass.listen.start();
    if (!result.success) {
      setErrorMessage(result.error || 'Не удалось начать прослушивание');
      return;
    }

    try {
      await capture.current.start(
        settings,
        (payload) => window.glass.listen.sendAudioChunk(payload),
        () => window.glass.listen.commitAudio(),
      );
    } catch (error) {
      await window.glass.listen.stop();
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось получить аудио');
    }
  }, [auth.hasApiKey, settings]);

  const stopListening = useCallback(async () => {
    capture.current.stop();
    await window.glass.listen.stop();
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
    setErrorMessage('');
    try {
      await window.glass.ask.send({ question: trimmed, includeScreen });
      setIncludeScreen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Не удалось получить ответ');
    }
  }, [answerAuthReady, includeScreen, loadingAnswer, question, settings]);

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

  const copyLatest = useCallback(async () => {
    if (!latestAnswer) return;
    await navigator.clipboard.writeText(latestAnswer.answer);
    setCopyState('copied');
    window.setTimeout(() => setCopyState('idle'), 1_200);
  }, [latestAnswer]);

  const clearSession = useCallback(async () => {
    await window.glass.session.clear();
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

  return (
    <main className="app-stage">
      <header className="command-capsule">
        <button className={`listen-control ${listening ? 'active' : ''}`} onClick={listening ? stopListening : startListening}>
          {listening ? <MicOff size={15} /> : <Mic size={15} />}
          <span>{listening ? 'Стоп' : 'Слушать'}</span>
          {listening && <span className="live-dot" />}
        </button>

        <nav className="view-switcher" aria-label="Разделы">
          <ViewButton active={view === 'answers'} label="Ответы" icon={<MessageSquareText size={15} />} onClick={() => setView('answers')} />
          <ViewButton active={view === 'transcript'} label="Текст" icon={<ScrollText size={15} />} onClick={() => setView('transcript')} />
          <ViewButton active={view === 'settings'} label="Настройки" icon={<SlidersHorizontal size={15} />} onClick={() => setView('settings')} />
        </nav>

        <div className="capsule-spacer" />
        <span className="privacy-indicator" title="Окно защищено от захвата экрана">
          <EyeOff size={15} />
        </span>
        <button className="icon-button capsule-hide" title="Скрыть" onClick={() => window.glass.window.hide()}>
          <Minus size={16} />
        </button>
      </header>

      <section className="workspace-panel">
        <div className="workspace-head">
          <div className="workspace-title">
            <span className="brand-mark" />
            <div>
              <strong>{viewTitle(view)}</strong>
              <span className={errorMessage ? 'status error-status' : 'status'}>{errorMessage || status}</span>
            </div>
          </div>
          <div className="workspace-tools">
            {view !== 'settings' && activeModelLabel && (
              <span className="model-label">
                <Bot size={13} />
                {activeModelLabel}
              </span>
            )}
            {view === 'answers' && (
              <button className="icon-button" title="Копировать последний ответ" onClick={copyLatest} disabled={!latestAnswer}>
                {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
              </button>
            )}
            {view !== 'settings' && (
              <button className="icon-button" title="Очистить сессию" onClick={clearSession} disabled={!answers.length && !transcript.length}>
                <Trash2 size={15} />
              </button>
            )}
            <button className="icon-button" title="Настройки" onClick={() => setView('settings')}>
              <Settings2 size={15} />
            </button>
            <button className="icon-button" title="Скрыть" onClick={() => window.glass.window.hide()}>
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="workspace-body">
          {view === 'answers' && (
            <AnswersView
              answers={answers}
              streaming={streamingAnswer}
              loading={loadingAnswer}
              listening={listening}
              status={status}
              authReady={answerAuthReady}
              screenPreview={screenPreview}
              onOpenSettings={() => {
                setView('settings');
                setSettingsTab('connection');
              }}
            />
          )}
          {view === 'transcript' && <TranscriptView turns={transcript} listening={listening} />}
          {view === 'settings' && (
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
              onApiKeyChange={setApiKey}
              onSaveApiKey={saveApiKey}
              onClearApiKey={clearApiKey}
              onConnectCodex={connectCodex}
              onDisconnectCodex={disconnectCodex}
              onRefreshAuth={refreshAuth}
              onOpenApiKeys={() => window.glass.window.openExternal(API_KEYS_URL)}
              onUpdateSettings={updateSettings}
            />
          )}
        </div>

        {view !== 'settings' && (
          <Composer
            question={question}
            loading={loadingAnswer}
            includeScreen={includeScreen}
            preview={screenPreview}
            onQuestionChange={setQuestion}
            onToggleScreen={toggleScreen}
            onSend={sendQuestion}
          />
        )}
      </section>
    </main>
  );
}

function ViewButton(props: { active: boolean; label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button className={props.active ? 'view-button active' : 'view-button'} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function AnswersView(props: {
  answers: AnswerPayload[];
  streaming: AnswerPayload | null;
  loading: boolean;
  listening: boolean;
  status: string;
  authReady: boolean;
  screenPreview: ScreenCapturePayload | null;
  onOpenSettings: () => void;
}) {
  const visibleAnswers = props.streaming
    ? [props.streaming, ...props.answers.filter((answer) => answer.id !== props.streaming?.id)]
    : props.answers;

  if (!visibleAnswers.length) {
    return (
      <div className="empty-state">
        <div className={props.listening ? 'listening-orbit active' : 'listening-orbit'}>
          <AudioLines size={28} />
        </div>
        <h1>{props.listening ? 'Слушаю разговор' : 'Готов к работе'}</h1>
        <p>{props.loading ? 'Готовлю первый ответ' : props.status}</p>
        {!props.authReady && (
          <button className="text-command" onClick={props.onOpenSettings}>
            Подключить OpenAI
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="answer-feed">
      {props.screenPreview && (
        <div className="screen-context-strip">
          <img src={props.screenPreview.dataUrl} alt="Контекст экрана" />
          <div>
            <span>Контекст экрана</span>
            <small>{props.screenPreview.displayName}</small>
          </div>
          <ShieldCheck size={15} />
        </div>
      )}
      {visibleAnswers.map((answer, index) => (
        <AnswerCard key={answer.id} answer={answer} streaming={index === 0 && props.streaming?.id === answer.id} />
      ))}
    </div>
  );
}

function AnswerCard(props: { answer: AnswerPayload; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const icon = categoryIcon(props.answer.category);
  return (
    <article className={props.streaming ? 'answer-card streaming' : 'answer-card'}>
      <div className="answer-meta">
        <span className={`category-icon category-${props.answer.category}`}>{icon}</span>
        <div className="answer-question">{props.answer.question}</div>
        {props.answer.usedScreen && <ImageIcon size={14} className="screen-used" />}
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

function Composer(props: {
  question: string;
  loading: boolean;
  includeScreen: boolean;
  preview: ScreenCapturePayload | null;
  onQuestionChange: (value: string) => void;
  onToggleScreen: () => void;
  onSend: () => void;
}) {
  return (
    <div className="composer">
      {props.includeScreen && props.preview && <img className="composer-preview" src={props.preview.dataUrl} alt="Экран" />}
      <button
        className={props.includeScreen ? 'composer-tool active' : 'composer-tool'}
        title={props.includeScreen ? 'Убрать экран из запроса' : 'Добавить экран к запросу'}
        onClick={props.onToggleScreen}
      >
        <Monitor size={17} />
      </button>
      <input
        value={props.question}
        placeholder="Задать вопрос..."
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
  onApiKeyChange: (value: string) => void;
  onSaveApiKey: () => void;
  onClearApiKey: () => void;
  onConnectCodex: () => void;
  onDisconnectCodex: () => void;
  onRefreshAuth: () => void;
  onOpenApiKeys: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
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

function viewTitle(view: View): string {
  if (view === 'transcript') return 'Транскрипция';
  if (view === 'settings') return 'Настройки';
  return 'Живые ответы';
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
