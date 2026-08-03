# dispatch

Multiplex coding agents from a single conversation. Fan out work across tickets, each agent opens in its own terminal tab on its own branch, then fold results back in when they're done.

Agents run on **Claude Code** by default, or **Codex** with `--agent codex`. Every other command works the same either way.

```
You: "Work on HEY-837, HEY-842, and HEY-845"

Claude (main session)
  ├── dispatch_run HEY-837  →  [Tab: HEY-837] agent working on eval improvements
  ├── dispatch_run HEY-842  →  [Tab: HEY-842] agent fixing auth bug
  └── dispatch_run HEY-845  →  [Tab: HEY-845] agent adding retry logic

You: "How's HEY-837 doing?"

Claude: *calls dispatch_logs* → "It's done, pushed to branch hey-837. Want me to open a PR?"
```

No tab switching. No copy-pasting prompts. No manually creating branches. Your main Claude session orchestrates everything — spinning up agents, checking progress, and pulling results back in.

## Install

```bash
npm install -g dispatch-agents
```

Or from source:

```bash
git clone https://github.com/paperMoose/dispatch.git
cd dispatch
npm install && npm run build
npm link
```

### Requirements

- Node.js 20+
- `tmux` — `brew install tmux`
- An agent CLI — [`claude`](https://code.claude.com) and/or [`codex`](https://developers.openai.com/codex/cli). You only need the one you dispatch to.
- `git` — for worktree management

### Supported terminals

Dispatch auto-detects your terminal and opens native tabs:

- **cmux** — built for AI coding agents, first-class support
- **iTerm2** — native tab integration
- **Warp** — tab support via keystroke automation
- **Terminal.app** — fallback

## MCP Server (recommended)

The MCP server lets Claude Code spin up agents directly — this is the primary way to use dispatch.

### Setup

```bash
claude mcp add --scope user dispatch node $(which dispatch-mcp)
```

This exposes 6 tools to Claude Code:

| Tool | Description |
|------|-------------|
| `dispatch_run` | Launch an agent with a prompt |
| `dispatch_list` | List all running agents with status |
| `dispatch_stop` | Stop a running agent |
| `dispatch_resume` | Resume a stopped agent |
| `dispatch_cleanup` | Remove worktrees and optionally branches |
| `dispatch_logs` | Get recent output from an agent |

### How it works

Add dispatch instructions to your `CLAUDE.md` and Claude will use the MCP tools to fan out work. Example interaction:

```
You:    "Work on HEY-837, HEY-842, and HEY-845"
Claude: *calls dispatch_run for each ticket*
        *three terminal tabs open, each with an agent working on its own branch*
Claude: "I've launched 3 agents. HEY-837 is working on eval improvements,
         HEY-842 is fixing the auth bug, HEY-845 is adding retry logic."
```

Each agent gets its own git worktree so there are no merge conflicts between parallel agents.

### Working directory

By default the MCP server uses the directory Claude Code is running in. To override:

```bash
claude mcp add --scope user dispatch -e DISPATCH_CWD=/path/to/repo node $(which dispatch-mcp)
```

## CLI Usage

You can also use dispatch directly from the command line.

### Launch agents

```bash
# From a Linear ticket (fetches title + description as prompt)
dispatch run HEY-837

# Free text prompt
dispatch run "Fix the auth bug in login.py"

# Batch launch
dispatch run HEY-837 HEY-842 HEY-845

# Headless (background, no tab)
dispatch run HEY-837 --headless

# With options
dispatch run HEY-837 --model sonnet --max-turns 10 --base main

# Run on Codex instead of Claude Code
dispatch run HEY-837 --agent codex
dispatch run HEY-837 -A codex -m gpt-5.6-sol --effort xhigh

# Steer a running interactive agent without restarting it
dispatch send HEY-837 "Use the existing helper rather than writing a new one"

# Keep permission prompts on for this agent (they're off by default)
dispatch run HEY-837 --ask
```

**Permissions are off by default.** Every agent launches with `--permission-mode dontAsk`, and
`permissions.ask` is emptied in the agent's worktree copy of `.claude/settings.json` (marked
skip-worktree, so the agent can't commit that change — the team file and your other checkouts are
untouched). Dispatched agents work unattended, and a permission prompt in a background pane stalls
the run until someone notices it.

