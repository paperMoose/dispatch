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
  ensureMultiplexer,
  useCmux,
  sessionExists,
  createSession,
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
  getCmuxWorkspaceId,
} from "./shell.js";
import {
  cmuxSend,
  cmuxSendKey,
  cmuxPasteBuffer,
  cmuxSetStatus,
  cmuxSetProgress,
  cmuxClearProgress,
  cmuxOpenBrowser,
  cmuxSetWorkspaceColor,
  cmuxLog,
  cmuxOpenMarkdown,
  loadCmuxWorkspaceId,
  tryCmuxCloseFromMarker,
} from "./cmux.js";
import type { AgentState } from "./cmux.js";

export const TICKET_RE = /^[A-Z]+-[0-9]+$/;

/** Update cmux workspace state: color + status + sidebar log. */
function cmuxUpdateState(id: string, wtPath: string, state: AgentState, message?: string): void {
  if (!useCmux()) return;
  const wsId = getCmuxWorkspaceId(id) || loadCmuxWorkspaceId(wtPath);
  if (!wsId) return;
  cmuxSetWorkspaceColor(wsId, state);
  cmuxSetStatus(wsId, "dispatch", state);
  if (message) cmuxLog(wsId, message);
}

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
    cmd += " --output-format stream-json --verbose";
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
): Promise<string | null> {
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
  if (sessionExists(id)) {
    log.error(`Agent '${id}' is already running. Use 'dispatch stop ${id}' first.`);
    return null;
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
  createSession(id, wtPath);

  const mode = headless ? "headless" : "interactive";
  const claudeCmd = buildClaudeCmd(prompt, mode, wtPath, config, extraArgs);

  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(id) || loadCmuxWorkspaceId(wtPath);
    cmuxUpdateState(id, wtPath, "starting", `Launching agent (${mode})`);

    if (mode === "interactive") {
      const modelFlag = config.model ? `--model ${config.model}` : "";
      cmuxSend(wsId!, `unset CLAUDECODE && claude ${modelFlag}`);
      waitForClaude(id, config.claudeTimeout);
      // Extra settle time — Claude's TUI needs a moment before accepting input
      spawnSync("sleep", ["2"]);
      cmuxUpdateState(id, wtPath, "running", "Claude ready, sending prompt");

      // Save prompt to file for reference
      const pf = join(wtPath, ".dispatch-prompt.txt");
      writeFileSync(pf, prompt);
      // Send prompt via cmux send (types text + Enter)
      cmuxSend(wsId!, prompt);
    } else {
      const logFile = join(wtPath, ".dispatch.log");
      cmuxUpdateState(id, wtPath, "running", "Headless agent started");
      cmuxSend(wsId!, `unset CLAUDECODE && ${claudeCmd} 2>&1 | tee -a ${logFile}; dispatch _notify-done ${id}`);
    }
  } else if (mode === "interactive") {
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
  return id;
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

  ensureMultiplexer();

  if (inputs.length > 1) {
    log.info(`Batch launching ${inputs.length} agents...`);
    console.log();
  }

  const launchedIds: string[] = [];
  for (const input of inputs) {
    const id = await launchAgent(input, headless, extraArgs, skipWorktree, promptFile, nameOverride, config);
    if (id) launchedIds.push(id);
  }

  console.log();

  // For single interactive agent, attach to its session
  if (!headless && launchedIds.length === 1 && !noAttach) {
    log.info("Attaching to tmux session...");
    log.dim("  Detach with: Ctrl-B then D");
    console.log();
    tmuxAttach(launchedIds[0]);
  } else if (inputs.length > 1) {
    log.ok(`All agents launched. Use ${fmt.BOLD}dispatch attach${fmt.NC} to view tabs.`);
  }
}

export function cmdList(config: Config, brief = false): void {
  ensureMultiplexer();

  if (!tmuxHasSession()) {
    log.info("No dispatch session running");
    return;
  }

  const root = execQuiet("git rev-parse --show-toplevel") || "";
  const lines = tmuxListWindows();

  interface AgentInfo {
    name: string;
    status: string;
    statusIcon: string;
    runtime: string;
    lastLine: string;
    pr: string;
  }

  const agents: AgentInfo[] = [];

  for (const line of lines.split("\n")) {
    if (!line) continue;
    const [name, pid, path, dead, created] = line.split("|");
    if (name === "dispatch") continue;

    let statusIcon: string;
    let status: string;
    if (dead === "1") {
      statusIcon = `${fmt.RED}●${fmt.NC}`;
      status = "exited";
    } else if (pid && execQuiet(`pgrep -P ${pid}`) !== null) {
      statusIcon = `${fmt.GREEN}●${fmt.NC}`;
      status = "running";
    } else {
      statusIcon = `${fmt.YELLOW}●${fmt.NC}`;
      status = "idle";
    }

    // Runtime
    let runtime = "";
    if (created) {
      const secs = Math.floor(Date.now() / 1000) - parseInt(created, 10);
      if (secs < 60) runtime = `${secs}s`;
      else if (secs < 3600) runtime = `${Math.floor(secs / 60)}m`;
      else runtime = `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
    }

    // PR link
    let pr = "";
    const prInfo = execQuiet(
      `gh pr list --head "${name}" --state all --json number,state --jq '.[0] | "#\\(.number) \\(.state)"'`,
    );
    if (prInfo && prInfo.startsWith("#") && !prInfo.includes("null")) pr = prInfo;

    // Last meaningful activity (skip in brief mode)
    let lastLine = "";
    if (!brief) {
      const logFile = join(path, ".dispatch.log");
      if (existsSync(logFile)) {
        const tail = execQuiet(`tail -20 '${logFile}'`);
        if (tail) {
          const jsonLines = tail.split("\n").reverse();
          for (const jl of jsonLines) {
            try {
              const obj = JSON.parse(jl);
              if (obj.type === "assistant" && obj.message?.content) {
                const textBlock = obj.message.content.find((b: any) => b.type === "text");
                if (textBlock?.text) {
                  const ll = textBlock.text.split("\n").filter((l: string) => l.trim());
                  lastLine = ll[ll.length - 1]?.trim() || "";
                  break;
                }
              }
            } catch {}
          }
        }
      }
      if (!lastLine) {
        const capture = tmuxCapture(name, 10);
        if (capture) {
          const capLines = capture.split("\n").filter((l) => l.trim());
          lastLine = capLines[capLines.length - 1]?.trim() || "";
        }
      }
      if (lastLine.length > 80) lastLine = lastLine.slice(0, 77) + "...";
    }

    agents.push({ name, status, statusIcon, runtime, lastLine, pr });
  }

  if (brief) {
    // Compact format: one line per agent, for MCP consumption
    for (const a of agents) {
      const prTag = a.pr ? `  ${a.pr}` : "";
      console.log(`${a.statusIcon} ${a.name}  (${a.status})${a.runtime ? `  ${a.runtime}` : ""}${prTag}`);
    }
    return;
  }

  console.log();
  console.log(`${fmt.BOLD}Running Agents${fmt.NC}`);
  console.log(
    `${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`,
  );

  for (const a of agents) {
    const prTag = a.pr ? `  ${fmt.BLUE}${a.pr}${fmt.NC}` : "";
    console.log(
      `  ${a.statusIcon} ${fmt.BOLD}${a.name}${fmt.NC}  ${fmt.DIM}(${a.status})${fmt.NC}${a.runtime ? `  ${fmt.DIM}${a.runtime}${fmt.NC}` : ""}${prTag}`,
    );
    if (a.lastLine) {
      console.log(`    ${fmt.DIM}⤷ ${a.lastLine}${fmt.NC}`);
    }
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
  } else if (sessionExists(id)) {
    log.info("Capturing output from tmux pane...");
    console.log(tmuxCapture(id, 100));
  } else {
    log.error(`Agent '${id}' not found`);
    process.exit(1);
  }
}

export function cmdStop(args: string[], config?: Config): void {
  const id = args[0];
  if (!id) {
    log.error("Usage: dispatch stop <agent-id>");
    process.exit(1);
  }

  if (sessionExists(id)) {
    log.info(`Stopping agent: ${id}`);
    tmuxSendKeys(id, "C-c");
    spawnSync("sleep", ["1"]);
    tmuxKillWindow(id);
    log.ok(`Agent stopped: ${id}`);
    return;
  }

  // Fallback: try closing cmux workspace via marker file (works from outside cmux)
  const root = execQuiet("git rev-parse --show-toplevel") || "";
  const wtDir = config?.worktreeDir || ".worktrees";
  const wtPath = root ? join(root, wtDir, id) : "";
  if (wtPath && tryCmuxCloseFromMarker(wtPath)) {
    log.ok(`Closed cmux workspace: ${id}`);
    return;
  }

  log.warn(`Agent '${id}' is not running`);
}

export function cmdResume(args: string[], config: Config): void {
  const id = args[0];
  if (!id) {
    log.error("Usage: dispatch resume <agent-id> [--headless] [--no-attach]");
    process.exit(1);
  }

  const headless = args.includes("--headless") || args.includes("-H");
  const noAttach = args.includes("--no-attach");

  ensureMultiplexer();

  const wtPath = worktreePath(id, config);
  if (!existsSync(wtPath)) {
    log.error(`Worktree not found for '${id}'. Nothing to resume.`);
    process.exit(1);
  }

  if (sessionExists(id)) {
    log.warn(`Agent '${id}' is already running. Attaching...`);
    tmuxAttach(id);
    return;
  }

  createSession(id, wtPath);

  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(id) || loadCmuxWorkspaceId(wtPath);
    cmuxUpdateState(id, wtPath, "running", `Resuming agent (${headless ? "headless" : "interactive"})`);
    if (!headless) {
      const modelFlag = config.model ? `--model ${config.model}` : "";
      cmuxSend(wsId!, `unset CLAUDECODE && claude --continue ${modelFlag}`);
      log.ok(`Resumed agent: ${id} (interactive)`);
      if (!noAttach) tmuxAttach(id);
    } else {
      const resumePrompt = "Continue working on the task.";
      const claudeCmd = buildClaudeCmd(resumePrompt, "headless", wtPath, config, "--continue");
      const logFile = join(wtPath, ".dispatch.log");
      cmuxSend(wsId!, `unset CLAUDECODE && ${claudeCmd} 2>&1 | tee -a ${logFile}; dispatch _notify-done ${id}`);
      log.ok(`Resumed agent: ${id} (headless)`);
    }
  } else if (!headless) {
    const modelFlag = config.model ? `--model ${config.model}` : "";
    execSync(
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && claude --continue ${modelFlag}" Enter`,
    );
    log.ok(`Resumed agent: ${id} (interactive)`);
    if (!noAttach) tmuxAttach(id);
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
      if (sessionExists(name)) {
        cmdStop([name], config);
      } else {
        // Try closing cmux workspace even if sessionExists fails (e.g., outside cmux)
        tryCmuxCloseFromMarker(join(wtDir, name));
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
    if (sessionExists(id)) {
      cmdStop([id], config);
    } else {
      tryCmuxCloseFromMarker(worktreePath(id, config));
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

/** Check if a branch was merged — tries git branch --merged, then gh pr status. */
function isBranchMerged(branch: string, baseBranch: string): boolean {
  // 1. Check if branch is merged into base via git
  const r = spawnSync(
    "git", ["branch", "--merged", `origin/${baseBranch}`],
    { stdio: "pipe" },
  );
  const mergedBranches = r.stdout?.toString() || "";
  if (mergedBranches.split("\n").some((b) => b.trim() === branch)) {
    return true;
  }

  // 2. Check GitHub PR status via gh CLI
  const pr = execQuiet(
    `gh pr list --head "${branch}" --state merged --json number --jq '.[0].number'`,
  );
  if (pr && /^\d+$/.test(pr)) return true;

  return false;
}

export function cmdPrune(args: string[], config: Config): void {
  const dryRun = args.includes("--dry-run");
  const deleteBranch = args.includes("--delete-branch");
  const mergedOnly = args.includes("--merged");
  const includeIdle = args.includes("--idle");

  const root = gitRoot();
  const wtDir = join(root, config.worktreeDir);

  if (!existsSync(wtDir)) {
    log.info("No worktrees to prune");
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(wtDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    log.info("No worktrees to prune");
    return;
  }

  // Find stale worktrees
  const stale: { name: string; reason: string; merged: boolean }[] = [];
  if (mergedOnly) log.info(`Checking ${entries.length} worktrees for merged PRs...`);
  for (const name of entries) {
    const hasSession = sessionExists(name);

    // --merged: check all worktrees regardless of session state
    if (mergedOnly) {
      const merged = isBranchMerged(name, config.baseBranch);
      if (!merged) continue;
      const reason = !hasSession ? "merged, no session" : "merged";
      stale.push({ name, reason, merged: true });
      continue;
    }

    if (!hasSession) {
      // No session at all — clearly stale
    } else if (includeIdle) {
      // Check if the agent is actually idle (Claude exited, sitting at shell prompt)
      const capture = tmuxCapture(name, 5);
      const lines = capture.split("\n").filter((l) => l.trim());
      const lastLine = lines[lines.length - 1]?.trim() || "";
      const isIdle = /[$%#]\s*$/.test(lastLine) && !/claude/i.test(lastLine);
      if (!isIdle) continue;
    } else {
      continue; // session exists and we're not checking idle
    }

    let merged = false;
    if (deleteBranch) {
      merged = isBranchMerged(name, config.baseBranch);
    }

    const reason = !hasSession ? "no session" : "idle";
    stale.push({ name, reason, merged });
  }

  if (stale.length === 0) {
    log.ok("No stale worktrees found");
    return;
  }

  console.log();
  console.log(`${fmt.BOLD}Stale worktrees${fmt.NC}`);
  console.log(
    `${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`,
  );
  for (const { name, reason, merged } of stale) {
    const mergedTag = merged && !reason.includes("merged") ? `  ${fmt.GREEN}(merged)${fmt.NC}` : "";
    const reasonTag = `${fmt.DIM}(${reason})${fmt.NC}`;
    console.log(`  ${fmt.RED}●${fmt.NC} ${name}  ${reasonTag}${mergedTag}`);
  }
  console.log();

  if (dryRun) {
    log.info(`${stale.length} stale worktree(s) would be pruned. Run without --dry-run to remove.`);
    return;
  }

  for (const { name } of stale) {
    if (sessionExists(name)) {
      cmdStop([name], config);
    } else {
      tryCmuxCloseFromMarker(worktreePath(name, config));
    }
    removeWorktree(name, config);
    if (deleteBranch) {
      const r = spawnSync("git", ["branch", "-D", name], { stdio: "pipe" });
      if (r.status === 0) {
        log.ok(`Deleted branch: ${name}`);
      }
    }
  }

  execQuiet("git worktree prune");
  console.log();
  log.ok(`Pruned ${stale.length} stale worktree(s)`);
}

export function cmdDashboard(config: Config): void {
  if (!useCmux()) {
    log.error("Dashboard requires cmux");
    return;
  }

  const root = gitRoot();
  const dashPath = join(root, ".dispatch-dashboard.md");

  // Write initial dashboard
  writeDashboardFile(dashPath, config);

  // Open markdown panel in cmux (it auto-reloads on file change)
  const wsId = process.env.CMUX_WORKSPACE_ID;
  if (wsId) {
    cmuxOpenMarkdown(wsId, dashPath);
    log.ok("Dashboard opened — auto-refreshes on changes");
  } else {
    log.warn(`Markdown file written to ${dashPath}. Open with: cmux markdown open ${dashPath}`);
  }

  // Refresh loop — update every 10 seconds
  const refresh = () => writeDashboardFile(dashPath, config);
  setInterval(refresh, 10_000);
  log.dim("Refreshing every 10s. Ctrl-C to stop.");

  // Keep alive
  process.on("SIGINT", () => {
    // Clean up dashboard file
    try { require("fs").unlinkSync(dashPath); } catch {}
    process.exit(0);
  });
}

function writeDashboardFile(dashPath: string, config: Config): void {
  const lines = tmuxListWindows();
  if (!lines) {
    writeFileSync(dashPath, "# Dispatch Dashboard\n\nNo agents running.\n");
    return;
  }

  const rows: string[] = [];
  for (const line of lines.split("\n")) {
    if (!line) continue;
    const [name, pid, path, dead, created] = line.split("|");
    if (name === "dispatch") continue;

    let status: string;
    if (dead === "1") {
      status = "🔴 exited";
    } else if (pid && execQuiet(`pgrep -P ${pid}`) !== null) {
      status = "🟢 running";
    } else {
      status = "🟡 idle";
    }

    let runtime = "";
    if (created) {
      const secs = Math.floor(Date.now() / 1000) - parseInt(created, 10);
      if (secs < 60) runtime = `${secs}s`;
      else if (secs < 3600) runtime = `${Math.floor(secs / 60)}m`;
      else runtime = `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
    }

    let pr = "";
    const prInfo = execQuiet(
      `gh pr list --head "${name}" --state all --json number,state --jq '.[0] | "#\\(.number) \\(.state)"'`,
    );
    if (prInfo && prInfo.startsWith("#") && !prInfo.includes("null")) pr = prInfo;

    rows.push(`| ${name} | ${status} | ${runtime} | ${pr} |`);
  }

  const now = new Date().toLocaleTimeString();
  const md = `# Dispatch Dashboard

_Updated: ${now}_

| Agent | Status | Runtime | PR |
|-------|--------|---------|-----|
${rows.join("\n")}

---
_${rows.length} agent(s) total_
`;

  writeFileSync(dashPath, md);
}

export function cmdAttach(args: string[]): void {
  ensureMultiplexer();
  if (!tmuxHasSession()) {
    log.error("No dispatch session running");
    process.exit(1);
  }
  const window = args[0] || undefined;
  tmuxAttach(window);
}

export function cmdNotifyDone(args: string[], config: Config): void {
  const agentId = args[0] || "unknown";
  const wtPath = worktreePath(agentId, config);

  notify("Dispatch", `Agent ${agentId} finished`, agentId);
  log.ok(`Agent ${agentId} completed`);

  // Check for a PR on this branch
  const prUrl = execQuiet(
    `gh pr list --head "${agentId}" --state open --json url --jq '.[0].url'`,
  );

  if (useCmux()) {
    if (prUrl && prUrl.startsWith("http")) {
      // Open PR in browser split + update state
      const wsId = getCmuxWorkspaceId(agentId);
      if (wsId) {
        cmuxOpenBrowser(wsId, prUrl);
        cmuxLog(wsId, `PR opened: ${prUrl}`);
      }
      cmuxUpdateState(agentId, wtPath, "done", `PR created: ${prUrl}`);
      log.ok(`Opened PR in browser: ${prUrl}`);
    } else {
      cmuxUpdateState(agentId, wtPath, "done", "Agent finished");
    }
  }

  // Auto-prune if the branch was merged
  if (isBranchMerged(agentId, config.baseBranch)) {
    cmuxUpdateState(agentId, wtPath, "merged", "Branch merged — auto-pruning");
    log.info(`Branch '${agentId}' was merged — auto-pruning worktree`);
    if (sessionExists(agentId)) {
      tmuxKillWindow(agentId);
    }
    removeWorktree(agentId, config);
    spawnSync("git", ["branch", "-D", agentId], { stdio: "pipe" });
    log.ok(`Auto-pruned: ${agentId}`);
  }
}

const CLAUDE_MD_SNIPPET = `
## Dispatch (multi-agent orchestration)

Launch Claude Code agents in isolated git worktrees. Each agent gets its own branch, so it can make changes without affecting your working tree or other agents. Agents run inside tmux or cmux — interactive mode to watch/guide, headless for fire-and-forget.

**Default model: Opus.** All agents use Opus unless you explicitly pass \`--model sonnet\` or \`--model haiku\`. Do not use Sonnet unless specifically requested.

**When to use:** Hand off well-defined tasks (Linear tickets, bug fixes, features) to a parallel agent while you keep working. Avoid dispatching two agents to the same files — they'll create merge conflicts.

\`\`\`bash
# Launch agents (all use Opus by default)
dispatch run HEY-123                                  # From Linear ticket (auto-fetches title + description)
dispatch run "Fix the auth bug" --name HEY-879        # Free text with custom branch name (hey-879)
dispatch run HEY-123 --headless                       # Background — check with: dispatch logs HEY-123
dispatch run HEY-123 --max-turns 20                   # Opus with 20 turn limit
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
dispatch prune --merged --delete-branch               # Remove worktrees with merged PRs
\`\`\`

**Key flags:** \`--name/-n\` sets branch name, \`--model/-m\` picks model (default: opus), \`--headless/-H\` for background, \`--prompt-file/-f\` for long prompts, \`--base/-b\` to branch off something other than dev.

Config: \`~/.dispatch.yml\` (base_branch, model, max_turns, max_budget, worktree_dir, claude_timeout).
Requires: tmux or cmux, claude CLI, git.
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
