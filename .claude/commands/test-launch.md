Launch the app in dev mode, watch the debug log for errors, and report any issues.

Steps:
1. Run `npm run dev` in the background
2. Wait 5 seconds for startup
3. Tail the debug log at `$TMPDIR/guided-debug.log` for the last 50 lines
4. Report any errors, warnings, or unexpected behavior
5. Kill the Electron process when done
