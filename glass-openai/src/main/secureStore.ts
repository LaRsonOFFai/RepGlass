import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from './defaults';
import type { AppSettings, AuthState } from './types';

type CodexStatus = {
  loggedIn: boolean;
  method?: string;
  version?: string;
  error?: string;
};

type StoreShape = {
  encryptedOpenAIKey?: string;
  settings?: Partial<AppSettings>;
};

export class SecureStore {
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'repglass-store.json');
  }

  getAuthState(codex?: CodexStatus): AuthState {
    const key = this.getOpenAIKey();
    const hasCodexAuth = Boolean(codex?.loggedIn);
    return {
      mode: hasCodexAuth ? 'codex-chatgpt' : key ? 'openai-api-key' : 'none',
      hasApiKey: Boolean(key),
      hasCodexAuth,
      maskedKey: key ? this.maskKey(key) : undefined,
      codexStatus: codex?.method,
      codexVersion: codex?.version,
      codexError: codex?.error,
    };
  }

  getOpenAIKey(): string | null {
    const store = this.read();
    const encrypted = store.encryptedOpenAIKey;
    if (!encrypted) return null;

    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      }
      return Buffer.from(encrypted, 'base64').toString('utf8');
    } catch (error) {
      console.error('[SecureStore] Failed to decrypt OpenAI key:', error);
      return null;
    }
  }

  saveOpenAIKey(apiKey: string): AuthState {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('OpenAI API key is empty');

    const store = this.read();
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(trimmed).toString('base64')
      : Buffer.from(trimmed, 'utf8').toString('base64');

    this.write({ ...store, encryptedOpenAIKey: encrypted });
    return this.getAuthState();
  }

  clearOpenAIKey(): AuthState {
    const store = this.read();
    delete store.encryptedOpenAIKey;
    this.write(store);
    return this.getAuthState();
  }

  getSettings(): AppSettings {
    const store = this.read();
    const settings = { ...DEFAULT_SETTINGS, ...store.settings };
    if (settings.transcriptionModel !== 'gpt-realtime-whisper') {
      settings.transcriptionModel = 'gpt-realtime-whisper';
    }
    return settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next = { ...current, ...patch };
    const store = this.read();
    this.write({ ...store, settings: next });
    return next;
  }

  private read(): StoreShape {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as StoreShape;
    } catch (error) {
      console.error('[SecureStore] Failed to read store:', error);
      return {};
    }
  }

  private write(next: StoreShape): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), 'utf8');
  }

  private maskKey(key: string): string {
    if (key.length <= 10) return 'sk-...';
    return `${key.slice(0, 7)}...${key.slice(-4)}`;
  }
}
