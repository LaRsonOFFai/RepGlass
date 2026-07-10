import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
  Tray,
} from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantRuntime } from './assistantRuntime';
import { CodexService } from './codexService';
import { OpenAIService } from './openaiService';
import { ScreenCaptureService } from './screenCaptureService';
import { SecureStore } from './secureStore';
import type { AppSettings, AskRequest, AudioChunkPayload } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'RepGlass';
const RENDERER_SCHEME = 'repglass';
const TRUSTED_EXTERNAL_ORIGINS = new Set([
  'https://auth.openai.com',
  'https://chatgpt.com',
  'https://github.com',
  'https://help.openai.com',
  'https://openai.com',
  'https://platform.openai.com',
]);

app.setName(APP_NAME);
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);
if (!app.isPackaged) {
  const developmentUserData = process.env.REPGLASS_USER_DATA_DIR || path.join(app.getPath('appData'), `${APP_NAME} Dev`);
  app.setPath('userData', developmentUserData);
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disk-cache-size', '0');
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SecureStore;
let runtime: AssistantRuntime;
let isQuitting = false;
let interactiveMode = true;
let visibleTestMode = !app.isPackaged && process.env.REPGLASS_VISIBLE_TEST === 'true';

const openai = new OpenAIService();
const codex = new CodexService();
const screenCapture = new ScreenCaptureService();

function createTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="7" fill="#121518"/>',
    '<path d="M7.5 16.4c3.2-5.5 13.8-5.5 17 0-3.2 5.5-13.8 5.5-17 0Z" fill="#d7ff5f"/>',
    '<circle cx="16" cy="16.4" r="4.5" fill="#121518"/>',
    '<circle cx="16" cy="16.4" r="2" fill="#ffffff"/>',
    '</svg>',
  ].join('');
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function isWindowVisible(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function applyCaptureProtection(win: BrowserWindow): void {
  const enabled = store?.getSettings().captureProtection !== false && !visibleTestMode;
  win.setContentProtection(enabled);
}

function getRendererUrls(): string[] {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (!url) return [];
  const urls = new Set<string>([url]);
  try {
    const parsed = new URL(url);
    const port = parsed.port ? `:${parsed.port}` : '';
    const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      urls.add(`${parsed.protocol}//127.0.0.1${port}${suffix}`);
      urls.add(`${parsed.protocol}//localhost${port}${suffix}`);
      urls.add(`${parsed.protocol}//[::1]${port}${suffix}`);
    }
  } catch (error) {
    console.warn('[Main] Invalid renderer URL:', error);
  }
  return [...urls];
}

function loadRenderer(win: BrowserWindow, attempt = 1): void {
  const rendererUrls = getRendererUrls();
  if (rendererUrls.length === 0) {
    if (app.isPackaged) void win.loadURL(`${RENDERER_SCHEME}://app/index.html`);
    else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
    return;
  }

  const rendererUrl = rendererUrls[(attempt - 1) % rendererUrls.length];
  void win.loadURL(rendererUrl).catch((error) => {
    if (attempt >= 18 || win.isDestroyed()) {
      console.error('[Main] Renderer failed:', error);
      return;
    }
    setTimeout(() => loadRenderer(win, attempt + 1), Math.min(250 * attempt, 1_500));
  });
}

function registerRendererProtocol(): void {
  if (!app.isPackaged) return;
  const rendererRoot = path.resolve(__dirname, '../renderer');
  const contentTypes: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  };

  protocol.handle(RENDERER_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(rendererRoot, relativePath);
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }

    const contentType = contentTypes[path.extname(filePath).toLowerCase()];
    if (!contentType) return new Response('Unsupported file type', { status: 415 });

    try {
      const data = await fs.readFile(filePath);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function keepWindowOnScreen(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const bounds = win.getBounds();
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + Math.max(18, (area.height - height) / 5));
  win.setBounds({ x, y, width, height });
}

function setInteractionMode(enabled: boolean): void {
  interactiveMode = enabled;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFocusable(enabled || visibleTestMode);
    mainWindow.setIgnoreMouseEvents(!enabled && !visibleTestMode, { forward: true });
    if (enabled || visibleTestMode) mainWindow.focus();
    else mainWindow.blur();
  }
  updateTrayMenu();
}

function revealWindow(options: { interactive?: boolean; view?: 'answers' | 'transcript' | 'settings' } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;

  keepWindowOnScreen(win);
  applyCaptureProtection(win);
  win.setOpacity(1);
  win.setAlwaysOnTop(true, 'screen-saver');
  const interactive = options.interactive ?? true;
  if (interactive) win.show();
  else win.showInactive();
  win.moveTop();
  setInteractionMode(interactive);
  if (options.view) win.webContents.send('navigation:open', { view: options.view });
  updateTrayMenu();
}

