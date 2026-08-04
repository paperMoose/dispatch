# Spec: pluggable agent runtimes (Claude Code + Codex)

Status: draft, ready to build
Target version: dispatch 0.9.0

## Goal

`dispatch run` can launch either Claude Code or Codex, with any model that CLI
supports. Every other dispatch command (`list`, `status`, `logs`, `stop`,
`resume`, `cleanup`, `schedule`, and the MCP tools) behaves identically no
matter which CLI is behind the agent.

Non-goals for this version: a third runtime (Gemini, opencode, cursor-agent),
mixing two runtimes inside one agent, or changing how worktrees and tmux/cmux
sessions are managed.

## Locked decisions

1. ~~**Explicit `--agent` flag.** No inference from model names.~~ **Reversed
   2026-08-04.** `--model` now selects the runtime when the model name clearly
   belongs to one, because the orthogonal version produced a silent failure:
   with `agent: codex` configured, `-m opus` built `codex -m opus`, which codex
   rejects with a 400 as the prompt lands. The agent then looks like one that
   never started. `--agent` still wins when typed explicitly, and a typed
   `--agent` that contradicts the model is refused rather than guessed.
2. **Interactive is the default and primary path for both runtimes.** A human
   needs to be able to steer a dispatched ticket mid-run. Headless is supported
   for both, but interactive is what has to work first.
3. **Permissions off by default for both runtimes.** Permission prompts break
   autonomous operation. The only things that should stop for a human are
   pushing to prod, merging to prod, and mutating prod data (see Phase 3).
4. **Codex default posture is `--dangerously-bypass-approvals-and-sandbox`.**
   `--ask` maps to `-s workspace-write -a on-request`.

## Grounded findings

Probed against `codex-cli 0.144.3` installed on this machine. These are
observed, not assumed, and they drive the design below.

| # | Finding | Consequence |
|---|---------|-------------|
| 1 | `codex exec --json` emits JSONL: `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`. | Maps onto `.dispatch.log` and `parseAgentLog` with a per-runtime parser. |
| 2 | Item types observed: `agent_message` (`.text`), `command_execution` (`.command`, `.exit_code`, `.status`), `file_change` (`.changes[].path`, `.kind`). | Enough to fill turns / files / commits / actions / last text. |
| 3 | `thread.started` carries `thread_id`, and sessions persist to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. | Resume works without dispatch tracking session IDs itself. |
| 4 | The TUI does **not** use the alternate screen (`alternate_on=0`). | `tmux capture-pane -p` works for readiness and idle detection, same as Claude. |
| 5 | TUI ready state renders a box containing `>_ OpenAI Codex (v0.144.3)` and a footer `Use /skills to list available skills`. | Gives a readiness marker for `waitForClaude`'s replacement. |
| 6 | While working, the pane shows `◦ Working (11s • esc to interrupt)`. | Gives a busy marker for `dispatch list` idle detection. |
| 7 | `tmux load-buffer` + `paste-buffer` + `send-keys Enter` submits a prompt to the TUI correctly, including multi-line text. | The existing interactive injection mechanism transfers as-is. |
| 8 | On startup codex may render a blocking **"Update available"** menu (`1. Update now / 2. Skip / 3. Skip until next version`) that swallows the first keystrokes. | Must be suppressed, or prompt injection lands in the wrong widget. Config key `check_for_update_on_startup` exists. |
| 9 | A new directory is untrusted until recorded in `~/.codex/config.toml` under `[projects."<path>"]`. Passing `-s <mode>` skips the trust dialog; **`--dangerously-bypass-approvals-and-sandbox` does not** (confirmed during implementation: every fresh worktree stalled on "Do you trust the contents of this directory?"). | The dialog must be dismissed by the readiness loop, not avoided by flags. |
| 10 | `pane_current_command` for a running codex TUI is `node`, not `codex`. | Any process-name based detection must stay content-based. |
| 11 | Codex execpolicy `.rules` files use `prefix_rule(pattern=[...], decision="allow"\|"prompt"\|"reject")`. | Candidate mechanism for the prod guard on the codex side. |
| 12 | `codex exec` reads the prompt from stdin when stdin is piped. | The existing `< '<prompt-file>'` redirection transfers as-is. |

## Architecture

New file `src/agents.ts` holding one adapter per runtime. Everything
runtime-specific moves behind this interface; nothing else in the codebase
should mention `claude` or `codex` by name.

