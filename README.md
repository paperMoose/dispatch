# dispatch

Multiplex Claude Code agents from a single conversation. Fan out work across tickets, each agent opens in its own terminal tab on its own branch, then fold results back in when they're done.

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
- `claude` — [Claude Code CLI](https://code.claude.com)
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
```

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
5. Runs `dispatch run --headless --no-attach --prompt-file <path> --name <branch-prefix>-YYYYMMDD-HHMM` (plus `--model` / `--max-turns` if set), or `--command "<shell>"` for raw commands.
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

### Notifications

`--notify slack` currently writes a marker line to the per-fire log. There is no clean send-only Slack helper in this repo yet — the prompt itself is responsible for posting to Slack via the agent's own tool use. This is a v1 limitation; a real `--notify slack` wired to a CLI helper will land in a follow-up.

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
export DISPATCH_MODEL="opus"             # Default model
```

### Config file (`~/.dispatch.yml`)

```yaml
base_branch: dev
model: opus
max_turns: 20
worktree_dir: .worktrees
```

## License

MIT
