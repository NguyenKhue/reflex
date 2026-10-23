# Delegating to opencode (free model)

User rules (`~/.claude/rules/opencode-delegation.md`), summarised for this project. Runner:
`~/.claude/skills/opencode-worker/scripts/oc-run.sh` (load skill `opencode-worker`). Never bare `opencode run`.

## Rules
1. **Code only.** The prompt says: do NOT run any build/test command (`npm`, `node --test`); only edit files and
   report what changed. The main session runs ONE `npm test --prefix reflex` per task.
2. **Free model only** (default `opencode/space-bunny-free`). Exit 75 = model unavailable → follow the skill
   (probe, research, ask the user). Never switch on your own.
3. **Sequential** when two runs touch the same files. Small mechanical edits (≤ ~5 files) stay in the main session.
4. **Narrow prompts**: explicit file list (≤ ~5 to read), say "do not grep/find broadly, max N tool calls".
5. **No git here** (see AGENTS.md): do not tell the worker to commit. Take a baseline copy first and diff after.

## Per-task loop
```bash
# 1. baseline (once per task)
rsync -a --exclude node_modules ./ "$SCRATCH/reflex-base/"
# 2. delegate
OC=~/.claude/skills/opencode-worker/scripts/oc-run.sh
$OC -d /Users/khue/VSCodeProjects/reflex -t 900 "<prompt from the plan task>"
# 3. review: read the diff yourself, never trust the summary alone
diff -ru "$SCRATCH/reflex-base" . -x node_modules
# 4. one test pass in the main session
npm test --prefix reflex
# 5. fix or re-delegate (continue with -s <session-id>), then tick the task and update STATUS.md
```

## Prompt template
```
READ/EDIT scope: you may read <files> and may create/modify only <files>.
Task: <one paragraph, from the plan task>.
Interfaces: <exact signatures the task must produce / consume>.
Acceptance: <observable criteria; list of test cases the new test file must contain>.
Style: CommonJS, 2-space indent, single quotes, semicolons, English comments that explain WHY.
Constraints: Do NOT run npm, node --test or any build/test command. Only edit files and report what you changed.
Do not run git. Do not touch files outside the list. Never read or print .env or any secret value.
Tests: <the explicit test file(s) you must write>; they will be run by the caller, not by you.
```

## After each run — review checklist
- Diff touches only the allowed files; no secrets, no new dependencies, no behaviour change outside the task.
- New tests actually assert behaviour (not just "does not throw"); each acceptance case has a test.
- `npm test` count = baseline + new tests, 0 failures.

## Lessons (append as you learn)
- 2026-10-05: a task touching 4+ files can exceed the 600 s Bash limit even with `-t 720`, and the run is then killed.
  Use `run_in_background: true` with a long Bash `timeout` for tasks with more than ~3 files, and give the worker a short
  read list. If a run is killed, do NOT just retry: diff against the baseline first, the files are often already written.
- opencode (space-bunny-free) copies "verbatim from the plan" code exactly, so keep complete code in the plan for each task.
  It sometimes drops the trailing newline of a modified file; check the end of every file it edits.
- 2026-10-05: the free model can silently fail (exit 0, no files) or write GARBLED code (duplicated tokens such as
  `prefix   prefix`). After every run: `node --check <file>` for each JS file, compare verbatim-from-plan files with the plan block,
  check trailing newlines. If a run is bad, restore the baseline copy and retry in a FRESH session (a continued session kept the
  garbling), with "re-read each file after writing it and fix garbled tokens" in the prompt. A tiny read-only probe first tells
  you whether the model is healthy. Two failures in a row on a fresh session means: stop, follow the skill (probe, ask the user).