On Codex the same posture is `--dangerously-bypass-approvals-and-sandbox`; `--ask` swaps it for
`-s workspace-write -a on-request`. Codex always launches with an explicit sandbox flag, since it
otherwise stops to ask whether it trusts the (brand new) worktree directory before running anything.

### Runtime differences

| | `--agent claude` (default) | `--agent codex` |
|---|---|---|
| Model flag | `--model opus[1m]` | `-m gpt-5.6-sol` |
| Resume | `claude --continue` | `codex resume --last` |
| Headless | `claude -p --output-format stream-json` | `codex exec --json` |
| `--max-turns` / `--max-budget` | supported | no equivalent, warns and ignores |
| Instructions file | `CLAUDE.md` | `AGENTS.md` |

The runtime is recorded in the worktree at launch, so `status`, `logs`, and `resume` keep driving
the CLI the agent actually started with even if you change your config afterwards.

### Seeing what an agent is doing

`dispatch status` returns a structured trace — turns, files changed, commits, recent actions, last
output — for **both** modes. Headless agents tee a `.dispatch.log`; interactive agents write no log,
so dispatch falls back to the agent CLI's own session transcript (`~/.claude/projects/...` or
`~/.codex/sessions/...`), matched to the worktree. Same output shape either way, so an orchestrator
does not need to know which harness an agent runs on.

Codex routes shell work through a code-mode tool, so its traces show a coarser `Ran exec` where
Claude resolves the actual command. Turns, files, commits and last message are reliable on both.

The tradeoff: inside its worktree, an agent can push, merge PRs, run migrations, and hit cloud CLIs
without asking. Use `--ask` when you'd rather approve those, or set `permission_mode: ""` in
`~/.dispatch.yml` to make prompts the default again.

### Monitor

```bash
dispatch list                  # All agents + status
dispatch logs HEY-837          # Tail headless agent output
dispatch attach HEY-837        # Jump to agent's terminal
```

### Manage

```bash
dispatch stop HEY-837          # Stop agent (keeps worktree)
dispatch resume HEY-837        # Pick up where it left off
dispatch cleanup HEY-837       # Remove worktree + branch
dispatch cleanup --all          # Clean up everything
```

## How It Works

```
dispatch run HEY-837
  │
  ├── 1. Fetch ticket from Linear (title + description)
  ├── 2. git worktree add -b hey-837 .worktrees/hey-837 origin/dev
  ├── 3. Create tmux session → opens as terminal tab
  ├── 4. Launch Claude Code with ticket as prompt
  │
  └── Agent works in isolated worktree, commits, pushes
```

### Interactive vs Headless

| | Interactive | Headless |
|---|---|---|
| **Terminal** | Named tab you can watch | Detached tmux session |
| **Interaction** | You can type into Claude Code | Fire and forget |
| **Output** | Live in the tab | `dispatch logs <id>` |
| **Use case** | Complex tasks, review as you go | Simple/well-defined tasks |

## Scheduled runs (macOS)

`dispatch schedule` registers a recurring or one-off `dispatch run` invocation as a launchd agent. This is for jobs that need full local auth (gcloud, secret-agent, env files, working keychains) — things a remote agent platform can't reach.

It writes a plist to `~/Library/LaunchAgents/com.dispatch.<name>.plist`, stores schedule metadata in `~/.dispatch/schedules/<name>.yml`, and pipes each fire's output to a timestamped log under `~/.dispatch/scheduled-logs/`.

