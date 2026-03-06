const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

/**
 * Get info about the frontmost application window using JXA (JavaScript for Automation).
 * Returns { appName, windowId, windowTitle, bounds: { x, y, w, h } }
 */
function getFrontmostAppInfo() {
  return new Promise((resolve, reject) => {
    const jxa = `
      ObjC.import('CoreGraphics');
      ObjC.import('Cocoa');

      // Get frontmost app
      const workspace = $.NSWorkspace.sharedWorkspace;
      const frontApp = workspace.frontmostApplication;
      const appName = ObjC.unwrap(frontApp.localizedName);
      const pid = frontApp.processIdentifier;

      // Get window list
      const windowList = ObjC.unwrap(
        $.CGWindowListCopyWindowInfo(
          $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
          0
        )
      );

      let result = null;
      for (let i = 0; i < windowList.count; i++) {
        const w = ObjC.unwrap(windowList.objectAtIndex(i));
        const ownerPid = ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID'));
        const layer = ObjC.unwrap(w.objectForKey('kCGWindowLayer'));

        if (ownerPid === pid && layer === 0) {
          const windowId = ObjC.unwrap(w.objectForKey('kCGWindowNumber'));
          const windowName = ObjC.unwrap(w.objectForKey('kCGWindowName')) || '';
          const bounds = ObjC.unwrap(w.objectForKey('kCGWindowBounds'));
          result = JSON.stringify({
            appName: appName,
            windowId: windowId,
            windowTitle: windowName,
            bounds: {
              x: ObjC.unwrap(bounds.objectForKey('X')),
              y: ObjC.unwrap(bounds.objectForKey('Y')),
              w: ObjC.unwrap(bounds.objectForKey('Width')),
              h: ObjC.unwrap(bounds.objectForKey('Height'))
            }
          });
          break;
        }
      }

      if (!result) {
        // Fallback: return app name with no specific window
        result = JSON.stringify({
          appName: appName,
          windowId: null,
          windowTitle: '',
          bounds: null
        });
      }
      result;
    `;

    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`osascript failed: ${err.message} ${stderr}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Failed to parse window info: ${stdout}`));
      }
    });
  });
}

/**
 * Capture a specific window by its CGWindowID.
 * Falls back to full screen capture if windowId is null.
 */
function captureWindow(windowId, outputPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const args = windowId
      ? [`-l${windowId}`, '-x', '-t', 'jpg', '-o', outputPath]
      : ['-x', '-t', 'jpg', outputPath];

    execFile('/usr/sbin/screencapture', args, (err) => {
      if (err) return reject(new Error(`screencapture failed: ${err.message}`));
      if (!fs.existsSync(outputPath)) {
        return reject(new Error('Screenshot file was not created'));
      }
      resolve(outputPath);
    });
  });
}

/**
 * Capture the full screen (all displays merged).
 */
function captureFullScreen(outputPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    execFile('/usr/sbin/screencapture', ['-x', '-t', 'jpg', outputPath], (err) => {
      if (err) return reject(new Error(`screencapture failed: ${err.message}`));
      if (!fs.existsSync(outputPath)) {
        return reject(new Error('Screenshot file was not created'));
      }
      resolve(outputPath);
    });
  });
}

/**
 * Capture a window (or full screen if windowId is null) and resize to max width for Claude API.
 * Returns { path, width, height }.
 */
async function captureAndResize(windowId, outputPath, maxWidth = 1280) {
  // Capture to a temp path first
  const tempPath = outputPath + '.tmp.jpg';
  if (windowId) {
    await captureWindow(windowId, tempPath);
  } else {
    await captureFullScreen(tempPath);
  }

  // Resize with sharp
  const metadata = await sharp(tempPath).metadata();
  if (metadata.width > maxWidth) {
    await sharp(tempPath)
      .resize(maxWidth, null, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toFile(outputPath);
    fs.unlinkSync(tempPath);
  } else {
    // Just compress
    await sharp(tempPath)
      .jpeg({ quality: 60 })
      .toFile(outputPath);
    fs.unlinkSync(tempPath);
  }

  // Read actual resized dimensions
  const resizedMeta = await sharp(outputPath).metadata();

  return { path: outputPath, width: resizedMeta.width, height: resizedMeta.height };
}

module.exports = {
  getFrontmostAppInfo,
  captureWindow,
  captureFullScreen,
  captureAndResize,
};