```ts
export type AgentKind = "claude" | "codex";

export interface AgentAdapter {
  kind: AgentKind;
  bin: string;

  /** Launch line for an interactive pane. Prompt is pasted in afterwards. */
  interactiveCmd(config: Config, resume: boolean): string;

  /** Launch line for headless. Writes the prompt file, returns the full command. */
  headlessCmd(prompt: string, wtPath: string, config: Config, opts: {
    resume: boolean;
    extraArgs: string;
  }): string;

  /** Prefix applied to both launch lines (e.g. `unset CLAUDECODE && `). */
  shellPrefix: string;

  /** Pane content shows the TUI is up and accepting input. */
  isReady(content: string): boolean;

  /** Pane content shows the agent is mid-turn (used for running vs idle). */
  isBusy(content: string): boolean;

  /** Pane content shows a blocking startup dialog; returns keys to dismiss it. */
  dismissStartupDialog?(content: string): string | null;

  /** Normalize this runtime's log stream into the shared status shape. */
  parseLog(content: string): AgentLogSummary;
}

export function getAdapter(kind: AgentKind): AgentAdapter;
```

`AgentLogSummary` is the existing return type of `parseAgentLog`
(`turns`, `filesModified`, `toolsUsed`, `commits`, `lastActions`, `lastText`),
lifted into a named type. Keeping that shape means `formatStatus`, `cmdStatus`,
`cmdList`, `cmdNotifyDone` and the MCP handlers need no changes at all.

### Command mapping

| Concept | Claude adapter | Codex adapter |
|---|---|---|
| Interactive launch | `claude --model X --permission-mode dontAsk --allowedTools "WebSearch,WebFetch"` | `codex -m X --dangerously-bypass-approvals-and-sandbox --search -c check_for_update_on_startup=false` |
| Model config key | `model` | `codex_model` (separate: model names are not portable) |
| Interactive resume | `claude --continue …` | `codex resume --last …` |
| Headless launch | `claude -p --model X --allowedTools "…" --output-format stream-json --verbose < prompt` | `codex exec --json -m X --dangerously-bypass-approvals-and-sandbox < prompt` (no `--search`, no `-c check_for_update_on_startup`: `codex exec` rejects both) |
| Headless resume | `claude -p --continue …` | `codex exec resume --last …` |
| Permissions off | `--permission-mode dontAsk` | `--dangerously-bypass-approvals-and-sandbox` |
| `--ask` | `--permission-mode ""` | `-s workspace-write -a on-request` |
| Max turns | `--max-turns N` | no equivalent; warn and ignore |
| Max budget | `--max-budget-usd N` | no equivalent; warn and ignore |
| Allowed tools | `--allowedTools` | no equivalent; sandbox flags cover it |
| Log stream | stream-json | `--json` JSONL |
| Turn count | `type == "assistant"` | `type == "turn.completed"` |
| File edits | `tool_use` Edit/Write + `input.file_path` | `item.completed` / `file_change` / `changes[].path` |
| Shell commands | `tool_use` Bash + `input.command` | `item.completed` / `command_execution` / `.command` |
| Last message | `content[].type == "text"` | `item.completed` / `agent_message` / `.text` |
| Ready marker | `❯ \| Claude Code v\d \| ╭─ \| ? for shortcuts` | `>_ OpenAI Codex \(v \| Use /skills to list` |
| Busy marker | `esc to interrupt` | `◦ Working \( \| esc to interrupt` |
| Shell prefix | `unset CLAUDECODE && ` | none |
| Instructions file | `CLAUDE.md` | `AGENTS.md` |

`--max-turns` and `--max-budget` have no codex equivalent. When either is set
with `--agent codex`, print one warning line and continue rather than failing.
Note this also disables the `_track-progress` pipe-pane progress bar for codex
headless agents, since that feature keys off `maxTurns`.

## Phase 1: adapter plumbing (no behavior change)

Extract the existing Claude behavior into `ClaudeAdapter` and route all call
sites through `getAdapter(config.agent)`. Default `agent: "claude"`, so this
phase is a pure refactor and existing tests must pass unmodified.

Call sites to route:

- `src/commands.ts:110` `buildClaudeCmd` becomes `buildAgentCmd`, delegating to
  `adapter.headlessCmd`. Keep the old export name as a thin alias so the
  existing tests keep compiling during the refactor.
- `src/commands.ts:145` `interactiveClaudeCmd` becomes `interactiveAgentCmd`.
- `src/commands.ts:249,269,280,299` the hardcoded `unset CLAUDECODE && ` prefix
  becomes `adapter.shellPrefix`.
- `src/commands.ts:1027,1034,1040,1055` the same, in `cmdResume`, plus
  `--continue` becomes `adapter`-supplied resume args.
- `src/commands.ts:708` `parseAgentLog` delegates to `adapter.parseLog`.
- `src/commands.ts:1210` idle detection (`!/claude/i.test(lastLine)`) becomes
  `adapter.isBusy(content)`.
- `src/shell.ts:682` `isClaudeReady` becomes `isAgentReady(content, adapter)`.
- `src/shell.ts:689` `waitForClaude` becomes `waitForAgent(id, timeout, adapter)`
  and gains the startup-dialog dismissal hook.

