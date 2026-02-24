import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "fs";
import { join, basename, resolve } from "path";
import { homedir } from "os";
import { execSync, spawnSync } from "child_process";
import type { Config } from "./config.js";
import {
  log,
  fmt,
  exec,
  execQuiet,
  gitRoot,
  worktreePath,
  createWorktree,
  removeWorktree,
  ensureTmux,
  windowExists,
  createWindow,
  tmuxTarget,
  tmuxSendKeys,
  tmuxCapture,
  tmuxKillWindow,
  tmuxListWindows,
  tmuxHasSession,
  tmuxAttach,
  fetchLinearTicket,
  notify,
  waitForClaude,
  tailFile,
} from "./shell.js";

export const TICKET_RE = /^[A-Z]+-[0-9]+$/;

/** Turn any string into a short, kebab-case slug suitable for branch/window names. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")  // non-alphanumeric → dash
    .replace(/^-+|-+$/g, "")      // trim leading/trailing dashes
    .slice(0, 40)                  // keep it short
    .replace(/-+$/, "");           // trim trailing dash from truncation
}

// ---------------------------------------------------------------------------
// Build Claude command
// ---------------------------------------------------------------------------
export function buildClaudeCmd(
  prompt: string,
  mode: "interactive" | "headless",
  wtPath: string,
  config: Config,
  extraArgs: string,
): string {
  let cmd = "claude";

  if (mode === "headless") cmd += " -p";

  if (config.model) cmd += ` --model ${config.model}`;

  if (mode === "headless") {
    cmd += ` --allowedTools "${config.allowedTools}"`;
    if (config.maxTurns) cmd += ` --max-turns ${config.maxTurns}`;
    if (config.maxBudget) cmd += ` --max-budget-usd ${config.maxBudget}`;
    cmd += " --output-format json";
  }

  if (extraArgs) cmd += ` ${extraArgs}`;

  if (mode === "headless") {
    const promptFile = join(wtPath, ".dispatch-prompt.txt");
    writeFileSync(promptFile, prompt);
    // Use stdin redirection — command substitution gets mangled by tmux send-keys
    cmd += ` < '${promptFile}'`;
  }

  return cmd;
}

// ---------------------------------------------------------------------------
// Launch agent (core logic)
// ---------------------------------------------------------------------------
async function launchAgent(
  input: string,
  headless: boolean,
  extraArgs: string,
  skipWorktree: boolean,
  promptFileArg: string,
  nameOverride: string,
  config: Config,
): Promise<void> {
  let id: string;
  let prompt: string;
  let branch: string;

  if (TICKET_RE.test(input)) {
    const ticket = await fetchLinearTicket(input);
    id = `${input.toLowerCase()}-${slugify(ticket.title)}`;
    branch = id;

    if (ticket.description) {
      prompt = `Linear ticket ${input}: ${ticket.title}\n\n${ticket.description}\n\nWork on this ticket. Create commits as you go. When done, push the branch.`;
    } else {
      prompt = `Work on ticket ${input}: ${ticket.title}. Create commits as you go. When done, push the branch.`;
    }
  } else {
    id = slugify(input) || `task-${String(Date.now()).slice(-6)}`;
    branch = id;
    prompt = input;
  }

  // Override id and branch if --name was provided
  if (nameOverride) {
    id = slugify(nameOverride) || nameOverride;
    branch = id;
  }

  // Load prompt from file if specified
  if (promptFileArg) {
    if (!existsSync(promptFileArg)) {
      log.error(`Prompt file not found: ${promptFileArg}`);
      return;
    }
    if (TICKET_RE.test(input)) {
      log.warn(`Ticket prompt for ${input} overridden by --prompt-file`);
    }
    const { readFileSync } = await import("fs");
    prompt = readFileSync(promptFileArg, "utf-8");

    // Derive name from prompt content if we only have a placeholder
    if (!nameOverride && !TICKET_RE.test(input)) {
      // Use first heading or first non-empty line
      const firstLine = prompt.split("\n").find((l) => l.trim().length > 0) || "";
      const clean = firstLine.replace(/^#+\s*/, "");  // strip markdown heading
      const derived = slugify(clean);
      if (derived) {
        id = derived;
        branch = id;
      }
    }
  }

  // Check if already running
  if (windowExists(id)) {
    log.error(`Agent '${id}' is already running. Use 'dispatch stop ${id}' first.`);
    return;
  }

  // Create worktree
  let wtPath: string;
  if (skipWorktree) {
    wtPath = gitRoot();
  } else {
    createWorktree(id, branch, config);
    wtPath = worktreePath(id, config);
  }

  // Create tmux window
  createWindow(id, wtPath);

  const mode = headless ? "headless" : "interactive";
  const claudeCmd = buildClaudeCmd(prompt, mode, wtPath, config, extraArgs);

  if (mode === "interactive") {
    // Launch claude, wait for it to be ready, then send prompt via paste-buffer
    const modelFlag = config.model ? `--model ${config.model}` : "";
    execSync(
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && claude ${modelFlag}" Enter`,
    );
    waitForClaude(id, config.claudeTimeout);

    // Write prompt to file and paste via tmux buffer
    const pf = join(wtPath, ".dispatch-prompt.txt");
    writeFileSync(pf, prompt);
    const bufName = `dispatch-${id.replace(/[^a-zA-Z0-9]/g, "-")}`;
    execSync(`tmux load-buffer -b "${bufName}" "${pf}"`);
    execSync(
      `tmux paste-buffer -b "${bufName}" -t "${tmuxTarget(id)}"`,
    );
    execQuiet(`tmux delete-buffer -b "${bufName}"`);
    execSync(`tmux send-keys -t "${tmuxTarget(id)}" Enter`);
  } else {
    // Headless: run with -p, tee to log, notify on completion
    const logFile = join(wtPath, ".dispatch.log");
    execSync(
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && ${claudeCmd} 2>&1 | tee -a ${logFile}; dispatch _notify-done ${id}" Enter`,
    );
  }

  console.log();
  log.ok(`Agent ${fmt.BOLD}${id}${fmt.NC} launched (${mode})`);
  log.dim(`  Worktree: ${wtPath}`);
  log.dim(`  Branch:   ${branch}`);
  if (headless) {
    log.dim(`  Logs:     dispatch logs ${id}`);
    log.dim(`  Stop:     dispatch stop ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
export async function cmdRun(
  args: string[],
  config: Config,
): Promise<void> {
  const inputs: string[] = [];
  let headless = false;
  let promptFile = "";
  let extraArgs = "";
  let skipWorktree = false;
  let nameOverride = "";
  let noAttach = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--headless":
      case "-H":
        headless = true;
        i++;
        break;
      case "--model":
      case "-m":
        config.model = args[++i];
        i++;
        break;
      case "--max-turns":
        config.maxTurns = args[++i];
        i++;
        break;
      case "--max-budget":
        config.maxBudget = args[++i];
        i++;
        break;
      case "--base":
      case "-b":
        config.baseBranch = args[++i];
        i++;
        break;
      case "--prompt-file":
      case "-f":
        promptFile = args[++i];
        i++;
        break;
      case "--no-worktree":
        skipWorktree = true;
        i++;
        break;
      case "--no-attach":
        noAttach = true;
        i++;
        break;
      case "--name":
      case "-n":
        nameOverride = args[++i];
        i++;
        break;
      default:
        if (arg.startsWith("--")) {
          extraArgs += ` ${arg}`;
        } else {
          inputs.push(arg);
        }
        i++;
        break;
    }
  }

  if (inputs.length === 0 && !promptFile) {
    log.error("Usage: dispatch run <ticket|prompt> [ticket2 ...] [options]");
    console.log();
    console.log('  dispatch run HEY-837                         # from Linear ticket');
    console.log('  dispatch run HEY-837 HEY-838 HEY-839        # batch launch');
    console.log('  dispatch run HEY-837 --headless              # run in background');
    console.log('  dispatch run "Fix the auth bug"               # free text prompt');
    console.log("  dispatch run HEY-837 --model sonnet          # specific model");
    console.log("  dispatch run HEY-837 --max-turns 10          # limit turns");
    console.log("  dispatch run HEY-837 --base main             # branch off main");
    process.exit(1);
  }

  // When --prompt-file is used without a positional arg, generate a placeholder input
  if (inputs.length === 0 && promptFile) {
    inputs.push("prompt-file");
  }

  ensureTmux();

  if (inputs.length > 1) {
    log.info(`Batch launching ${inputs.length} agents...`);
    console.log();
  }

  for (const input of inputs) {
    await launchAgent(input, headless, extraArgs, skipWorktree, promptFile, nameOverride, config);
  }

  console.log();

  // For single interactive agent, attach to session
  if (!headless && inputs.length === 1 && !noAttach) {
    log.info("Attaching to tmux session...");
    log.dim("  Detach with: Ctrl-B then D");
    console.log();
    tmuxAttach();
  } else if (inputs.length > 1) {
    log.ok(`All agents launched. Use ${fmt.BOLD}dispatch attach${fmt.NC} to view tabs.`);
  }
}

export function cmdList(config: Config): void {
  ensureTmux();

  if (!tmuxHasSession()) {
    log.info("No dispatch session running");
    return;
  }

  console.log();
  console.log(`${fmt.BOLD}Running Agents${fmt.NC}`);
  console.log(
    `${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`,
  );

  const root = execQuiet("git rev-parse --show-toplevel") || "";
  const lines = tmuxListWindows();

  for (const line of lines.split("\n")) {
    if (!line) continue;
    const [name, cmd, path, dead] = line.split("|");
    if (name === "dispatch") continue; // Skip control window

    let statusIcon: string;
    let statusText: string;
    if (dead === "1") {
      statusIcon = `${fmt.RED}●${fmt.NC}`;
      statusText = "exited";
    } else if (cmd === "claude" || cmd === "node") {
      statusIcon = `${fmt.GREEN}●${fmt.NC}`;
      statusText = "running";
    } else {
      statusIcon = `${fmt.YELLOW}●${fmt.NC}`;
      statusText = "idle";
    }

    const shortPath = root && path.startsWith(root + "/")
      ? path.slice(root.length + 1)
      : path;

    console.log(
      `  ${statusIcon} ${fmt.BOLD}${name}${fmt.NC}  ${fmt.DIM}(${statusText})${fmt.NC}`,
    );
    console.log(`    ${fmt.DIM}path: ${shortPath}${fmt.NC}`);
  }

  console.log();
}

export function cmdLogs(args: string[], config: Config): void {
  const id = args[0];
  if (!id) {
    log.error("Usage: dispatch logs <agent-id>");
    process.exit(1);
  }

  const wtPath = worktreePath(id, config);
  const logFile = join(wtPath, ".dispatch.log");

  if (existsSync(logFile)) {
    log.info(`Tailing log: ${logFile}`);
    const child = tailFile(logFile);
    process.on("SIGINT", () => {
      child.kill();
      process.exit(0);
    });
    // Keep process alive while tailing
    child.on("exit", () => process.exit(0));
  } else if (windowExists(id)) {
    log.info("Capturing output from tmux pane...");
    console.log(tmuxCapture(id, 100));
  } else {
    log.error(`Agent '${id}' not found`);
    process.exit(1);
  }
}

export function cmdStop(args: string[]): void {
  const id = args[0];
  if (!id) {
    log.error("Usage: dispatch stop <agent-id>");
    process.exit(1);
  }

  if (!windowExists(id)) {
    log.warn(`Agent '${id}' is not running`);
    return;
  }

  log.info(`Stopping agent: ${id}`);
  tmuxSendKeys(id, "C-c");
  spawnSync("sleep", ["1"]);
  tmuxKillWindow(id);
  log.ok(`Agent stopped: ${id}`);
}

export function cmdResume(args: string[], config: Config): void {
  const id = args[0];
  if (!id) {
    log.error("Usage: dispatch resume <agent-id> [--headless] [--no-attach]");
    process.exit(1);
  }

  const headless = args.includes("--headless") || args.includes("-H");
  const noAttach = args.includes("--no-attach");

  ensureTmux();

  const wtPath = worktreePath(id, config);
  if (!existsSync(wtPath)) {
    log.error(`Worktree not found for '${id}'. Nothing to resume.`);
    process.exit(1);
  }

  if (windowExists(id)) {
    log.warn(`Agent '${id}' is already running. Attaching...`);
    tmuxAttach();
    return;
  }

  createWindow(id, wtPath);

  if (!headless) {
    const modelFlag = config.model ? `--model ${config.model}` : "";
    execSync(
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && claude --continue ${modelFlag}" Enter`,
    );
    log.ok(`Resumed agent: ${id} (interactive)`);
    if (!noAttach) tmuxAttach();
  } else {
    const resumePrompt = "Continue working on the task.";
    const claudeCmd = buildClaudeCmd(
      resumePrompt,
      "headless",
      wtPath,
      config,
      "--continue",
    );
    const logFile = join(wtPath, ".dispatch.log");
    execSync(
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && ${claudeCmd} 2>&1 | tee -a ${logFile}; dispatch _notify-done ${id}" Enter`,
    );
    log.ok(`Resumed agent: ${id} (headless)`);
  }
}

