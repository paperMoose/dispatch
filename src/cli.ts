import { loadConfig } from "./config.js";
import {
  cmdRun,
  cmdList,
  cmdLogs,
  cmdStop,
  cmdResume,
  cmdCleanup,
  cmdAttach,
  cmdNotifyDone,
  cmdSetup,
} from "./commands.js";

const VERSION = "0.4.1";

function help(): void {
  console.log(`dispatch — Launch Claude Code agents in isolated git worktrees

Each agent gets its own branch and worktree, so it can make changes without
affecting your working tree or other agents. Agents run inside tmux — use
interactive mode to watch and guide them, or headless for fire-and-forget.

Commands:
  dispatch run <ticket|prompt> [options]   Launch an agent
  dispatch list                            Show all running agents with status
  dispatch logs <id>                       Tail a headless agent's output
  dispatch stop <id>                       Send Ctrl-C and kill the tmux window
  dispatch resume <id> [--headless]        Restart a stopped agent (keeps context)
  dispatch cleanup <id> [--delete-branch]  Remove worktree (and optionally branch)
  dispatch cleanup --all [--delete-branch] Remove all worktrees
  dispatch attach [id]                     Open tmux session (or jump to specific agent)
  dispatch setup                           Add dispatch docs to ~/.claude/CLAUDE.md

Run Options:
  --headless, -H            Fire-and-forget mode (no interactive terminal)
  --model, -m <model>       Claude model: sonnet, opus, haiku (default: from config)
  --name, -n <name>         Set agent name and branch (default: ticket ID or task-{random})
  --max-turns <n>           Limit agentic turns before stopping (headless only)
  --max-budget <usd>        Cap spending in USD (headless only)
  --base, -b <branch>       Branch to create worktree from (default: dev)
  --prompt-file, -f <file>  Load prompt from a file instead of CLI arg
  --no-worktree             Run in current directory (no isolation)

Lifecycle:
  1. run    — Creates worktree + branch, opens tmux window, starts Claude Code
  2. work   — Agent reads codebase, makes changes, commits, pushes, creates PRs
  3. attach — View/interact with the agent (auto-opens terminal tab if no TTY)
  4. stop   — Interrupt the agent (worktree and branch preserved)
  5. resume — Pick up where it left off (Claude --continue)
  6. cleanup — Remove worktree when done (--delete-branch to also delete the branch)

Input Types:
  Linear ticket    dispatch run HEY-837              Fetches title + description from Linear
  Free text        dispatch run "Fix the auth bug"   Uses your prompt directly
  Prompt file      dispatch run X -f prompt.txt      Loads prompt from file (good for long prompts)

Examples:
  dispatch run HEY-837                                  # Interactive, from Linear ticket
  dispatch run HEY-837 --headless                       # Background — check with: dispatch logs HEY-837
  dispatch run HEY-837 HEY-838 HEY-839                 # Batch launch 3 agents in parallel
  dispatch run "Fix the auth bug" --name HEY-879        # Free text with custom branch name
  dispatch run HEY-837 -m sonnet --max-turns 20         # Sonnet model, 20 turn limit
  dispatch attach HEY-837                               # Jump to agent's terminal
  dispatch list                                         # See what's running
  dispatch cleanup --all --delete-branch                # Clean everything up

Tips:
  - Each agent works on its own branch — avoid dispatching two agents to the same files
  - Use --name to get meaningful branch names (e.g., --name HEY-879 creates branch hey-879)
  - Interactive mode lets you guide the agent; headless is for well-defined tasks
  - Works from inside Claude Code sessions (agents launch in separate terminals)
  - Use dispatch list to check status: green = running, yellow = idle, red = exited

Environment:
  LINEAR_API_KEY         Linear API key for auto-fetching ticket details
  DISPATCH_BASE_BRANCH   Default base branch (default: dev)
  DISPATCH_MODEL         Default model
  DISPATCH_CONFIG        Config file path (default: ~/.dispatch.yml)

Config (~/.dispatch.yml):
  base_branch: dev        # Branch to create worktrees from
  model: opus             # Default Claude model
  max_turns: 20           # Default max turns for headless
  claude_timeout: 30      # Seconds to wait for Claude to start
  worktree_dir: .worktrees  # Where worktrees are created`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const rest = args.slice(1);

  const config = loadConfig();

  switch (cmd) {
    case "run":
      await cmdRun(rest, config);
      break;
    case "list":
    case "ls":
      cmdList(config);
      break;
    case "logs":
      cmdLogs(rest, config);
      break;
    case "stop":
      cmdStop(rest);
      break;
    case "resume":
      cmdResume(rest, config);
      break;
    case "cleanup":
      cmdCleanup(rest, config);
      break;
    case "attach":
      cmdAttach(rest);
      break;
    case "setup":
      cmdSetup();
      break;
    case "_notify-done":
      cmdNotifyDone(rest);
      break;
    case "version":
    case "-v":
    case "--version":
      console.log(`dispatch v${VERSION}`);
      break;
    case "help":
    case "-h":
    case "--help":
      help();
      break;
    default:
      console.error(`\x1b[0;31m✗\x1b[0m Unknown command: ${cmd}`);
      console.log();
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\x1b[0;31m✗\x1b[0m ${err.message}`);
  process.exit(1);
});
