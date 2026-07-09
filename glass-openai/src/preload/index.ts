import { contextBridge, ipcRenderer } from 'electron';
import type { AnswerPayload, AppSettings, AudioChunkPayload, AuthState, TranscriptTurn } from '../main/types';
import type { CodexLoginStatus } from '../main/codexService';

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
    startCodexLogin: (): Promise<CodexLoginStatus> => ipcRenderer.invoke('auth:startCodexLogin'),
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
    send: (question: string): Promise<AnswerPayload> => ipcRenderer.invoke('ask:send', question),
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
    onAnswer: (listener: Listener<AnswerPayload>) => on('ask:answer', listener),
  },
};

contextBridge.exposeInMainWorld('glass', api);

export type GlassApi = typeof api;
