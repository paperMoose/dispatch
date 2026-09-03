import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  cmdAccount,
  cmdRun,
  cmdList,
  cmdLogs,
  cmdStop,
  cmdResume,
  cmdCleanup,
  cmdPrune,
  cmdReap,
  cmdDashboard,
  cmdAttach,
  cmdNotifyDone,
  cmdAutoCleanup,
  cmdFind,
  cmdTrackProgress,
  cmdSetup,
  cmdHistory,
  cmdStatus,
  cmdSend,
  cmdSchedule,
  cmdScheduleShouldFire,
  cmdScheduleRecordSuccess,
  cmdScheduledTarget,
  cmdThread,
  cmdDirectory,
  cmdDnd,
  cmdDone,
  cmdGc,
  cmdDoctor,
} from "./commands.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);
const VERSION: string = pkg.version;

function help(): void {
  console.log(`dispatch — Launch coding agents in isolated git worktrees

Each agent gets its own branch and worktree, so it can make changes without
affecting your working tree or other agents. Use interactive mode for a visible
pane, invisible for a real session kept off-screen, or headless for a one-shot run.
Agents run on Claude Code by default, or Codex with --agent codex.

Commands:
  dispatch run <ticket|prompt> [options]   Launch an agent
  dispatch list                            Show all running agents with status
  dispatch status <id>                     Structured summary: turns, files, commits, last actions
  dispatch logs <id>                       Show an agent's output
  dispatch send <id> "<msg>"               Post a message to a running interactive agent
  dispatch done "<what you did>"           Declare yourself finished (agents run this)
  dispatch directory [--json] [--all]      Who is running, what they are on, who can be reached
  dispatch thread new <id> <id> [--topic X] Start a shared buffer two or more agents confer in
  dispatch thread post <tid> --from <id> "<msg>"  Post to a thread; delivers to the other members
  dispatch thread read <tid>               Print the whole conversation
  dispatch thread add <tid> <id>...        Add agents to an existing thread
  dispatch thread list                     Show all threads
  dispatch thread pending                  Groups an agent started, waiting on you
  dispatch thread approve <tid>            Sanction a group; its members then talk freely
  dispatch dnd <id> on|off [--reason X]    Hold thread posts for an agent that must not be interrupted
  dispatch stop <id>                       Stop an agent session
  dispatch resume <id> [--headless]        Restart a stopped agent (keeps context)
  dispatch cleanup <id> [--delete-branch]  Remove worktree (and optionally branch)
  dispatch cleanup --all [--delete-branch] Remove all worktrees
  dispatch gc [--older-than N] [--apply]   Collect worktrees nobody is using. Dry run
                                           unless --apply; rescues uncommitted work to
                                           refs/dispatch-rescue/<id> before removing
  dispatch gc --rescued                    List rescues and how to restore one
  dispatch prune [--delete-branch]         Remove worktrees with no active session.
                                           Skips any with uncommitted changes, so a stale
                                           dirty worktree lives forever; prefer gc
  dispatch reap [--dry-run] [--delete-branch]
                                           Remove worktrees whose cmux tab has been closed
  dispatch doctor                          Check the setup and say what to fix. Non-zero
                                           exit when something is broken
  dispatch account <sub>                   Several Claude logins, so an agent that hits a
                                           usage limit can carry on (list | add | remove)
  dispatch history [N]                     Show past agent runs (default: last 20)
  dispatch find <query>                    Search across all agent terminal content
  dispatch attach <id>                     Open an interactive or invisible session
  dispatch schedule <sub>                  Manage scheduled runs (launchd, macOS only)
  dispatch setup                           Add dispatch docs to ~/.claude/CLAUDE.md

Run Options:
  --headless, -H            Fire-and-forget mode (no interactive terminal)
  --invisible               Native session kept off-screen; attach later (Claude only)
  --agent, -A <runtime>     Agent CLI to drive: claude, codex (default: claude)
  --effort <level>          Codex reasoning: low|medium|high|xhigh|max|ultra
  --model, -m <model>       Model to run. Selects the runtime when the name
                            identifies one: opus/sonnet/haiku pick claude,
                            gpt-*/o* pick codex. --agent overrides.
  --name, -n <name>         Set agent name and branch (default: ticket ID or task-{random})
  --max-turns <n>           Limit agentic turns before stopping (headless only)
  --max-budget <usd>        Cap spending in USD (headless only)
  --base, -b <branch>       Branch to create worktree from (default: dev)
  --prompt-file, -f <file>  Load prompt from a file instead of CLI arg
  --no-worktree             Run in current directory (no isolation)
  --ask                     Re-enable permission prompts (off by default)

Lifecycle:
  1. run    — Creates worktree + branch and starts the requested launch mode
  2. work   — Agent reads codebase, makes changes, commits, pushes, creates PRs
  3. attach — View/interact with the agent (auto-opens terminal tab if no TTY)
  4. stop   — Interrupt the agent (worktree and branch preserved)
  5. resume — Pick up where it left off (claude --continue / codex resume)
  6. cleanup — Remove worktree when done (--delete-branch to also delete the branch)

Finishing:
  An agent runs 'dispatch done "what I did" --handoff "what is left"' when it is
  past its own review. Every dispatched brief ends with that instruction, so it
  does not depend on your CLAUDE.md being current. 'dispatch directory' then
  shows it as done rather than leaving you to guess from a quiet pane — a
  finished agent and one mid-way through a long test run look identical from
  outside. Resuming an agent clears the declaration.

Agent Conversations:
  dispatch directory                    Agents in this repo, plus anyone you share a thread with
  dispatch directory --all              Every live agent on the machine, across every repo
  dispatch thread new a b --topic "the auth refactor"
  dispatch thread post t-4f2a --from a --replay "rg -n newHelper src/session.ts" "..."
  dispatch thread read t-4f2a           The whole conversation, for anyone joining late

  Every post lands in a shared buffer under ~/.dispatch/threads/ and the other
  members pick it up themselves when they next finish a turn, so nothing is
  typed into a working agent and nothing is interrupted. Dispatch wires that up
  at launch; you never run the fetch yourself. @mentions address a subset. An
  agent on do-not-disturb still gets the buffer entry and is handed everything
  it missed when do-not-disturb comes off. A reply chain stops being delivered
  after --max-hops replies (default 12), so two agents cannot keep each other
  awake forever.

  Forming a group needs your say-so; talking inside one does not. A thread you
  create is sanctioned because you created it. One an agent creates waits until
  'dispatch thread approve' — then its members coordinate freely, which is what
  makes this usable for a swarm. Your own posts always go straight through.
  Setting thread_delivery to auto lets agents form their own groups unsupervised.

  Threads are for being stuck, not for being polite. An agent should post when
  it has hit a blank or has been wrong about the same thing twice — not to give
  status, and never to acknowledge. A post should carry the experiment that
  settles it: --replay takes a command the reader can run to see what the sender
  saw, shown to them and stored in the thread, never run by dispatch. Without
  one, a claim has to be taken on trust. Delivery says all of this out loud on
  every message, so an agent does not have to have read this.

Input Types:
  Linear ticket    dispatch run HEY-837              Fetches title + description from Linear
  Free text        dispatch run "Fix the auth bug"   Uses your prompt directly
  Prompt file      dispatch run X -f prompt.txt      Loads prompt from file (good for long prompts)

Examples:
  dispatch run HEY-837                                  # Interactive, from Linear ticket
  dispatch run HEY-837 --headless                       # Background — check with: dispatch logs HEY-837
  dispatch run HEY-837 --invisible                      # Real off-screen Claude session; attach later
  dispatch run HEY-837 HEY-838 HEY-839                 # Batch launch 3 agents in parallel
  dispatch run "Fix the auth bug" --name HEY-879        # Free text with custom branch name
  dispatch run HEY-837 -m sonnet --max-turns 20         # Sonnet model, 20 turn limit
  dispatch run HEY-837 --agent codex                    # Run on Codex instead of Claude
  dispatch run HEY-837 -A codex -m gpt-5.6-sol          # Codex with a specific model
  dispatch run HEY-837 --ask                            # Keep permission prompts on for this agent
  dispatch attach HEY-837                               # Jump to agent's terminal
  dispatch list                                         # See what's running
  dispatch cleanup --all --delete-branch                # Clean everything up

Tips:
  - Each agent works on its own branch — avoid dispatching two agents to the same files
  - Use --name to get meaningful branch names (e.g., --name HEY-879 creates branch hey-879)
  - Invisible mode avoids tab clutter but remains attachable; headless exits after one run
  - Works from inside Claude Code sessions (agents launch in separate terminals)
  - Use dispatch list to check status: green = running, yellow = idle, red = exited

Environment:
  LINEAR_API_KEY         Linear API key for auto-fetching ticket details
  DISPATCH_BASE_BRANCH   Default base branch (default: dev)
  DISPATCH_AGENT         Default agent runtime: claude or codex (default: claude)
  DISPATCH_MODEL         Default model (default: opus[1m])
  DISPATCH_CODEX_MODEL   Default model when --agent codex (default: codex's own)
  DISPATCH_REASONING_EFFORT  Codex reasoning effort (default: codex's own)
  DISPATCH_PERMISSION_MODE  Permission mode for agents (default: dontAsk; "" for prompts)
  DISPATCH_THREAD_DELIVERY  ask (default) or auto — whether an agent may form
                            a group chat without you approving it
  DISPATCH_CONFIG        Config file path (default: ~/.dispatch.yml)

Config (~/.dispatch.yml):
  base_branch: dev        # Branch to create worktrees from
  agent: claude           # Agent runtime: claude or codex
  model: opus[1m]         # Model when agent is claude
  codex_model: gpt-5.6-sol  # Model when agent is codex
  reasoning_effort: xhigh   # Codex reasoning depth
  permission_mode: dontAsk  # Agents don't stop for permission prompts
  thread_delivery: ask    # Agent-created group chats wait for your approval
  max_turns: 20           # Default max turns for headless
  agent_timeout: 30       # Seconds to wait for the agent TUI to start
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
      cmdList(config, rest.includes("--brief"));
      break;
    case "logs":
      cmdLogs(rest, config);
      break;
    case "stop":
      cmdStop(rest, config);
      break;
    case "resume":
      cmdResume(rest, config);
      break;
    case "cleanup":
      cmdCleanup(rest, config);
      break;
    case "prune":
      cmdPrune(rest, config);
      break;
    case "reap":
      cmdReap(rest, config);
      break;
    case "gc":
      cmdGc(rest, config);
      break;
    case "doctor":
      process.exitCode = cmdDoctor(config);
      break;
    case "dashboard":
      cmdDashboard(config);
      break;
    case "attach":
      cmdAttach(rest, config);
      break;
    case "setup":
      cmdSetup();
      break;
    case "schedule":
      cmdSchedule(rest);
      break;
    case "_schedule-should-fire":
      cmdScheduleShouldFire(rest);
      break;
    case "_schedule-record-success":
      cmdScheduleRecordSuccess(rest);
      break;
    case "_scheduled-target":
      cmdScheduledTarget(rest);
      break;
    case "status":
      cmdStatus(rest, config);
      break;
    case "send":
      cmdSend(rest, config);
      break;
    case "account":
    case "accounts":
      cmdAccount(args.slice(1), config);
      break;

    case "thread":
    case "threads":
      cmdThread(rest, config);
      break;
    case "directory":
    case "dir":
      cmdDirectory(rest, config);
      break;
    case "dnd":
      cmdDnd(rest, config);
      break;
    case "done":
      cmdDone(rest, config);
      break;
    case "history":
      cmdHistory(rest);
      break;
    case "find":
    case "search":
      cmdFind(rest);
      break;
    case "_notify-done":
      cmdNotifyDone(rest, config);
      break;
    case "_auto-cleanup":
      cmdAutoCleanup(rest, config);
      break;
    case "_track-progress":
      cmdTrackProgress(rest);
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
