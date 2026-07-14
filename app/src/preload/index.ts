import { contextBridge, ipcRenderer } from 'electron';
import type {
  AnswerDeltaPayload,
  AnswerPayload,
  AssistantRequestPayload,
  AppSettings,
  AskRequest,
  AuthState,
  AudioInputSource,
  InterviewCoachPayload,
  InterviewContextImportRequest,
  InterviewContextImportResult,
  InterviewContextState,
  LabeledAudioChunkPayload,
  NarrativeNavigationRequest,
  ScreenCapturePayload,
  SessionInsightsPayload,
  SessionPhase,
  SessionStatePayload,
  SessionSummaryPayload,
  TranscriptTurn,
} from '../main/types';
import type { CodexLoginStatus, CodexModel } from '../main/codexService';

type Listener<T> = (payload: T) => void;

function on<T>(channel: string, listener: Listener<T>) {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke('auth:getState'),
    saveApiKey: (apiKey: string): Promise<{ success: true; auth: AuthState } | { success: false; error: string }> =>
      ipcRenderer.invoke('auth:saveApiKey', apiKey),
    clearApiKey: (): Promise<AuthState> => ipcRenderer.invoke('auth:clearApiKey'),
    getCodexStatus: (): Promise<CodexLoginStatus> => ipcRenderer.invoke('auth:codexStatus'),
    getCodexModels: (): Promise<CodexModel[]> => ipcRenderer.invoke('auth:codexModels'),
    startCodexLogin: (): Promise<CodexLoginStatus> => ipcRenderer.invoke('auth:startCodexLogin'),
    logoutCodex: (): Promise<CodexLoginStatus> => ipcRenderer.invoke('auth:codexLogout'),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:update', patch),
  },
  context: {
    get: (): Promise<InterviewContextState> => ipcRenderer.invoke('context:get'),
    save: (candidate: Partial<InterviewContextState>): Promise<InterviewContextState> =>
      ipcRenderer.invoke('context:save', candidate),
    importFile: (request: InterviewContextImportRequest): Promise<InterviewContextImportResult> =>
      ipcRenderer.invoke('context:import', request),
    removeDocument: (documentId: string): Promise<InterviewContextState> =>
      ipcRenderer.invoke('context:removeDocument', documentId),
    navigateNarrative: (request: NarrativeNavigationRequest): Promise<InterviewCoachPayload | null> =>
      ipcRenderer.invoke('context:navigateNarrative', request),
    clear: (): Promise<InterviewContextState> => ipcRenderer.invoke('context:clear'),
  },
  listen: {
    start: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('listen:start'),
    stop: (): Promise<{ success: boolean }> => ipcRenderer.invoke('listen:stop'),
    sendAudioChunk: (payload: LabeledAudioChunkPayload): void => ipcRenderer.send('listen:audioChunk', payload),
    commitAudio: (source: AudioInputSource): void => ipcRenderer.send('listen:commit', source),
  },
  ask: {
    send: (request: AskRequest | string): Promise<AnswerPayload> => ipcRenderer.invoke('ask:send', request),
    latest: (includeScreen = false): Promise<AnswerPayload> => ipcRenderer.invoke('ask:latest', includeScreen),
    smart: (typedQuestion = ''): Promise<AnswerPayload> => ipcRenderer.invoke('ask:smart', typedQuestion),
  },
  session: {
    getState: (): Promise<SessionStatePayload> => ipcRenderer.invoke('session:getState'),
    finish: (): Promise<SessionSummaryPayload> => ipcRenderer.invoke('session:finish'),
    refreshInsights: (): Promise<SessionInsightsPayload> => ipcRenderer.invoke('session:refreshInsights'),
    summarize: (): Promise<SessionSummaryPayload> => ipcRenderer.invoke('session:summarize'),
    clear: (): Promise<void> => ipcRenderer.invoke('session:clear'),
  },
  screen: {
    capturePreview: (): Promise<ScreenCapturePayload> => ipcRenderer.invoke('screen:capturePreview'),
  },
  window: {
    hide: (): Promise<void> => ipcRenderer.invoke('window:hide'),
    show: (): Promise<void> => ipcRenderer.invoke('window:show'),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('window:openExternal', url),
  },
  events: {
    onStatus: (listener: Listener<string>) => on('status', listener),
    onError: (listener: Listener<string>) => on('error', listener),
    onListenState: (listener: Listener<{ listening: boolean }>) => on('listen:state', listener),
    onSessionPhase: (listener: Listener<{ phase: SessionPhase }>) => on('session:phase', listener),
    onTranscript: (listener: Listener<TranscriptTurn>) => on('listen:transcript', listener),
    onTranscriptRemoved: (listener: Listener<{ id: string; reason: 'system-echo' }>) =>
      on('listen:transcript-removed', listener),
    onAskState: (listener: Listener<{ loading: boolean }>) => on('ask:state', listener),
    onRequest: (listener: Listener<AssistantRequestPayload>) => on('ask:request', listener),
    onAnswerDelta: (listener: Listener<AnswerDeltaPayload>) => on('ask:delta', listener),
    onAnswer: (listener: Listener<AnswerPayload>) => on('ask:answer', listener),
    onScreenPreview: (listener: Listener<ScreenCapturePayload>) => on('screen:preview', listener),
    onListenToggleRequested: (listener: Listener<Record<string, never>>) => on('listen:toggle-requested', listener),
    onComposerFocusRequested: (listener: Listener<Record<string, never>>) => on('composer:focus-requested', listener),
    onSmartSubmitRequested: (listener: Listener<Record<string, never>>) => on('ask:smart-submit-requested', listener),
    onSessionFinishRequested: (listener: Listener<Record<string, never>>) => on('session:finish-requested', listener),
    onNavigation: (listener: Listener<{ view: 'answers' | 'transcript' | 'summary' | 'settings' }>) =>
      on('navigation:open', listener),
    onSessionCleared: (listener: Listener<Record<string, never>>) => on('session:cleared', listener),
    onSummary: (listener: Listener<SessionSummaryPayload>) => on('session:summary', listener),
    onSummaryState: (listener: Listener<{ loading: boolean }>) => on('session:summary-state', listener),
    onInsights: (listener: Listener<SessionInsightsPayload>) => on('session:insights', listener),
    onInsightsState: (listener: Listener<{ loading: boolean }>) => on('session:insights-state', listener),
    onCoach: (listener: Listener<InterviewCoachPayload | null>) => on('context:coach', listener),
  },
};

contextBridge.exposeInMainWorld('glass', api);

export type GlassApi = typeof api;
