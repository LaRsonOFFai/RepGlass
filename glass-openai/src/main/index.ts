import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, screen, globalShortcut } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantRuntime } from './assistantRuntime';
import { CodexService } from './codexService';
import { OpenAIService } from './openaiService';
import { SecureStore } from './secureStore';
import type { AppSettings, AudioChunkPayload } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'RepGlass';

if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), `${APP_NAME} Dev`));
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disk-cache-size', '0');
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SecureStore;
let runtime: AssistantRuntime;
let interactiveMode = true;
let visibleTestMode = false;

const openai = new OpenAIService();
const codex = new CodexService();

function createTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="8" fill="#101418"/>',
    '<path d="M8 17c2.8-5.2 13.2-5.2 16 0-2.8 5.2-13.2 5.2-16 0Z" fill="#76f7d1"/>',
    '<circle cx="16" cy="17" r="4" fill="#101418"/>',
    '<circle cx="16" cy="17" r="2" fill="#ffffff"/>',
    '</svg>',
  ].join('');
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function captureSafe(win: BrowserWindow) {
  win.setContentProtection(!visibleTestMode);
  win.on('show', () => win.setContentProtection(!visibleTestMode));
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
    console.warn('[Main] Could not parse renderer URL:', error);
  }

  return [...urls];
}

function loadRenderer(win: BrowserWindow, attempt = 1) {
  const rendererUrls = getRendererUrls();
  if (rendererUrls.length === 0) {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
    return;
  }

  const rendererUrl = rendererUrls[(attempt - 1) % rendererUrls.length];
  void win.loadURL(rendererUrl).catch((error) => {
    if (attempt >= 18 || win.isDestroyed()) {
      console.error('[Main] Failed to load renderer:', error);
      return;
    }

    const delayMs = Math.min(250 * attempt, 1500);
    console.warn(`[Main] Renderer not ready at ${rendererUrl} (${error.message}). Retrying in ${delayMs}ms...`);
    setTimeout(() => loadRenderer(win, attempt + 1), delayMs);
  });
}

function keepWindowOnScreen(win: BrowserWindow) {
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const bounds = win.getBounds();
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + Math.max(24, (area.height - height) / 4));

  win.setBounds({ x, y, width, height });
}

function setInteractionMode(enabled: boolean) {
  interactiveMode = enabled;

  if (!mainWindow || mainWindow.isDestroyed()) {
    updateTrayMenu();
    return;
  }

  mainWindow.setFocusable(enabled || visibleTestMode);
  mainWindow.setIgnoreMouseEvents(!enabled && !visibleTestMode, { forward: true });

  if (enabled || visibleTestMode) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow.blur();
  }

  console.log(`[Main] Overlay interaction: ${enabled ? 'interactive' : 'click-through'}`);
  updateTrayMenu();
}

function revealWindow(win: BrowserWindow, options: { interactive?: boolean } = {}) {
  keepWindowOnScreen(win);
  win.setContentProtection(!visibleTestMode);
  win.setOpacity(1);
  win.setBackgroundColor(visibleTestMode ? '#111820' : '#00000000');
  win.setAlwaysOnTop(true, 'screen-saver');

  if (options.interactive ?? interactiveMode) {
    win.show();
  } else {
    win.showInactive();
  }

  win.moveTop();
  setInteractionMode(options.interactive ?? interactiveMode);
  console.log('[Main] Overlay visible at', win.getBounds());
  updateTrayMenu();
}

function setVisibleTestMode(enabled: boolean) {
  visibleTestMode = enabled;

  if (!mainWindow || mainWindow.isDestroyed()) {
    updateTrayMenu();
    return;
  }

  mainWindow.setContentProtection(!enabled);
  mainWindow.setBackgroundColor(enabled ? '#111820' : '#00000000');
  mainWindow.setSkipTaskbar(!enabled);
  mainWindow.setHasShadow(enabled);

  if (enabled) {
    revealWindow(mainWindow, { interactive: true });
  } else {
    setInteractionMode(true);
    revealWindow(mainWindow, { interactive: true });
  }

  console.log(`[Main] Visible test mode: ${enabled ? 'on' : 'off'}`);
}

function wireWindowDiagnostics(win: BrowserWindow) {
  win.webContents.on('console-message', (event) => {
    const details = event as Electron.Event<Electron.WebContentsConsoleMessageEventParams>;
    console.log(
      `[Renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`,
    );
  });
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    console.error(`[Main] Renderer failed to load ${validatedUrl}: ${description} (${code})`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer process gone:', details);
  });
  win.webContents.on('dom-ready', () => {
    const probeDom = () => {
      void win.webContents
        .executeJavaScript(
          `({
            href: location.href,
            hasGlassApi: Boolean(window.glass),
            rootChildren: document.getElementById('root')?.childElementCount ?? -1,
            bodyText: document.body.innerText.slice(0, 160)
          })`,
        )
        .then((state) => console.log('[Main] Renderer DOM state:', state))
        .catch((error) => console.error('[Main] Renderer DOM probe failed:', error));
    };

    probeDom();
    setTimeout(probeDom, 900);
  });
}