## Phase 2: codex adapter

Add `CodexAdapter` implementing the mapping table above, plus the two startup
hazards from findings 8 and 9:

- Always emit `-c check_for_update_on_startup=false` on interactive launches.
  If the update menu still appears (older codex, cached notice), `waitForAgent`
  detects `Update available!` plus `2. Skip` and sends `2` before continuing to
  wait for the real ready marker.
- Dismiss the directory-trust dialog from the readiness loop by sending `1`
  ("Yes, continue"). The bypass flag does not suppress it, so this is the only
  way through. The readiness capture window must be wide enough to see the
  question and its options together (they are ~12 lines apart, and the original
  5-line window only showed the options).

### Agent-aware runtime state

`.dispatch-agent` is written into the worktree at launch, containing the
runtime kind. Every later command (`status`, `logs`, `resume`, `list`) reads it
so a running agent keeps its runtime even if `~/.dispatch.yml` changes or the
user omits `--agent` on `dispatch resume`. Falls back to `claude` when absent,
so worktrees created by 0.8.x keep working.

### Corrections found while building

Three things in this spec were wrong and were fixed against the running CLIs:

1. **The model is not orthogonal to the runtime.** `--agent codex` inherited
   Claude's default `opus[1m]`, which codex does not recognize, so it exited at
   startup. Models now live in per-runtime config keys (`model`, `codex_model`),
   and `--model` applies to whichever runtime is selected regardless of flag
   order. An unset codex model omits `-m` entirely so codex uses its own default.
2. **The bypass flag does not skip the trust dialog** (finding 9 above).
3. **`--search` and `-c check_for_update_on_startup` are TUI-only.** `codex exec`
   errors out on both.

A fourth issue was pre-existing rather than introduced: on readiness timeout,
dispatch pasted the prompt anyway. When the CLI has died at startup the pane is
a live shell, so the prompt ran line by line as shell commands. `waitForAgent`
now returns a boolean and the caller refuses to paste, saving the prompt to the
worktree and pointing at the pane instead.

## Phase 3: prod guard (separable)

Permissions are off, so the guard has to come from somewhere other than the
agent's own approval prompt. Two tiers, because neither alone is sufficient.

**Tier 1: git pre-push hook in the worktree.** Runtime-agnostic and the only
mechanism neither CLI can be configured around. `createWorktree` installs
`.git/worktrees/<id>/hooks/pre-push` rejecting any push whose target ref
matches the protected list (`main`, `master`, `prod`, `production`,
`release/*`). Configurable via `protected_refs` in `~/.dispatch.yml`.

**Tier 2: agent-layer rules** for things a pre-push hook cannot see, primarily
`gh pr merge` and prod data mutations.

- Claude: `stripAskRules` (`src/shell.ts:200`) changes from emptying
  `permissions.ask` to replacing it with the prod-guard set, and writes the hard
  blocks into `permissions.deny`. Deny is used for the hard tier because deny
  rules apply regardless of permission mode; whether `ask` rules still fire
  under `--permission-mode dontAsk` is unverified and must be tested before
  relying on it. Rename to `applyProdGuard` since it no longer only strips.
- Codex: write `.codex/rules/dispatch-prod-guard.rules` into the worktree with
  `prefix_rule(pattern=[...], decision="reject")` entries.

**Known limitation, stated plainly:** `--dangerously-bypass-approvals-and-sandbox`
very likely bypasses codex execpolicy evaluation entirely, which would make
Tier 2 inert for codex under the default posture. Verify this before building
Tier 2 for codex. If it is bypassed, the options are (a) accept Tier 1 alone for
codex, or (b) switch the codex default to `-s danger-full-access -a never` plus
execpolicy, which keeps rules live at the cost of a less-tested posture. Tier 1
is unaffected either way, which is why it is the primary mechanism.

Because this phase is independently useful and independently risky, it can ship
after Phase 2 without blocking it.

## Phase 4: surface updates

- `src/config.ts`: add `agent: AgentKind` to `Config` and `DEFAULTS` (default
  `"claude"`), `agent` to `KEY_MAP`, `DISPATCH_AGENT` to the env map. Validate
  the value and fail with a clear message on an unknown runtime. **Done in
  0.9.6**, along with `reasoning_effort`; both are checked in `loadConfig` so a
  bad value cannot reach the point where a worktree and terminal already exist.
  The `claudeTimeout` rename was **not** done: `agent_timeout` is accepted as a
  YAML alias and is what the help advertises, but the field and the
  `DISPATCH_CLAUDE_TIMEOUT` env var keep their original names.
- `src/commands.ts` `cmdRun`: parse `--agent <kind>` and `-A <kind>`. Note the
  existing `default:` arm forwards unknown `--flags` to `extraArgs`, so `--agent`
  must be added explicitly or it silently reaches the CLI.
