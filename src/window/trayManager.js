const { app, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const askService = require('../features/ask/askService');
const listenService = require('../features/listen/listenService');
const shortcutsService = require('../features/shortcuts/shortcutsService');

let tray = null;
let isQuitting = false;
const captureHideReasons = new Set();

app.on('before-quit', () => {
    isQuitting = true;
    captureHideReasons.clear();
});

function getWindowManager() {
    return require('./windowManager');
}

function getTrayIconPath() {
    const assetsDir = path.join(__dirname, '../ui/assets');
    if (process.platform === 'win32') return path.join(assetsDir, 'logo.ico');
    if (process.platform === 'darwin') return path.join(assetsDir, 'logoTemplate.png');
    return path.join(assetsDir, 'logo.png');
}

function getTrayIcon() {
    let icon = nativeImage.createFromPath(getTrayIconPath());
    if (icon.isEmpty() && process.platform === 'darwin') {
        icon = nativeImage.createFromPath(path.join(__dirname, '../ui/assets/logo.png'));
    }
    if (process.platform === 'darwin' && !icon.isEmpty()) {
        icon.setTemplateImage(true);
    }
    return icon;
}

async function withMenuRefresh(action) {
    try {
        await action();
    } catch (error) {
        console.error('[TrayManager] Tray action failed:', error);
    } finally {
        updateMenu();
    }
}

function showMainInterface() {
    const windowManager = getWindowManager();
    windowManager.showMainInterface();
    shortcutsService.allWindowVisibility = true;
}

async function hideAllWindows() {
    await shortcutsService.setAllWindowsVisibility(false);
}

async function toggleMainInterface() {
    const windowManager = getWindowManager();
    if (windowManager.hasVisibleWindow()) {
        await hideAllWindows();
    } else {
        showMainInterface();
        await shortcutsService.registerShortcuts();
    }
}

async function startListening() {
    const windowManager = getWindowManager();
    windowManager.ensureFeatureWindows(['listen', 'ask', 'settings', 'shortcut-settings']);
    await windowManager.waitForWindowReady('listen');
    showMainInterface();
    await listenService.handleListenRequest('Listen');
}

async function stopListening() {
    await listenService.handleListenRequest('Stop');
}

async function toggleAsk() {
    const windowManager = getWindowManager();
    windowManager.ensureFeatureWindows(['ask']);
    await windowManager.waitForWindowReady('ask');
    showMainInterface();
    await askService.toggleAskButton();
}

function openSettings() {
    const windowManager = getWindowManager();
    windowManager.ensureFeatureWindows(['settings', 'shortcut-settings']);
    showMainInterface();
    windowManager.showSettingsWindow();
}

function updateMenu() {
    if (!tray) return;

    const windowManager = getWindowManager();
    const isVisible = windowManager.hasVisibleWindow();
    const isListening = listenService.isSessionActive();
    const isProtected = windowManager.getContentProtectionStatus();

    const template = [
        {
            label: isVisible ? 'Hide RepGlass' : 'Open RepGlass',
            click: () => withMenuRefresh(toggleMainInterface),
        },
        {
            label: isListening ? 'Stop Listening' : 'Start Listening',
            click: () => withMenuRefresh(isListening ? stopListening : startListening),
        },
        {
            label: 'Ask',
            click: () => withMenuRefresh(toggleAsk),
        },
        {
            label: 'Settings',
            click: () => withMenuRefresh(openSettings),
        },
        { type: 'separator' },
        {
            label: isProtected ? 'Screen-share invisibility: On' : 'Screen-share invisibility: Restoring',
            enabled: false,
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => app.quit(),
        },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
}

function hideForCapture(reason = 'capture') {
    captureHideReasons.add(reason);
    if (!tray) return;

    try {
        tray.destroy();
    } catch (error) {
        console.warn('[TrayManager] Failed to hide tray icon:', error.message);
    } finally {
        tray = null;
    }
}

function showAfterCapture(reason = 'capture') {
    captureHideReasons.delete(reason);
    if (captureHideReasons.size > 0 || tray || isQuitting) return tray;
    return initialize();
}

function isHiddenForCapture() {
    return captureHideReasons.size > 0;
}

function initialize() {
    if (captureHideReasons.size > 0 || isQuitting) {
        return null;
    }

    if (tray) {
        updateMenu();
        return tray;
    }

    tray = new Tray(getTrayIcon());
    tray.setToolTip('RepGlass');
    tray.on('click', () => withMenuRefresh(toggleMainInterface));
    tray.on('right-click', updateMenu);
    tray.on('double-click', () => withMenuRefresh(showMainInterface));

    if (process.platform === 'darwin') {
        app.dock?.hide();
    }

    updateMenu();
    return tray;
}

module.exports = {
    initialize,
    updateMenu,
    hideForCapture,
    showAfterCapture,
    isHiddenForCapture,
};