function createWindow() {
  const settings = store.getSettings();
  let didAutoReveal = false;

  mainWindow = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 420,
    minHeight: 360,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    skipTaskbar: true,
    show: false,
    resizable: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  captureSafe(mainWindow);
  wireWindowDiagnostics(mainWindow);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  setInteractionMode(true);

  const autoReveal = () => {
    if (!mainWindow || mainWindow.isDestroyed() || didAutoReveal) return;
    didAutoReveal = true;
    if (!settings.startInTray) {
      revealWindow(mainWindow, { interactive: true });
    }
  };

  mainWindow.once('ready-to-show', autoReveal);
  mainWindow.webContents.once('did-finish-load', () => setTimeout(autoReveal, 100));

  loadRenderer(mainWindow);

  if (process.env.GLASS_OPEN_DEVTOOLS === 'true') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function showOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealWindow(mainWindow, { interactive: true });
  }
}

function showInteractiveOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealWindow(mainWindow, { interactive: true });
  }
}

function hideOverlay() {
  mainWindow?.hide();
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const listening = runtime?.isListening() ?? false;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? `Hide ${APP_NAME}` : `Open ${APP_NAME}`,
        click: () => (visible ? hideOverlay() : showOverlay()),
      },
      {
        label: interactiveMode ? 'Click-through Mode' : 'Interactive Mode',
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
            showInteractiveOverlay();
          } else {
            setInteractionMode(!interactiveMode);
          }
        },
      },
      {
        label: visibleTestMode ? 'Disable Visible Test' : 'Visible Test Mode',
        click: () => setVisibleTestMode(!visibleTestMode),
      },
      {
        label: listening ? 'Stop Listening' : 'Start Listening',
        click: () => {
          if (listening) runtime.stop();
          else {
            showOverlay();
            runtime.start();
          }
          updateTrayMenu();
        },
      },
      { label: 'OpenAI Auth', click: () => showInteractiveOverlay() },
      { type: 'separator' },
      { label: 'Toggle interaction: Ctrl+Shift+G', enabled: false },
      { label: 'Visible test: Ctrl+Shift+H', enabled: false },
      { label: 'Screen-share invisibility: On', enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) setInteractionMode(!interactiveMode);
    else showOverlay();
  });
  updateTrayMenu();
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
      showInteractiveOverlay();
      return;
    }

    setInteractionMode(!interactiveMode);
  });

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
    setVisibleTestMode(!visibleTestMode);
  });
}

async function getAuthState() {
  const codexStatus = await codex.getStatus();
  console.log('[Main] Codex auth status:', {
    available: codexStatus.available,
    loggedIn: codexStatus.loggedIn,
    method: codexStatus.method,
    version: codexStatus.version,
    error: codexStatus.error,
  });
  return store.getAuthState(codexStatus);
}

function registerIpc() {
  ipcMain.handle('auth:getState', () => getAuthState());

  ipcMain.handle('auth:saveApiKey', async (_event, apiKey: string) => {
    const validation = await openai.validateApiKey(apiKey);
    if (!validation.success) return validation;
    store.saveOpenAIKey(apiKey);
    return { success: true, auth: await getAuthState() };
  });

  ipcMain.handle('auth:clearApiKey', async () => {
    store.clearOpenAIKey();
    return await getAuthState();
  });

  ipcMain.handle('auth:codexStatus', () => codex.getStatus());

  ipcMain.handle('auth:startCodexLogin', async () => {
    codex.startLogin();
    return await codex.getStatus();
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>) => store.updateSettings(patch));

  ipcMain.handle('listen:start', () => {
    runtime.start();
    updateTrayMenu();
    return { success: true };
  });

  ipcMain.handle('listen:stop', () => {
    runtime.stop();
    updateTrayMenu();
    return { success: true };
  });

  ipcMain.handle('listen:audioChunk', async (_event, payload: AudioChunkPayload) => {
    await runtime.handleAudioChunk(payload);
    return { success: true };
  });

  ipcMain.handle('ask:send', async (_event, question: string) => runtime.ask(question));

  ipcMain.handle('window:hide', () => hideOverlay());
  ipcMain.handle('window:show', () => showOverlay());
  ipcMain.handle('window:openExternal', (_event, url: string) => shell.openExternal(url));
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.local.repglass');
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));

  store = new SecureStore();
  runtime = new AssistantRuntime({
    getApiKey: () => store.getOpenAIKey(),
    getSettings: () => store.getSettings(),
    webContents: () => mainWindow?.webContents ?? null,
  });

  registerIpc();
  createWindow();
  createTray();
  registerShortcuts();

  app.on('activate', () => showOverlay());
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  hideOverlay();
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  runtime?.stop();
});
