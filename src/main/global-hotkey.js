const { globalShortcut } = require('electron');

let currentHotkey = 'CommandOrControl+Shift+Space';
const NEXT_STEP_HOTKEY = 'CommandOrControl+Shift+Right';

function registerHotkey(hotkey) {
  if (hotkey) currentHotkey = hotkey;

  // Toggle popup visibility
  const success = globalShortcut.register(currentHotkey, () => {
    const { getPopupWindow, showPopup, hidePopup } = require('./windows');
    const popup = getPopupWindow();
    if (popup && !popup.isDestroyed() && popup.isVisible()) {
      hidePopup();
    } else {
      showPopup();
    }
  });

  if (!success) {
    console.warn(`Failed to register hotkey: ${currentHotkey}`);
  }

  // Next step hotkey (⌘+Shift+Right)
  const nextSuccess = globalShortcut.register(NEXT_STEP_HOTKEY, () => {
    const { getActiveSession, advanceStep } = require('../core/session-loop');
    if (getActiveSession()) {
      advanceStep();
    }
  });

  if (!nextSuccess) {
    console.warn(`Failed to register next-step hotkey: ${NEXT_STEP_HOTKEY}`);
  }

  return success;
}

function unregisterHotkey() {
  if (currentHotkey) {
    globalShortcut.unregister(currentHotkey);
  }
  try {
    globalShortcut.unregister(NEXT_STEP_HOTKEY);
  } catch { /* may not be registered */ }
}

function updateHotkey(newHotkey) {
  unregisterHotkey();
  return registerHotkey(newHotkey);
}

module.exports = { registerHotkey, unregisterHotkey, updateHotkey };