```bash
# Register a recurring schedule
dispatch schedule add voice-reliability-check \
    --cron "0 16 * * 5" \
    --prompt-file ~/git/dispatch/prompts/voice-reliability-check.md \
    --branch-prefix reliability \
    --model opus \
    --repo ~/git/vunda-customers/noah/repos/noah-server \
    --max-turns 30 \
    --notify slack

# One-off run at a specific moment
dispatch schedule add release-cut \
    --at "2026-05-08T09:00:00" \
    --prompt-file ~/prompts/release-cut.md

# Inspect / manage
dispatch schedule list
dispatch schedule show voice-reliability-check
dispatch schedule run voice-reliability-check     # fire immediately, bypass cron
dispatch schedule disable voice-reliability-check # launchctl unload, keep plist
dispatch schedule enable voice-reliability-check
dispatch schedule remove voice-reliability-check  # unload + delete plist + metadata
```

### Cron subset

Standard 5-field cron: `minute hour day-of-month month day-of-week`. Supported syntax:

- `*` (any), `N` (specific value), `M-N` (range), `M,N` (list), `*/N` or `M-N/S` (step).
- Sunday accepts both `0` and `7` (normalized to launchd's `0`).

Not supported: `L` (last), `W` (nearest weekday), `#` (nth weekday), `?` (no-specific). The CLI errors out if you use them.

### How fires work

When the schedule fires, launchd invokes `scripts/dispatch-cron-wrapper.sh`. The wrapper:

1. Picks up your interactive shell's `PATH` (so `gcloud`, `secret-agent`, `uv`, `claude`, `dispatch` are reachable).
2. Loads metadata from `~/.dispatch/schedules/<name>.yml`.
3. Runs the **idempotency gate**: `dispatch _schedule-should-fire <name>` checks whether the current cron slot has already been served (via `~/.dispatch/schedules/<name>.last_success`). If yes, the wrapper exits without doing work. This is what keeps `RunAtLoad` from re-firing the schedule on every routine login (see "Catch-up" below).
4. `cd`s into `--repo` if set.
5. Runs `dispatch run --headless --no-attach --prompt-file <path> --name <branch-prefix>-YYYYMMDD-HHMM` (plus `--agent` / `--model` / `--max-turns` if set), or `--command "<shell>"` for raw commands.
6. Tees stdout/stderr to `~/.dispatch/scheduled-logs/<name>-<timestamp>.log`.
7. On `rc=0`, writes the current timestamp to `~/.dispatch/schedules/<name>.last_success`.
8. Self-removes the plist + metadata if the schedule was a `--at` one-off (the plist is removed *before* the work, so a crashed wrapper can't strand it).

### Catch-up after sleep / shutdown

Each plist sets `RunAtLoad: true` and the wrapper guards against double-firing via the `last_success` state file. The combined effect:

- **Mac asleep across the cron slot**: launchd's native coalescing fires the missed event on wake. Gate sees stale `last_success`, fires.
- **Mac fully off across the cron slot** (user-level LaunchAgents don't run while logged out): on next login, `RunAtLoad` triggers the wrapper. Gate sees stale `last_success`, fires.
- **Routine login during the same cron slot it just ran in**: gate sees fresh `last_success` covering the prev fire slot, exits cleanly. No double-fire.
- **First-ever fire after `dispatch schedule add`**: no `last_success` on disk, gate fires.
- **One-off (`--at`)**: gate compares `now` to `run_at`; skips if too early, fires once otherwise. The plist self-removes after the first successful fire (and pre-emptively before invoking work, so a crashed wrapper can't leave an annual-fire orphan).

To force a manual fire that bypasses the gate:

```bash
dispatch schedule run <name>           # bypasses gate; preferred
DISPATCH_SCHEDULE_FORCE=1 ./scripts/dispatch-cron-wrapper.sh <name>   # raw equivalent
```

### Wake / boot settle delay

When the wrapper fires within a short window of a system wake (or fresh boot — `kern.waketime` covers both), it sleeps **5 minutes** before invoking work. This gives the network, VPN, gcloud auth refresh, secret-agent unlock, and so on time to finish reconnecting before the agent tries to use them.

Tunables (env vars set on the wrapper, or via `launchctl setenv` for the user session):

| Env var | Default | Meaning |
|---|---|---|
| `DISPATCH_SCHEDULE_WAKE_WINDOW` | `60` | Seconds since wake/boot that count as "wake-triggered". |
| `DISPATCH_SCHEDULE_WAKE_DELAY` | `300` | Seconds to sleep when wake-triggered. |
| `DISPATCH_SCHEDULE_NO_DELAY=1` | unset | Skip the delay even if wake-triggered. |

`dispatch schedule run <name>` (manual) and `DISPATCH_SCHEDULE_FORCE=1` also skip the delay — when you fire on purpose, you don't want to wait.

### Live wake-test

`scripts/test-wake.sh` is a two-phase integration test that proves the wake/sleep + idempotency path on a real Mac. Putting the Mac to sleep terminates the test shell, so it splits into setup and verify:

```bash
# 1. Register a 1-min probe schedule + capture 90s baseline
./scripts/test-wake.sh setup

# 2. Sleep the Mac
pmset sleepnow      # or close the lid

# 3. Wait at least 3 minutes, then wake / open the lid

# 4. Verify
./scripts/test-wake.sh verify
```

Verify reads `kern.waketime`, parses the probe log, and asserts:
- `≥1` fire happened pre-sleep (baseline)
- `0` fires happened during sleep
- `≥1` fire happened post-wake
- The first post-wake fire respected the configured `WAKE_DELAY` (within `[delay − 10s, delay + 90s]` to allow for cron-slot alignment slack)

The script uses `WAKE_WINDOW=300s` and `WAKE_DELAY=15s` (set via `launchctl setenv`) so a single test cycle takes ~4 minutes instead of 5+. State + env are torn down at the end of `verify`. Override the baseline length with `TEST_WAKE_BASELINE_SECS=N`.

### Notifications

`--notify` controls how a fire surfaces. A scheduled job runs where you can't see it, so a silent failure is invisible until you go digging — `--notify` fixes that:

- `none` (default): no banner. Fully silent. Logs are still written.
- `notification`: a macOS banner on **every** fire, success or failure (`dispatch ✓ <name>` / `dispatch ✗ <name> failed (rc=N)`). Use this for any job whose outcome you'd want to know about.
- `slack`: same macOS banner, plus a marker line in the per-fire log. There is no clean send-only Slack helper in this repo yet, so the prompt itself is responsible for posting to Slack via the agent's own tool use. A real `--notify slack` wired to a CLI helper will land in a follow-up.

The banner is fired by the wrapper via `osascript display notification`; launchd LaunchAgents run in the user's GUI session, so it reaches Notification Center.

### Worked example: voice-reliability-check

`prompts/voice-reliability-check.md` is included as the first real schedule. Register it with:

```bash
dispatch schedule add voice-reliability-check \
    --cron "0 16 * * 5" \
    --prompt-file ~/git/dispatch/prompts/voice-reliability-check.md \
    --branch-prefix reliability \
    --model opus \
    --repo ~/git/vunda-customers/noah/repos/noah-server \
    --max-turns 30 \
    --notify slack
```

That fires every Friday at 4pm local: it queries the dev DB for `CallRun` outcomes over the past week, computes IVR/SMS/pre-dial reliability metrics, compares against the Apr 28 baseline, and DMs Ryan a summary.

## Configuration

### Environment variables

```bash
export LINEAR_API_KEY="lin_api_..."      # For ticket fetching
export DISPATCH_BASE_BRANCH="dev"        # Default base branch
export DISPATCH_MODEL="opus[1m]"         # Default model (Opus 5, 1M context)
export DISPATCH_PERMISSION_MODE=""       # "" restores permission prompts (default: dontAsk)
```

### Config file (`~/.dispatch.yml`)

```yaml
base_branch: dev
model: opus[1m]
permission_mode: dontAsk
max_turns: 20
worktree_dir: .worktrees
```

## License

MIT
