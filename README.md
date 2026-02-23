# dispatch

CLI tool for orchestrating Claude Code agents in git worktrees. Dispatch work from Linear tickets or free text, run agents in named terminal tabs or headless.

## The Problem

You're running 15 Claude Code sessions and your terminal looks like this:

```
* Unit... | * App... | * Prod... | * DOI... | * Prof... | * Mov... | * Code...
```

Which tab is doing what? No idea.

## The Solution

```bash
dispatch run HEY-837                    # Opens named tab: "HEY-837: eval improvements"
dispatch run HEY-842 --headless         # Runs in background
dispatch list                           # See all agents + status
```

Each agent gets:
- Its own **git worktree** (isolated branch, no conflicts)
- A **named tmux window** that shows as an iTerm2 tab
- **Color-coded tabs** so you can tell them apart at a glance
- Optional **headless mode** for fire-and-forget tasks

## Install

```bash
npm install -g dispatch-agent
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
- iTerm2 (recommended) — for native tab integration via `tmux -CC`

## Usage

### Launch an agent

```bash
# From a Linear ticket (fetches title + description as prompt)
dispatch run HEY-837

# Free text prompt
dispatch run "Fix the auth bug in login.py"

# Headless (background mode)
dispatch run HEY-837 --headless

# With options
dispatch run HEY-837 --model sonnet --max-turns 10 --base main
```

### Monitor agents

```bash
# List all running agents with status
dispatch list

# Tail logs from a headless agent
dispatch logs HEY-837

# Attach to the tmux session (see all tabs)
dispatch attach
```

### Manage agents

```bash
# Stop an agent (keeps worktree)
dispatch stop HEY-837

# Resume a stopped agent
dispatch resume HEY-837

# Clean up worktree + branch
dispatch cleanup HEY-837

# Clean up everything
dispatch cleanup --all
```

## How It Works

```
dispatch run HEY-837
  |
  |-- 1. Fetch ticket from Linear (title + description)
  |-- 2. git worktree add -b hey-837 .worktrees/hey-837 origin/dev
  |-- 3. tmux new-window -n "HEY-837" (becomes iTerm2 tab)
  |-- 4. Set tab color + badge
  |-- 5. Launch Claude Code with ticket as prompt
  |
  v
  Agent works in isolated worktree, commits, pushes
```

### Interactive vs Headless

| | Interactive | Headless |
|---|---|---|
| **Tab** | Named iTerm2 tab you can watch | Detached tmux window |
| **Interaction** | You can type into Claude Code | Fire and forget |
| **Output** | Live in the tab | `dispatch logs <id>` |
| **Safety** | Claude Code permission prompts | `--allowedTools` pre-approved |
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

## iTerm2 Integration

Dispatch uses `tmux -CC` when it detects iTerm2, which maps tmux windows to native iTerm2 tabs. This means:

- Each agent gets a real iTerm2 tab with a clear name
- Tabs are color-coded to tell agents apart
- iTerm2 badges show the ticket ID as an overlay
- Sessions survive terminal crashes (tmux persistence)

### Tab naming

Disable automatic title overrides in your shell:

```bash
# Add to ~/.zshrc
DISABLE_AUTO_TITLE="true"
```

## License

MIT