function hideOverlay(): void {
  mainWindow?.hide();
  updateTrayMenu();
}

function toggleOverlay(): void {
  if (isWindowVisible()) hideOverlay();
  else revealWindow({ interactive: true });
}

function createWindow(): void {
  const firstRun = store.isFirstRun();
  const settings = store.getSettings();
  let didAutoReveal = false;

  mainWindow = new BrowserWindow({
    width: 820,
    height: 590,
    minWidth: 460,
    minHeight: 390,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    skipTaskbar: true,
    show: false,
    resizable: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const win = mainWindow;
  applyCaptureProtection(win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.on('show', () => applyCaptureProtection(win));
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideOverlay();
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) =>
    console.error(`[Main] Renderer failed to load ${url}: ${description} (${code})`),
  );

  const autoReveal = () => {
    if (didAutoReveal || win.isDestroyed()) return;
    didAutoReveal = true;
    if (firstRun || !settings.startInTray) revealWindow({ interactive: true, view: firstRun ? 'settings' : 'answers' });
  };
  win.once('ready-to-show', autoReveal);
  win.webContents.once('did-finish-load', () => setTimeout(autoReveal, 80));
  loadRenderer(win);

  if (!app.isPackaged && process.env.GLASS_OPEN_DEVTOOLS === 'true') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

async function openTrustedExternal(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !TRUSTED_EXTERNAL_ORIGINS.has(url.origin)) {
    throw new Error('Внешняя ссылка заблокирована');
  }
  await shell.openExternal(url.toString());
}

function shouldSuppressTray(): boolean {
  return Boolean(runtime?.isListening() && store?.getSettings().hideTrayWhileListening);
}

function createTray(): void {
  if (tray || shouldSuppressTray()) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    if (isWindowVisible()) setInteractionMode(!interactiveMode);
    else revealWindow({ interactive: true });
  });
  tray.on('double-click', () => revealWindow({ interactive: true }));
  updateTrayMenu();
}

function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

function syncTrayVisibility(): void {
  if (shouldSuppressTray()) destroyTray();
  else createTray();
}

function requestListenToggle(): void {
  revealWindow({ interactive: true });
  mainWindow?.webContents.send('listen:toggle-requested', {});
}

