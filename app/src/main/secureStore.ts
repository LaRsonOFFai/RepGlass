import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSettings } from './defaults';
import type { AppSettings, AuthState } from './types';

type CodexStatus = {
  loggedIn: boolean;
  method?: string;
  version?: string;
  email?: string;
  planType?: string;
  error?: string;
};

type StoreShape = {
  encryptedOpenAIKey?: string;
  openAIKeyEncryption?: 'safeStorage-v1';
  settings?: Partial<AppSettings>;
};

export class SecureStore {
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'repglass-store.json');
  }

  isFirstRun(): boolean {
    return !fs.existsSync(this.filePath);
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
      codexEmail: codex?.email,
      codexPlan: codex?.planType,
      codexError: codex?.error,
    };
  }

  getOpenAIKey(): string | null {
    const store = this.read();
    const encrypted = store.encryptedOpenAIKey;
    if (!encrypted) return null;

    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (error) {
      console.error('[SecureStore] Failed to decrypt OpenAI key:', error);
      return null;
    }
  }

  saveOpenAIKey(apiKey: string): AuthState {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('OpenAI API key is empty');

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable; the API key was not saved');
    }

    const store = this.read();
    const encrypted = safeStorage.encryptString(trimmed).toString('base64');
    this.write({ ...store, encryptedOpenAIKey: encrypted, openAIKeyEncryption: 'safeStorage-v1' });
    return this.getAuthState();
  }

  clearOpenAIKey(): AuthState {
    const store = this.read();
    delete store.encryptedOpenAIKey;
    delete store.openAIKeyEncryption;
    this.write(store);
    return this.getAuthState();
  }

  getSettings(): AppSettings {
    const store = this.read();
    return normalizeSettings(store.settings);
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const next = normalizeSettings({ ...current, ...patch });
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
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  private maskKey(key: string): string {
    if (key.length <= 10) return 'sk-...';
    return `${key.slice(0, 7)}...${key.slice(-4)}`;
  }
}
