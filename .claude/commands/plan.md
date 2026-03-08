# Claude Code Planning Prompt

You are entering a planning session. Before producing any implementation plan, you must complete two phases: **Project Setup Audit** and **Feature Planning**. Do not write any implementation code during this session. Your output is a plan and project scaffolding only.

---

## PHASE 1: Project Setup Audit

Before planning any feature, audit the current project's Claude Code infrastructure. Check for the existence and quality of each item below. For anything missing or incomplete, create it or recommend what I should add. Ask me clarifying questions where needed.

### 1.1 CLAUDE.md Files

Check whether the following files exist and are well-configured. If they don't exist, draft them. If they exist but are thin or missing key sections, propose additions.

**Project-level (`./CLAUDE.md` or `./.claude/CLAUDE.md`):**
- Common bash commands (build, test, lint, typecheck, dev server)
- Code style guidelines and naming conventions
- Architectural patterns and key abstractions
- Testing instructions and preferred patterns
- Repository workflow (branch naming, merge vs. rebase, PR conventions)
- Developer environment setup and prerequisites
- Known quirks, warnings, or gotchas
- Key files and directories with brief explanations of what they contain

IMPORTANT: Keep it under 200 lines. Every line should be actionable. Use "IMPORTANT" or "YOU MUST" sparingly and only on rules that Claude has previously violated or that are truly critical. Don't write a manual — write a briefing.

**Personal/local (`./CLAUDE.local.md`):**
- Check if this exists. Recommend creating it if the developer has personal preferences (sandbox URLs, preferred test data, local env differences) that shouldn't be checked in.

**User-level (`~/.claude/CLAUDE.md`):**
- Note whether this exists. Don't modify it without asking, but flag if project-level settings are duplicating or conflicting with user-level ones.

**Child directories:**
- For monorepos or projects with distinct modules, check whether subdirectories that contain meaningfully different code have their own CLAUDE.md files. If not, recommend which ones should.

### 1.2 .claudeignore

Check whether `.claudeignore` exists. If not, create one. At minimum it should exclude:

```
node_modules/
.venv/
vendor/
dist/
build/
.next/
__pycache__/
*.lock
*.min.js
*.map
coverage/
```

Add any project-specific build artifacts, generated files, or large asset directories.

### 1.3 Slash Commands

Check `.claude/commands/` for existing commands. Recommend creating any of these that don't exist and would be useful for this project:

- **commit-push-pr** — Commit, push, and open a PR in one step
- **fix-issue** — Pull a GitHub issue, analyze, implement, test, and PR
- **review** — Review the current diff for bugs, style issues, and missing tests
- **test-and-lint** — Run the full test suite, typecheck, and linter in sequence

Ask me which workflows I repeat most often — those should become commands.

### 1.4 Permissions and Settings

Check `.claude/settings.json`. Recommend allowlisting safe, frequently-used commands to reduce permission prompts:

```json
{
  "permissions": {
    "allow": [
      "Edit",
      "Bash(npm run *)",
      "Bash(git commit:*)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)"
    ]
  }
}
```

Tailor this to the actual project toolchain (npm, pnpm, yarn, cargo, go, etc.).

### 1.5 Hooks

Check `.claude/settings.json` for existing hooks. Recommend adding:

- **PostToolUse hook** for auto-formatting after file edits (prettier, black, rustfmt, etc.)
- **Stop hook** that runs typecheck and linter when Claude finishes a response

Flag the tradeoff: formatting hooks can consume significant context tokens. Recommend manual formatting between sessions if context budget is tight.

### 1.6 Subagents

Check `.claude/agents/` for existing agents. Recommend creating any of these that would be useful:

- **code-simplifier** — Simplifies and cleans up code after implementation
- **test-writer** — Writes tests for newly implemented code
- **reviewer** — Reviews changes for bugs, edge cases, and style issues

Each agent should have one clear goal, defined input/output, and scoped tool access.

### 1.7 MCP Servers

Check `.mcp.json` for configured servers. Based on the project type, recommend relevant ones (e.g., Puppeteer for web apps, database servers, Sentry for error tracking). Flag any MCP servers that might be dumping too much into context.

