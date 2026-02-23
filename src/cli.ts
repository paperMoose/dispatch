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
} from "./commands.js";

const VERSION = "0.3.0";

function help(): void {
  console.log(`dispatch — Orchestrate Claude Code agents in git worktrees

Usage:
  dispatch run <ticket|prompt> [more...] [options]  Launch agent(s)
  dispatch list                                     Show running agents
  dispatch logs <id>                                Tail agent output
  dispatch stop <id>                                Stop an agent
  dispatch resume <id> [--headless]                 Resume a stopped agent
  dispatch cleanup <id> | --all [--delete-branch]    Remove worktree(s)
  dispatch attach                                   Attach to tmux session

Run Options:
  --headless, -H          Run in background (no interactive tab)
  --model, -m <model>     Claude model (sonnet, opus, etc.)
  --max-turns <n>         Limit agent turns (headless only)
  --max-budget <usd>      Cap spending (headless only)
  --base, -b <branch>     Base branch for worktree (default: dev)
  --prompt-file, -f <file> Load prompt from file
  --name, -n <name>       Override agent name and branch (e.g., HEY-879)
  --no-worktree           Run in current directory (no worktree)

Examples:
  dispatch run HEY-837                      Interactive, from Linear ticket
  dispatch run HEY-837 --headless           Background mode
  dispatch run HEY-837 HEY-838 HEY-839     Batch launch (multiple agents)
  dispatch run "Fix the auth bug"           Free text prompt
  dispatch run HEY-837 -m sonnet            Use Sonnet model
  dispatch run HEY-837 --max-turns 10       Limit to 10 turns

Environment:
  LINEAR_API_KEY          Linear API key for ticket fetching
  DISPATCH_BASE_BRANCH   Default base branch (default: dev)
  DISPATCH_MODEL         Default model
  DISPATCH_CONFIG        Config file path (default: ~/.dispatch.yml)

Config (~/.dispatch.yml):
  base_branch: dev
  model: opus
  max_turns: 20
  claude_timeout: 30
  worktree_dir: .worktrees`);
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
