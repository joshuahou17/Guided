/**
 * Global mouse click listener for macOS.
 *
 * Spawns a persistent osascript (JXA) process that uses Cocoa's
 * NSEvent.addGlobalMonitorForEventsMatchingMask to detect left-mouse-down
 * events globally. Reports click coordinates so callers can filter clicks
 * that land on specific windows (e.g. the Guided popup itself).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const logFile = path.join(os.tmpdir(), 'guided-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] [ClickListener] ${msg}\n`);
}

let clickProcess = null;
let clickCallback = null;
let firstClickLogged = false;

// Report click coordinates as "click:x,y\n"
const JXA_SCRIPT = `
ObjC.import('Cocoa');
ObjC.import('stdlib');

// Monitor left mouse down events globally (mask bit 1 = NSEventMaskLeftMouseDown)
var mask = (1 << 1);
$.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(mask, function(event) {
  // Get click location in screen coordinates (flipped: origin at bottom-left)
  var loc = event.locationInWindow;
  // Convert from bottom-left origin to top-left origin
  var screenH = $.NSScreen.mainScreen.frame.size.height;
  var x = Math.round(loc.x);
  var y = Math.round(screenH - loc.y);
  var msg = "click:" + x + "," + y + "\\\\n";
  var str = $.NSString.alloc.initWithUTF8String(msg);
  var data = str.dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
});

// Keep alive via CFRunLoop
$.CFRunLoopRun();
`;

/**
 * Start listening for global mouse clicks.
 * @param {function({x: number, y: number})} callback — called with click coordinates
 */
function startListening(callback) {
  if (clickProcess) {
    stopListening();
  }

  clickCallback = callback;
  firstClickLogged = false;

  try {
    clickProcess = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log(`Started global click listener (pid: ${clickProcess.pid})`);

    clickProcess.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('click:') && clickCallback) {
          const coords = trimmed.slice(6).split(',');
          const x = parseInt(coords[0], 10);
          const y = parseInt(coords[1], 10);
          if (!isNaN(x) && !isNaN(y)) {
            if (!firstClickLogged) {
              log(`First click received at (${x}, ${y}) — pipeline active`);
              firstClickLogged = true;
            }
            clickCallback({ x, y });
          }
        }
      }
    });

    clickProcess.stderr.on('data', (chunk) => {
      log(`stderr: ${chunk.toString().trim()}`);
    });

    clickProcess.on('error', (err) => {
      log(`Process error: ${err.message}`);
    });

    clickProcess.on('exit', (code) => {
      log(`Process exited with code ${code}`);
      clickProcess = null;
    });

  } catch (err) {
    log(`Failed to start: ${err.message}`);
  }
}

function stopListening() {
  if (clickProcess) {
    try {
      clickProcess.kill();
    } catch {
      // Already dead
    }
    clickProcess = null;
  }
  clickCallback = null;
  log('Stopped global click listener');
}

module.exports = { startListening, stopListening };
