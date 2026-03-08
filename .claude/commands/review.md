Review the current uncommitted changes for bugs, style issues, and missing error handling.

Steps:
1. Run `git diff` to see all changes
2. Run `git diff --cached` to see staged changes
3. For each changed file, check:
   - Does it follow the existing CommonJS pattern?
   - Are there unhandled promise rejections or missing try/catch?
   - Could any change crash the main Electron process?
   - Are new IPC channels exposed in preload.js?
   - Is logging added for debuggability?
4. Run `node -c` syntax check on all changed .js files
5. Report findings with file:line references
