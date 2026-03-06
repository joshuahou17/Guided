const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('node:path');

let tray = null;

function createTray() {
  // Create a simple 22x22 template image for the menubar
  // Using a small inline PNG (compass arrow icon)
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');

  // If no icon file exists, create a basic one from a nativeImage
  let image;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: create a simple 22x22 template image
    image = nativeImage.createEmpty();
    // We'll use a data URL for a simple arrow icon
    const size = 22;
    const canvas = Buffer.alloc(size * size * 4, 0);
    // Draw a simple "G" pattern in white pixels
    // Just make a filled circle-ish shape
    for (let y = 4; y < 18; y++) {
      for (let x = 4; x < 18; x++) {
        const cx = x - 11, cy = y - 11;
        const dist = Math.sqrt(cx * cx + cy * cy);
        if (dist < 7 && dist > 4) {
          const idx = (y * size + x) * 4;
          canvas[idx] = 0;       // R
          canvas[idx + 1] = 0;   // G
          canvas[idx + 2] = 0;   // B
          canvas[idx + 3] = 255; // A
        }
        // Inner arrow pointing right
        if (y >= 9 && y <= 13 && x >= 10 && x <= 16 && dist < 7) {
          const idx = (y * size + x) * 4;
          canvas[idx] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
          canvas[idx + 3] = 255;
        }
      }
    }
    image = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('Guided');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'New Session',
      click: () => {
        const { showPopup } = require('./windows');
        showPopup();
      },
    },
    {
      label: 'Open Dashboard',
      accelerator: 'CommandOrControl+Shift+G',
      click: () => {
        const { showDashboard } = require('./windows');
        showDashboard();
      },
    },
    { type: 'separator' },
    {
      label: 'Settings...',
      click: () => {
        const fs = require('node:fs');
        const logFile = require('node:path').join(require('node:os').tmpdir(), 'guided-debug.log');
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] Tray Settings clicked\n`);
        try {
          const { showDashboard } = require('./windows');
          showDashboard('settings');
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] showDashboard('settings') completed\n`);
        } catch (err) {
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] Settings error: ${err.message}\n${err.stack}\n`);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Guided',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click on tray icon also opens popup
  tray.on('click', () => {
    const { showPopup } = require('./windows');
    showPopup();
  });

  return tray;
}

function getTray() {
  return tray;
}

module.exports = { createTray, getTray };
