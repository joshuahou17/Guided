const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function wlog(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
}

const PRELOAD_PATH = path.join(__dirname, '..', 'renderers', 'preload.js');
const POPUP_HTML = path.join(__dirname, '..', 'renderers', 'popup.html');
const DASHBOARD_HTML = path.join(__dirname, '..', 'renderers', 'dashboard.html');

let popupWin = null;
let dashboardWin = null;

// --- Popup ---

function createPopup() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  popupWin = new BrowserWindow({
    width: 320,
    height: 260,
    x: screenW - 320 - 16,
    y: 16,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH,
    },
  });

  popupWin.setWindowButtonVisibility(false);
  popupWin.loadFile(POPUP_HTML);

  // Capture renderer console output to log file
  popupWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    wlog(`[Popup Renderer] ${message} (line ${line})`);
  });

  popupWin.webContents.on('did-finish-load', () => {
    wlog('[Popup] Page loaded successfully');
  });

  popupWin.webContents.on('did-fail-load', (_e, code, desc) => {
    wlog('[Popup] FAILED to load:', code, desc);
  });

  popupWin.webContents.on('render-process-gone', (_e, details) => {
    wlog('[Popup] Renderer CRASHED:', JSON.stringify(details));
  });

  popupWin.on('closed', () => {
    popupWin = null;
  });

  popupWin.on('blur', () => {
    // Don't hide on blur — user may be interacting with the target app
  });

  return popupWin;
}

function showPopup() {
  if (!popupWin || popupWin.isDestroyed()) {
    createPopup();
  }
  popupWin.show();
  popupWin.focus();
  return popupWin;
}

function hidePopup() {
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.hide();
  }
}

function showPopupInactive() {
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.showInactive();
  }
}

function getPopupWindow() {
  return popupWin;
}

/**
 * Resize the popup window, anchored to top-right.
 */
function resizePopup(width, height) {
  if (!popupWin || popupWin.isDestroyed()) return;

  const bounds = popupWin.getBounds();
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;

  // Keep anchored to top-right
  const newX = screenW - width - 16;

  popupWin.setBounds({
    x: newX,
    y: bounds.y,
    width,
    height,
  }, true); // animate = true
}

// Register IPC handler for popup resize
ipcMain.on('popup:resize', (_event, width, height) => {
  resizePopup(width, height);
});

// --- Dashboard ---

function createDashboard() {
  console.log('[Dashboard] Creating window, HTML path:', DASHBOARD_HTML);
  dashboardWin = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Guided \u2014 Dashboard',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH,
    },
  });

  dashboardWin.loadFile(DASHBOARD_HTML);

  dashboardWin.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[Dashboard] Failed to load:', code, desc);
  });

  dashboardWin.on('closed', () => {
    dashboardWin = null;
  });

  return dashboardWin;
}

function showDashboard(tab) {
  console.log('[Dashboard] showDashboard called, tab:', tab);
  const isNew = !dashboardWin || dashboardWin.isDestroyed();
  if (isNew) {
    createDashboard();
  }
  dashboardWin.show();
  dashboardWin.focus();
  if (tab) {
    if (isNew) {
      dashboardWin.webContents.once('did-finish-load', () => {
        console.log('[Dashboard] Page loaded, switching to tab:', tab);
        dashboardWin.webContents.send('dashboard:switch-tab', tab);
      });
    } else {
      dashboardWin.webContents.send('dashboard:switch-tab', tab);
    }
  }
  return dashboardWin;
}

function getDashboardWindow() {
  return dashboardWin;
}

module.exports = {
  showPopup,
  hidePopup,
  showPopupInactive,
  getPopupWindow,
  resizePopup,
  showDashboard,
  getDashboardWindow,
};