export function cmdCleanup(args: string[], config: Config): void {
  let id = "";
  let all = false;
  let deleteBranch = false;

  for (const arg of args) {
    switch (arg) {
      case "--all":
        all = true;
        break;
      case "--delete-branch":
        deleteBranch = true;
        break;
      default:
        id = arg;
        break;
    }
  }

  if (all) {
    log.info("Cleaning up all worktrees...");
    const root = gitRoot();
    const wtDir = join(root, config.worktreeDir);

    if (!existsSync(wtDir)) {
      log.info("No worktrees to clean up");
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(wtDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      log.info("No worktrees to clean up");
      return;
    }

    for (const name of entries) {
      if (windowExists(name)) {
        cmdStop([name]);
      }
      removeWorktree(name, config);
      if (deleteBranch) {
        const r = spawnSync("git", ["branch", "-D", name], { stdio: "pipe" });
        if (r.status === 0) {
          log.ok(`Deleted branch: ${name}`);
        } else {
          log.warn(`Branch not found: ${name}`);
        }
      }
    }
  } else if (id) {
    if (windowExists(id)) {
      cmdStop([id]);
    }
    removeWorktree(id, config);
    if (deleteBranch) {
      const r = spawnSync("git", ["branch", "-D", id], { stdio: "pipe" });
      if (r.status === 0) {
        log.ok(`Deleted branch: ${id}`);
      } else {
        log.warn(`Branch not found: ${id}`);
      }
    }
  } else {
    log.error("Usage: dispatch cleanup <agent-id> | --all [--delete-branch]");
    process.exit(1);
  }
}

export function cmdAttach(args: string[]): void {
  ensureTmux();
  if (!tmuxHasSession()) {
    log.error("No dispatch session running");
    process.exit(1);
  }
  const window = args[0] || undefined;
  tmuxAttach(window);
}

export function cmdNotifyDone(args: string[]): void {
  const agentId = args[0] || "unknown";
  notify("Dispatch", `Agent ${agentId} finished`);
  log.ok(`Agent ${agentId} completed`);
}

const CLAUDE_MD_SNIPPET = `
## Dispatch (multi-agent orchestration)

Launch Claude Code agents in isolated git worktrees. Each agent gets its own branch, so it can make changes without affecting your working tree or other agents. Agents run inside tmux — interactive mode to watch/guide, headless for fire-and-forget.

**When to use:** Hand off well-defined tasks (Linear tickets, bug fixes, features) to a parallel agent while you keep working. Avoid dispatching two agents to the same files — they'll create merge conflicts.

\`\`\`bash
# Launch agents
dispatch run HEY-123                                  # From Linear ticket (auto-fetches title + description)
dispatch run "Fix the auth bug" --name HEY-879        # Free text with custom branch name (hey-879)
dispatch run HEY-123 --headless                       # Background — check with: dispatch logs HEY-123
dispatch run HEY-123 -m sonnet --max-turns 20         # Sonnet, 20 turn limit
dispatch run HEY-123 HEY-124 HEY-125                 # Batch launch in parallel

# Monitor and interact
dispatch list                                         # Status: green=running, yellow=idle, red=exited
dispatch attach HEY-123                               # Jump to agent's terminal (auto-opens tab if no TTY)
dispatch logs HEY-123                                 # Tail headless agent output

# Lifecycle
dispatch stop HEY-123                                 # Interrupt agent (worktree preserved)
dispatch resume HEY-123                               # Pick up where it left off (--continue)
dispatch cleanup HEY-123 --delete-branch              # Remove worktree + branch
dispatch cleanup --all --delete-branch                # Clean up everything
\`\`\`

**Key flags:** \`--name/-n\` sets branch name, \`--model/-m\` picks model, \`--headless/-H\` for background, \`--prompt-file/-f\` for long prompts, \`--base/-b\` to branch off something other than dev.

Config: \`~/.dispatch.yml\` (base_branch, model, max_turns, max_budget, worktree_dir, claude_timeout).
Requires: tmux, claude CLI, git.
`;

export function cmdSetup(): void {
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, "utf-8");
    if (content.includes("dispatch run") || content.includes("Dispatch (multi-agent")) {
      log.warn("Dispatch section already exists in ~/.claude/CLAUDE.md");
      log.info("To update it, remove the existing Dispatch section and run setup again.");
      return;
    }
    appendFileSync(claudeMdPath, "\n" + CLAUDE_MD_SNIPPET);
    log.ok("Added dispatch section to ~/.claude/CLAUDE.md");
  } else {
    const claudeDir = join(homedir(), ".claude");
    if (!existsSync(claudeDir)) {
      spawnSync("mkdir", ["-p", claudeDir]);
    }
    writeFileSync(claudeMdPath, CLAUDE_MD_SNIPPET.trimStart());
    log.ok("Created ~/.claude/CLAUDE.md with dispatch section");
  }
}
