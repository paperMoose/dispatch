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