- `src/cli.ts`: help text for `--agent`, `DISPATCH_AGENT`, and the `agent:`
  config key. Update the header line, which currently says dispatch launches
  Claude Code agents specifically.
- `src/mcp.ts`: add an `agent` property to the `dispatch_run` input schema and
  forward it. Reword the `model` description, which currently hardcodes the
  Claude model list, to note that valid values depend on the selected runtime.
- `src/schedule.ts`: add `agent` to `ScheduleMeta` and `META_FIELDS`.
- `scripts/dispatch-cron-wrapper.sh`: read the `agent` field alongside `MODEL`
  (line 103) and forward `--agent` (line 219). Old schedule files have no
  `agent` field and must keep working.
- `README.md` and the `CLAUDE_MD_SNIPPET` in `src/commands.ts:1737`.
- `.dispatch.example.yml`: document `agent:`.

## Test plan

Existing suites must pass unchanged through Phase 1. New coverage:

`tests/agents.test.ts` (new)
- Claude adapter reproduces today's launch lines byte for byte, interactive and
  headless, with and without resume. This is the regression net for Phase 1.
- Codex interactive line contains `-m`, the bypass flag, and
  `check_for_update_on_startup=false`, and no `--allowedTools`.
- Codex headless line is `codex exec --json …` with the prompt redirected from
  the prompt file.
- Codex resume uses `resume --last` interactively and `exec resume --last`
  headless.
- Every codex launch line carries an explicit sandbox flag (finding 9).
- `--ask` produces `-s workspace-write -a on-request` and no bypass flag.
- Model names with glob metacharacters stay quoted for both runtimes.
- `maxTurns` / `maxBudget` with codex warns and omits the flags.

`tests/agents-parse.test.ts` (new). Fixtures captured from the real probe runs:
- Codex JSONL yields the right turn count, file paths from `file_change`,
  commands from `command_execution`, and `lastText` from the final
  `agent_message`.
- Malformed and partial lines are skipped (the stream is tailed live, so the
  last line is routinely truncated).
- Both adapters return the identical `AgentLogSummary` shape, so `formatStatus`
  is exercised against both.

`tests/commands.test.ts` (extend)
- `--agent codex` parses, `-A codex` parses, unknown runtime errors.
- `--agent` is not leaked into `extraArgs`.

`tests/config.test.ts` (extend)
- `agent:` from file, `DISPATCH_AGENT` from env, CLI override precedence.
- `claude_timeout` alias still populates `agentTimeout`.

Manual verification, since no unit test covers the TUI:
1. `dispatch run "print the current git branch and stop" --agent codex` and
   confirm the prompt lands in the composer and submits.
2. Same on a machine with a pending codex update, confirming finding 8 is handled.
3. `dispatch list` shows running while `◦ Working` is on screen and idle after.
4. `dispatch stop` then `dispatch resume --agent codex` continues the session.
5. `dispatch run … --agent codex --headless`, then `dispatch status` and
   `dispatch logs`.

## Risks

| Risk | Mitigation |
|---|---|
| Codex TUI markup changes between versions and breaks readiness detection | Match on several independent markers, and keep the existing timeout warning path rather than hanging |
| Update prompt variants not covered by the dismissal | Config key suppresses it at the source; dismissal is the fallback |
| Tier 2 prod guard inert under the codex bypass flag | Verify first; Tier 1 (pre-push hook) does not depend on it |
| ~~`parseAgentLog` is exported and may be used externally~~ | **Not kept.** It was removed once `readAgentTrace` replaced it; nothing outside the repo consumed it. |
| Schedules created before 0.9.0 have no `agent` field | Absent field means `claude`, covered by a wrapper test |

## Open questions

1. Do Claude `permissions.ask` rules still fire under `--permission-mode dontAsk`?
   Determines whether Tier 2 uses `ask`, `deny`, or both. **Verify before Phase 3.**
2. Does `--dangerously-bypass-approvals-and-sandbox` skip execpolicy `.rules`
   evaluation? Determines whether the codex Tier 2 guard is viable at all.
3. Where does codex look for project-level `.rules`? User-level is
   `~/.codex/rules/*.rules`; the project-level path is inferred, not confirmed.
4. Should `dispatch status` on an interactive codex agent read the rollout
   JSONL from `~/.codex/sessions` (matched by worktree cwd) to produce real
   status? Interactive Claude has the same gap today, so this is a parity
   improvement for both rather than a codex requirement.

## Build order

1. Phase 1 refactor, existing tests green. No user-visible change.
2. Phase 2 codex adapter plus `tests/agents.test.ts` and the parse fixtures.
3. Phase 4 surface updates (flag, config, MCP, schedule, docs).
4. Manual TUI verification.
5. Phase 3 prod guard, gated on resolving open questions 1 and 2.
