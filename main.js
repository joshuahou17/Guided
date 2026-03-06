const { app, globalShortcut, systemPreferences, dialog } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const logFile = require('node:path').join(require('node:os').tmpdir(), 'guided-debug.log');
function log(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  console.log(...args);
}
fs.writeFileSync(logFile, '');
log('=== Guided starting ===');

const { ensureDirectories } = require('./src/main/paths');
const { createTray } = require('./src/main/tray');
const { registerHotkey } = require('./src/main/global-hotkey');
let registerAllIpcHandlers;
try {
  ({ registerAllIpcHandlers } = require('./src/main/ipc-handlers'));
  log('ipc-handlers module loaded OK');
} catch (err) {
  log('FATAL: Failed to load ipc-handlers:', err.message, err.stack);
}
const { initDatabase } = require('./src/storage/database');

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Check & prompt for Screen Recording permission
function checkScreenPermission() {
  const hasAccess = systemPreferences.getMediaAccessStatus('screen');
  if (hasAccess !== 'granted') {
    // Trigger the macOS permission prompt by attempting a capture
    const tmp = require('node:path').join(require('node:os').tmpdir(), '_guided_perm_check.jpg');
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'jpg', tmp], (err) => {
      // Clean up temp file
      try { require('node:fs').unlinkSync(tmp); } catch {}
      if (err) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Screen Recording Permission',
          message: 'Guided needs Screen Recording permission to capture screenshots.',
          detail: 'Go to System Settings → Privacy & Security → Screen Recording and enable Guided (or Electron). Then restart the app.',
          buttons: ['Open System Settings', 'OK'],
        }).then(({ response }) => {
          if (response === 0) {
            require('electron').shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          }
        });
      }
    });
  }
}

app.whenReady().then(() => {
  ensureDirectories();
  initDatabase();
  createTray();
  registerHotkey();
  try {
    if (registerAllIpcHandlers) {
      registerAllIpcHandlers();
      log('IPC handlers registered OK');
    } else {
      log('FATAL: registerAllIpcHandlers is undefined');
    }
  } catch (err) {
    log('FATAL: IPC handler registration failed:', err.message, err.stack);
  }
  checkScreenPermission();
  log('Guided is ready. Log file:', logFile);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Keep app running as menubar app
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('second-instance', () => {
  const { showPopup } = require('./src/main/windows');
  showPopup();
});