---

## PHASE 2: Feature Planning

Now plan the actual feature or task. Follow this process exactly.

### 2.1 Research

Before planning, deeply read and understand all relevant code. Do not skim — read the actual implementations, not just signatures. Use subagents for extensive codebase exploration to protect main context.

Investigate:
- What existing patterns and conventions does this codebase use?
- What files will be affected?
- What are the dependencies and downstream consumers?
- Are there similar features already implemented that should serve as templates?
- What tests exist for related functionality?

Write findings to `research.md` if the investigation is substantial (touching 5+ files or involving unfamiliar code).

### 2.2 Clarifying Questions

Before writing the plan, interview me. Ask about:
- Technical implementation preferences and constraints
- Edge cases I may not have considered
- UI/UX requirements (if applicable)
- Performance or security concerns
- Tradeoffs I should be aware of
- How this interacts with existing features

Don't ask obvious questions. Dig into the hard parts. Keep interviewing until we've covered everything important.

### 2.3 Write the Plan

Write a detailed implementation plan to `plan.md`. The plan must include:

1. **Summary** — One paragraph describing what we're building and why
2. **Files to modify/create** — Complete list with brief description of changes per file
3. **Implementation steps** — Ordered checklist of discrete tasks, each small enough to verify independently (aim for 5-10 minute chunks)
4. **Test strategy** — What tests to write, what to cover, whether to use TDD
5. **Verification steps** — How Claude will verify each piece works (run tests, typecheck, lint, visual check, etc.)
6. **Edge cases** — Identified edge cases and how they're handled
7. **Risks and dependencies** — What could go wrong, what this depends on, what depends on this
8. **Out of scope** — What we're explicitly NOT doing

### 2.4 Plan Quality Checklist

Before presenting the plan, self-verify against these criteria:

- [ ] Every step follows existing codebase conventions (don't invent new patterns)
- [ ] No unnecessary changes outside the scope
- [ ] Dependencies and side effects are accounted for
- [ ] Test coverage is specified for new and modified code
- [ ] Each step is small enough to commit independently
- [ ] The plan references specific files and patterns by name
- [ ] Edge cases are addressed, not just the happy path
- [ ] The plan could be handed to a different Claude session with zero additional context

---

## PHASE 3: Prepare for Execution

After I approve the plan, prepare the execution handoff:

### 3.1 Implementation Prompt

Draft the exact prompt I should use to kick off implementation in a fresh session:

> "Read plan.md and implement it fully. When you're done with each task or phase, mark it as completed in plan.md. Do not stop until all tasks and phases are completed. Do not add unnecessary comments or jsdocs. Continuously run [typecheck/build command] to make sure you're not introducing new issues. Run tests after each major change. Commit after each completed phase with a descriptive message."

Customize this with the actual project commands.

### 3.2 Session Strategy

Recommend how to structure the implementation sessions:
- Can this be done in one session, or should it be split?
- Are there independent pieces that could run in parallel (separate worktrees)?
- What's the recommended commit cadence?
- What should be preserved if context needs to be compacted mid-session?

### 3.3 CLAUDE.md Updates

If this feature introduces new patterns, conventions, or gotchas that future sessions should know about, draft the additions to CLAUDE.md that should be committed alongside the feature.

---

## Rules for This Session

1. **Do not write implementation code.** This is a planning session only.
2. **Think hard** about every recommendation. Use extended thinking.
3. **Be specific.** Reference actual file names, actual patterns, actual commands from this project.
4. **Ask questions** rather than assuming. If you're unsure about a convention or preference, ask.
5. **Read deeply** before recommending. Don't propose patterns that contradict what already exists in the codebase.
6. **Create files** for CLAUDE.md, .claudeignore, slash commands, and plan.md — don't just describe what they should contain.
7. **Keep context lean.** Use subagents for research. Don't load unnecessary files into the main context.
8. **Flag tradeoffs.** If there are competing approaches, present them with pros/cons rather than picking one silently.
