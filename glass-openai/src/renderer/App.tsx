import {
  AudioLines,
  Bot,
  Check,
  Copy,
  EyeOff,
  KeyRound,
  Keyboard,
  LogIn,
  Mic,
  MicOff,
  Minus,
  MoreVertical,
  RefreshCw,
  Send,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioCapture } from './audioCapture';
import type { AnswerPayload, AppSettings, AuthState, TranscriptTurn } from '../main/types';

const APP_NAME = 'RepGlass';
const docsUrl = 'https://platform.openai.com/api-keys';
const modelOptions = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'];
const codexModelOptions = ['gpt-5.5', 'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5'];
const transcriptionOptions = ['gpt-realtime-whisper'];

type PanelMode = 'insights' | 'ask';

export function App() {
  const capture = useRef(new AudioCapture());
  const [auth, setAuth] = useState<AuthState>({ mode: 'none', hasApiKey: false, hasCodexAuth: false });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState('Ready');
  const [listening, setListening] = useState(false);
  const [loadingAnswer, setLoadingAnswer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>('insights');
  const [apiKey, setApiKey] = useState('');
  const [apiError, setApiError] = useState('');
  const [question, setQuestion] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [answers, setAnswers] = useState<AnswerPayload[]>([]);

  useEffect(() => {
    void Promise.all([window.glass.auth.getState(), window.glass.settings.get()])
      .then(([nextAuth, nextSettings]) => {
        setAuth(nextAuth);
        setSettings(nextSettings);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : 'Startup failed'));

    const offStatus = window.glass.events.onStatus(setStatus);
    const offError = window.glass.events.onError((message) => setStatus(message));
    const offListen = window.glass.events.onListenState((payload) => setListening(payload.listening));
    const offTranscript = window.glass.events.onTranscript((turn) => {
      setTranscript((current) => {
        const existingIndex = current.findIndex((item) => item.id === turn.id);
        if (existingIndex < 0) return [...current.slice(-24), turn];

        const next = [...current];
        next[existingIndex] = turn;
        return next;
      });
    });
    const offAskState = window.glass.events.onAskState((payload) => setLoadingAnswer(payload.loading));
    const offAnswer = window.glass.events.onAnswer((answer) => {
      setPanelMode('insights');
      setAnswers((current) => [answer, ...current].slice(0, 8));
    });

    return () => {
      offStatus();
      offError();
      offListen();
      offTranscript();
      offAskState();
      offAnswer();
      capture.current.stop();
    };
  }, []);

  const latestAnswer = answers[0];
  const answerAuthReady = Boolean(
    settings && (settings.answerProvider === 'codex' ? auth.hasCodexAuth : auth.hasApiKey),
  );
  const canListen = Boolean(auth.hasApiKey && settings);
  const activeModelLabel = settings?.answerProvider === 'codex' ? settings.codexModel : settings?.model;
  const transcriptPreview = useMemo(
    () =>
      transcript
        .slice(-3)
        .map((turn) => turn.text)
        .join(' '),
    [transcript],
  );

  const saveApiKey = useCallback(async () => {
    setApiError('');
    const result = await window.glass.auth.saveApiKey(apiKey);
    if (!result.success) {
      setApiError(result.error);
      return;
    }

    setAuth(result.auth);
    setApiKey('');
    setStatus('OpenAI connected');
  }, [apiKey]);

  const refreshAuth = useCallback(async () => {
    setAuth(await window.glass.auth.getState());
  }, []);

  const startCodexLogin = useCallback(async () => {
    setStatus('Opening Codex login');
    await window.glass.auth.startCodexLogin();
    await refreshAuth();
  }, [refreshAuth]);

  const clearApiKey = useCallback(async () => {
    capture.current.stop();
    await window.glass.listen.stop();
    setAuth(await window.glass.auth.clearApiKey());
    setListening(false);
  }, []);

  const startListening = useCallback(async () => {
    if (!settings) return;
    if (!canListen) {
      setShowSettings(true);
      setStatus('OpenAI API key required for transcription');
      return;
    }

    const result = await window.glass.listen.start();
    if (!result.success) {
      setStatus(result.error || 'Could not start realtime transcription');
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
      setStatus(error instanceof Error ? error.message : 'Could not capture audio');
    }
  }, [canListen, settings]);

  const stopListening = useCallback(async () => {
    capture.current.stop();
    await window.glass.listen.stop();
  }, []);

  const sendQuestion = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    if (!settings) return;
    if (!answerAuthReady) {
      setShowSettings(true);
      setStatus(settings.answerProvider === 'codex' ? 'Codex login required' : 'OpenAI API key required');
      return;
    }

    setQuestion('');
    const answer = await window.glass.ask.send(trimmed);
    setPanelMode('insights');
    setAnswers((current) => [answer, ...current].slice(0, 8));
  }, [answerAuthReady, question, settings]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.glass.settings.update(patch);
    setSettings(next);
  }, []);

  const copyLatest = useCallback(async () => {
    if (!latestAnswer) return;
    await navigator.clipboard.writeText(latestAnswer.answer);
    setCopyState('copied');
    window.setTimeout(() => setCopyState('idle'), 1200);
  }, [latestAnswer]);

  if (!settings) {
    return (
      <main className="glass-stage loading-stage">
        <section className="glass-capsule compact-capsule">
          <span className="brand-dot" />
          <span>{APP_NAME}</span>
        </section>
      </main>
    );
  }

  return (
    <main className="glass-stage">
      <header className="glass-capsule" onDoubleClick={() => window.glass.window.hide()}>
        <button className={`listen-pill ${listening ? 'active' : ''}`} onClick={listening ? stopListening : startListening}>
          {listening ? <MicOff size={14} /> : <Mic size={14} />}
          <span>{listening ? 'Stop' : 'Listen'}</span>
        </button>

        <button
          className={`capsule-action ${panelMode === 'ask' ? 'selected' : ''}`}
          onClick={() => {
            setPanelMode('ask');
            setShowSettings(false);
          }}
        >
          <span>Ask</span>
          <span className="keycap">Ctrl</span>
          <span className="keycap">Enter</span>
        </button>

        <button className="capsule-action" onClick={() => window.glass.window.hide()}>
          <span>Show/Hide</span>
          <span className="keycap">\</span>
        </button>

        <button
          className={`capsule-icon ${showSettings ? 'selected' : ''}`}
          title="OpenAI Auth"
          onClick={() => setShowSettings((value) => !value)}
        >
          <MoreVertical size={18} />
        </button>
      </header>

      <section className={`glass-panel ${showSettings ? 'settings-open' : ''}`}>
        <div className="panel-top">
          <div className="panel-title">
            {answerAuthReady ? (
              <>
                <AudioLines size={18} />
                <span>{panelMode === 'ask' ? 'Ask' : 'Live Insights'}</span>
              </>
            ) : (
              <>
                <KeyRound size={18} />
                <span>OpenAI Auth</span>
              </>
            )}
          </div>

          <div className="panel-tools">
            {answerAuthReady && activeModelLabel && (
              <span className="model-chip">
                <Bot size={13} />
                {activeModelLabel}
              </span>
            )}
            <button className="tool-button" title="Copy answer" onClick={copyLatest} disabled={!latestAnswer}>
              {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <button className="tool-button" title="Settings" onClick={() => setShowSettings((value) => !value)}>
              <Settings size={15} />
            </button>
            <button className="tool-button" title="Hide" onClick={() => window.glass.window.hide()}>
              <Minus size={15} />
            </button>
          </div>
        </div>

        {!answerAuthReady ? (
          <AuthView
            auth={auth}
            apiKey={apiKey}
            apiError={apiError}
            settings={settings}
            onApiKeyChange={setApiKey}
            onSaveApiKey={saveApiKey}
            onStartCodexLogin={startCodexLogin}
            onRefreshAuth={refreshAuth}
            onOpenDocs={() => window.glass.window.openExternal(docsUrl)}
            onUpdateSettings={updateSettings}
          />
        ) : panelMode === 'ask' ? (
          <AskView
            question={question}
            loading={loadingAnswer}
            onQuestionChange={setQuestion}
            onSendQuestion={sendQuestion}
          />
        ) : (
          <InsightsView
            answer={latestAnswer}
            status={status}
            loading={loadingAnswer}
            listening={listening}
            transcriptPreview={transcriptPreview}
          />
        )}

        {answerAuthReady && (
          <div className="ask-strip">
            <input
              value={question}
              placeholder="Ask..."
              onChange={(event) => setQuestion(event.target.value)}
              onFocus={() => setPanelMode('ask')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void sendQuestion();
              }}
            />
            <button className="send-button" onClick={sendQuestion} disabled={!question.trim()}>
              <Send size={16} />
            </button>
          </div>
        )}
      </section>

      {showSettings && (
        <aside className="settings-popover">
          <div className="settings-head">
            <span>{APP_NAME}</span>
            <button className="plain-icon" onClick={() => setShowSettings(false)}>
              <X size={15} />
            </button>
          </div>

          <label>
            <span>Answer provider</span>
            <select
              value={settings.answerProvider}
              onChange={(event) => updateSettings({ answerProvider: event.target.value as AppSettings['answerProvider'] })}
            >
              <option value="codex">OpenAI Codex Auth</option>
              <option value="openai-api">OpenAI API key</option>
            </select>
          </label>

          <label>
            <span>{settings.answerProvider === 'codex' ? 'Codex model' : 'Answer model'}</span>
            <select
              value={settings.answerProvider === 'codex' ? settings.codexModel : settings.model}
              onChange={(event) =>
                updateSettings(
                  settings.answerProvider === 'codex'
                    ? { codexModel: event.target.value }
                    : { model: event.target.value },
                )
              }
            >
              {uniqueOptions(
                settings.answerProvider === 'codex' ? settings.codexModel : settings.model,
                settings.answerProvider === 'codex' ? codexModelOptions : modelOptions,
              ).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Transcribe</span>
            <select
              value={settings.transcriptionModel}
              onChange={(event) => updateSettings({ transcriptionModel: event.target.value })}
            >
              {uniqueOptions(settings.transcriptionModel, transcriptionOptions).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Language</span>
            <input value={settings.language} onChange={(event) => updateSettings({ language: event.target.value })} />
          </label>

          <label>
            <span>Audio source</span>
            <select
              value={settings.captureSource}
              onChange={(event) => updateSettings({ captureSource: event.target.value as AppSettings['captureSource'] })}
            >
              <option value="microphone">Microphone</option>
              <option value="system">System audio</option>
            </select>
          </label>

          <label className="toggle-line">
            <input
              type="checkbox"
              checked={settings.autoAnswer}
              onChange={(event) => updateSettings({ autoAnswer: event.target.checked })}
            />
            <span>Auto answer</span>
          </label>

          <div className="locked-line">
            <EyeOff size={15} />
            <span>Invisible on screen share</span>
          </div>

          <div className="shortcut-line">
            <Keyboard size={15} />
            <span>Ctrl+Shift+G</span>
          </div>

          {auth.hasApiKey ? (
            <button className="danger full" onClick={clearApiKey}>
              <Square size={15} />
              <span>Disconnect {auth.maskedKey ? `(${auth.maskedKey})` : ''}</span>
            </button>
          ) : (
            <button className="ghost full" onClick={() => window.glass.window.openExternal(docsUrl)}>
              OpenAI keys
            </button>
          )}
        </aside>
      )}
    </main>
  );
}

function AuthView(props: {
  auth: AuthState;
  apiKey: string;
  apiError: string;
  settings: AppSettings;
  onApiKeyChange: (value: string) => void;
  onSaveApiKey: () => void;
  onStartCodexLogin: () => void;
  onRefreshAuth: () => void;
  onOpenDocs: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  return (
    <div className="auth-content">
      <div className="auth-mark">
        <KeyRound size={22} />
      </div>
      <div className="auth-copy">
        <h1>OpenAI Auth</h1>
        <p>Use Codex for answers, API key for audio transcription</p>
      </div>

      <div className="auth-grid">
        <section className={`auth-card ${props.auth.hasCodexAuth ? 'connected' : ''}`}>
          <div className="auth-card-head">
            <Bot size={17} />
            <span>OpenAI Codex</span>
          </div>
          <p>{props.auth.hasCodexAuth ? props.auth.codexStatus || 'Logged in using ChatGPT' : 'ChatGPT/Codex account'}</p>
          <div className="auth-actions">
            <button className="primary" onClick={props.onStartCodexLogin}>
              <LogIn size={15} />
              <span>{props.auth.hasCodexAuth ? 'Re-login' : 'Sign in'}</span>
            </button>
            <button className="ghost" onClick={props.onRefreshAuth}>
              <RefreshCw size={15} />
            </button>
          </div>
          {props.auth.codexError && !props.auth.hasCodexAuth && <div className="error compact-error">{props.auth.codexError}</div>}
        </section>

        <section className={`auth-card ${props.auth.hasApiKey ? 'connected' : ''}`}>
          <div className="auth-card-head">
            <KeyRound size={17} />
            <span>OpenAI API</span>
          </div>
          <p>{props.auth.hasApiKey ? `Connected ${props.auth.maskedKey || ''}` : 'Needed for microphone transcription'}</p>
          <div className="auth-row">
            <input
              type="password"
              value={props.apiKey}
              placeholder="sk-..."
              onChange={(event) => props.onApiKeyChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void props.onSaveApiKey();
              }}
            />
            <button className="primary" onClick={props.onSaveApiKey} disabled={!props.apiKey.trim()}>
              Save
            </button>
          </div>
          {props.apiError && <div className="error compact-error">{props.apiError}</div>}
        </section>
      </div>

      <label className="inline-setting">
        <span>Provider</span>
        <select
          value={props.settings.answerProvider}
          onChange={(event) => props.onUpdateSettings({ answerProvider: event.target.value as AppSettings['answerProvider'] })}
        >
          <option value="codex">OpenAI Codex Auth</option>
          <option value="openai-api">OpenAI API key</option>
        </select>
      </label>

      <label className="inline-setting">
        <span>{props.settings.answerProvider === 'codex' ? 'Codex model' : 'API model'}</span>
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
          {uniqueOptions(
            props.settings.answerProvider === 'codex' ? props.settings.codexModel : props.settings.model,
            props.settings.answerProvider === 'codex' ? codexModelOptions : modelOptions,
          ).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <button className="link-button" onClick={props.onOpenDocs}>
        Open API keys
      </button>
    </div>
  );
}

function InsightsView(props: {
  answer?: AnswerPayload;
  status: string;
  loading: boolean;
  listening: boolean;
  transcriptPreview: string;
}) {
  if (!props.answer) {
    return (
      <div className="insights-empty">
        <div className="pulse-ring">
          <AudioLines size={26} />
        </div>
        <h1>{props.listening ? 'Listening' : 'Ready'}</h1>
        <p>{props.loading ? 'Thinking' : props.status}</p>
      </div>
    );
  }

  return (
    <div className="insights-content">
      <div className="question-line">{props.answer.question}</div>
      <h1>Start of Answer</h1>
      <div className="answer-text">{props.answer.answer}</div>
      {props.transcriptPreview && <div className="transcript-line">{props.transcriptPreview}</div>}
    </div>
  );
}

function AskView(props: {
  question: string;
  loading: boolean;
  onQuestionChange: (value: string) => void;
  onSendQuestion: () => void;
}) {
  return (
    <div className="ask-content">
      <div className="ask-title">
        <Bot size={22} />
        <h1>{props.loading ? 'Thinking' : 'Ask anything'}</h1>
      </div>
      <textarea
        value={props.question}
        placeholder="Type a question..."
        onChange={(event) => props.onQuestionChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void props.onSendQuestion();
          }
        }}
      />
      <button className="primary ask-submit" onClick={props.onSendQuestion} disabled={!props.question.trim()}>
        <Send size={16} />
        <span>Send</span>
      </button>
    </div>
  );
}

function uniqueOptions(current: string, options: string[]) {
  return Array.from(new Set([current, ...options].filter(Boolean)));
}