function updateTrayMenu(): void {
  if (!tray) return;
  const visible = isWindowVisible();
  const listening = runtime?.isListening() ?? false;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: visible ? 'Скрыть RepGlass' : 'Открыть RepGlass', click: toggleOverlay },
    {
      label: interactiveMode ? 'Режим сквозных кликов' : 'Интерактивный режим',
      click: () => {
        if (!visible) revealWindow({ interactive: true });
        else setInteractionMode(!interactiveMode);
      },
    },
    { label: listening ? 'Остановить прослушивание' : 'Начать прослушивание', click: requestListenToggle },
    { label: 'Транскрипция', click: () => revealWindow({ interactive: true, view: 'transcript' }) },
    { label: 'Настройки и авторизация', click: () => revealWindow({ interactive: true, view: 'settings' }) },
    { type: 'separator' },
    {
      label: 'Новая сессия',
      click: () => {
        runtime.clearSession();
        revealWindow({ interactive: true, view: 'answers' });
      },
    },
    { label: 'Защита окна от захвата включена', enabled: false },
  ];
  if (!app.isPackaged) {
    template.push({
      label: visibleTestMode ? 'Выключить видимый тест' : 'Видимый тест захвата',
      click: () => setVisibleTestMode(!visibleTestMode),
    });
  }
  template.push(
    { type: 'separator' },
    { label: 'Ctrl+Shift+G: окно', enabled: false },
    { label: 'Ctrl+Shift+L: прослушивание', enabled: false },
    { label: 'Ctrl+Enter: ответить на последнюю фразу', enabled: false },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function setVisibleTestMode(enabled: boolean): void {
  if (app.isPackaged) return;
  visibleTestMode = enabled;
  if (mainWindow && !mainWindow.isDestroyed()) {
    applyCaptureProtection(mainWindow);
    mainWindow.setBackgroundColor(enabled ? '#12171c' : '#00000000');
    mainWindow.setSkipTaskbar(!enabled);
    mainWindow.setHasShadow(enabled);
    revealWindow({ interactive: true });
  }
  updateTrayMenu();
}

function moveOverlay(deltaX: number, deltaY: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  mainWindow.setPosition(bounds.x + deltaX, bounds.y + deltaY);
}

function registerShortcut(accelerator: string, callback: () => void): boolean {
  const registered = globalShortcut.register(accelerator, callback);
  if (!registered) console.warn(`[Main] Shortcut unavailable: ${accelerator}`);
  return registered;
}

function registerShortcuts(): void {
  registerShortcut('CommandOrControl+Shift+G', () => {
    if (!isWindowVisible()) revealWindow({ interactive: true });
    else setInteractionMode(!interactiveMode);
  });
  registerShortcut('CommandOrControl+Shift+L', requestListenToggle);
  registerShortcut('CommandOrControl+Enter', () => {
    revealWindow({ interactive: false, view: 'answers' });
    void runtime.askLatest(true).catch(() => undefined);
  });
  registerShortcut('CommandOrControl+\\', toggleOverlay);
  registerShortcut('CommandOrControl+Shift+Space', toggleOverlay);
  registerShortcut('CommandOrControl+Up', () => moveOverlay(0, -32));
  registerShortcut('CommandOrControl+Down', () => moveOverlay(0, 32));
  registerShortcut('CommandOrControl+Left', () => moveOverlay(-32, 0));
  registerShortcut('CommandOrControl+Right', () => moveOverlay(32, 0));
}

async function captureWithPrivacy() {
  const hadTray = Boolean(tray);
  if (hadTray) {
    destroyTray();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  try {
    return await screenCapture.captureCurrentDisplay();
  } finally {
    if (hadTray && !shouldSuppressTray()) setTimeout(createTray, 80);
  }
}

async function getAuthState() {
  return store.getAuthState(await codex.getStatus());
}

function registerIpc(): void {
  ipcMain.handle('auth:getState', getAuthState);
  ipcMain.handle('auth:saveApiKey', async (_event, apiKey: string) => {
    const validation = await openai.validateApiKey(apiKey);
    if (!validation.success) return validation;
    try {
      store.saveOpenAIKey(apiKey);
      return { success: true, auth: await getAuthState() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Не удалось сохранить ключ' };
    }
  });
  ipcMain.handle('auth:clearApiKey', async () => {
    store.clearOpenAIKey();
    return await getAuthState();
  });
  ipcMain.handle('auth:codexStatus', () => codex.getStatus());
  ipcMain.handle('auth:codexModels', () => codex.listModels());
  ipcMain.handle('auth:startCodexLogin', () => codex.startLogin(openTrustedExternal));
  ipcMain.handle('auth:codexLogout', () => codex.logout());

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>) => {
    const settings = store.updateSettings(patch);
    if (mainWindow && !mainWindow.isDestroyed()) applyCaptureProtection(mainWindow);
    syncTrayVisibility();
    return settings;
  });

  ipcMain.handle('listen:start', async () => {
    try {
      await runtime.start();
      syncTrayVisibility();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось запустить транскрипцию';
      console.error('[Main] Realtime transcription failed:', error);
      return { success: false, error: message };
    }
  });
  ipcMain.handle('listen:stop', () => {
    runtime.stop();
    syncTrayVisibility();
    return { success: true };
  });
  ipcMain.on('listen:audioChunk', (_event, payload: AudioChunkPayload) => runtime.handleAudioChunk(payload));
  ipcMain.on('listen:commit', () => runtime.commitAudio());

  ipcMain.handle('ask:send', (_event, request: AskRequest | string) => runtime.ask(request));
  ipcMain.handle('ask:latest', (_event, includeScreen: boolean) => runtime.askLatest(includeScreen));
  ipcMain.handle('session:clear', () => runtime.clearSession());
  ipcMain.handle('screen:capturePreview', async () => {
    const capture = await captureWithPrivacy();
    try {
      return { dataUrl: capture.dataUrl, displayName: capture.displayName };
    } finally {
      capture.dispose();
    }
  });

  ipcMain.handle('window:hide', hideOverlay);
  ipcMain.handle('window:show', () => revealWindow({ interactive: true }));
  ipcMain.handle('window:openExternal', (_event, url: string) => openTrustedExternal(url));
}

function configureMediaCapture(): void {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(permission === 'media'),
  );
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        const source = sources.find((candidate) => candidate.display_id === String(display.id)) || sources[0];
        if (!source) return callback({});
        callback({ video: source, audio: 'loopback' });
      } catch (error) {
        console.error('[Main] System audio source failed:', error);
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => revealWindow({ interactive: true }));
  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.repglass.desktop');
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));
    registerRendererProtocol();
    configureMediaCapture();

    store = new SecureStore();
    runtime = new AssistantRuntime({
      codex,
      getApiKey: () => store.getOpenAIKey(),
      getSettings: () => store.getSettings(),
      webContents: () => mainWindow?.webContents ?? null,
      captureScreen: captureWithPrivacy,
    });

    registerIpc();
    createWindow();
    createTray();
    registerShortcuts();
    app.on('activate', () => revealWindow({ interactive: true }));
  });
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  hideOverlay();
});

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  runtime?.stop();
  codex.stop();
  destroyTray();
});
