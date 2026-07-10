import { contextBridge, ipcRenderer } from 'electron';
import type {
  AnswerDeltaPayload,
  AnswerPayload,
  AppSettings,
  AskRequest,
  AudioChunkPayload,
  AuthState,
  ScreenCapturePayload,
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
  listen: {
    start: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('listen:start'),
    stop: (): Promise<{ success: boolean }> => ipcRenderer.invoke('listen:stop'),
    sendAudioChunk: (payload: AudioChunkPayload): void => ipcRenderer.send('listen:audioChunk', payload),
    commitAudio: (): void => ipcRenderer.send('listen:commit'),
  },
  ask: {
    send: (request: AskRequest | string): Promise<AnswerPayload> => ipcRenderer.invoke('ask:send', request),
    latest: (includeScreen = false): Promise<AnswerPayload> => ipcRenderer.invoke('ask:latest', includeScreen),
  },
  session: {
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
    onTranscript: (listener: Listener<TranscriptTurn>) => on('listen:transcript', listener),
    onAskState: (listener: Listener<{ loading: boolean }>) => on('ask:state', listener),
    onAnswerDelta: (listener: Listener<AnswerDeltaPayload>) => on('ask:delta', listener),
    onAnswer: (listener: Listener<AnswerPayload>) => on('ask:answer', listener),
    onScreenPreview: (listener: Listener<ScreenCapturePayload>) => on('screen:preview', listener),
    onListenToggleRequested: (listener: Listener<Record<string, never>>) => on('listen:toggle-requested', listener),
    onNavigation: (listener: Listener<{ view: 'answers' | 'transcript' | 'settings' }>) =>
      on('navigation:open', listener),
    onSessionCleared: (listener: Listener<Record<string, never>>) => on('session:cleared', listener),
  },
};

contextBridge.exposeInMainWorld('glass', api);

export type GlassApi = typeof api;
