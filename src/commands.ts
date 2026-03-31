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
  cmuxClearStatus,
  cmuxSetProgress,
  cmuxClearProgress,
  cmuxPipePane,
  cmuxOpenBrowser,
  cmuxSetWorkspaceColor,
  cmuxLog,
  cmuxOpenMarkdown,
  cmuxTriggerFlash,
  cmuxFindWindow,
  loadCmuxWorkspaceId,
  tryCmuxCloseFromMarker,
} from "./cmux.js";
import type { AgentState } from "./cmux.js";
import { recordEvent, getRecentCompletions, getAgentSummaries } from "./history.js";

export const TICKET_RE = /^[A-Z]+-[0-9]+$/;

/** Update cmux workspace state: color + icon + status + sidebar log. */
function cmuxUpdateState(id: string, wtPath: string, state: AgentState, message?: string): void {
  if (!useCmux()) return;
  const wsId = getCmuxWorkspaceId(id) || loadCmuxWorkspaceId(wtPath);
  if (!wsId) return;
  cmuxSetWorkspaceColor(wsId, state);  // sets status with color + icon + notify
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

  // Create multiplexer session — returns cmux workspace ID or "tmux"
  const sessionId = createSession(id, wtPath);
  if (!sessionId) return null;

  const mode = headless ? "headless" : "interactive";
  const claudeCmd = buildClaudeCmd(prompt, mode, wtPath, config, extraArgs);

  if (useCmux()) {
    const wsId = sessionId;  // use the ID we just created, don't re-resolve
    cmuxUpdateState(id, wtPath, "starting", `Launching agent (${mode})`);

    if (mode === "interactive") {
      const modelFlag = config.model ? `--model ${config.model}` : "";
      cmuxSend(wsId!, `unset CLAUDECODE && claude ${modelFlag} --allowedTools "WebSearch,WebFetch"`);
      waitForClaude(id, config.claudeTimeout);
      // Extra settle time — Claude's TUI needs a moment before accepting input
      spawnSync("sleep", ["2"]);
      cmuxUpdateState(id, wtPath, "starting", "Claude ready, sending prompt");

      // Save prompt to file for reference (preserves original formatting)
      const pf = join(wtPath, ".dispatch-prompt.txt");
      writeFileSync(pf, prompt);
      // Collapse newlines to spaces so cmuxSend doesn't fragment the prompt
      // into multiple submissions (Claude Code TUI treats \n as Enter/submit).
      cmuxSend(wsId!, prompt.replace(/\n+/g, " "));
      spawnSync("sleep", ["3"]);
      cmuxSendKey(wsId!, "enter");
      // Clear dispatch status so cmux's native claude-hook takes over state tracking
      cmuxLog(wsId!, "Prompt sent — agent working");
      cmuxClearStatus(wsId!, "dispatch");
    } else {
      const logFile = join(wtPath, ".dispatch.log");
      cmuxUpdateState(id, wtPath, "running", "Headless agent started");
      cmuxSend(wsId!, `unset CLAUDECODE && ${claudeCmd} 2>&1 | tee -a ${logFile}; dispatch _notify-done ${id}`);
      // Set up progress tracking via pipe-pane for headless agents with max-turns
      if (config.maxTurns) {
        const progressScript = `dispatch _track-progress ${id} ${config.maxTurns}`;
        cmuxPipePane(wsId!, progressScript);
      }
    }
  } else if (mode === "interactive") {
    // Launch claude, wait for it to be ready, then send prompt via paste-buffer
    const modelFlag = config.model ? `--model ${config.model}` : "";
    execSync(
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && claude ${modelFlag} --allowedTools \\"WebSearch,WebFetch\\"" Enter`,
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
    spawnSync("sleep", ["3"]);
    execSync(`tmux send-keys -t "${tmuxTarget(id)}" Enter`);
  } else {
    // Headless: run with -p, tee to log, notify on completion
    const logFile = join(wtPath, ".dispatch.log");
    execSync(
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && ${claudeCmd} 2>&1 | tee -a ${logFile}; dispatch _notify-done ${id}" Enter`,
    );
  }

  // Record launch in persistent history
  recordEvent({
    id,
    event: "launched",
    ts: new Date().toISOString(),
    prompt: prompt.slice(0, 200),
    branch,
    mode,
  });

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
    tmuxAttach(launchedIds[0], false);
  } else if (inputs.length > 1) {
    log.ok(`All agents launched. Use ${fmt.BOLD}dispatch attach${fmt.NC} to view tabs.`);
  }
}

export function cmdList(config: Config, brief = false): void {
  ensureMultiplexer();

  if (!tmuxHasSession()) {
    // No active sessions — but show recent completions if any
    const recent = getRecentCompletions(24);
    if (recent.length === 0) {
      log.info("No dispatch agents running or recently completed");
      return;
    }
    if (brief) {
      console.log("No active agents.");
      console.log("");
      console.log("Recently completed:");
      for (const r of recent) {
        const prTag = r.pr ? `  ${r.pr}` : "";
        const time = r.completedAt ? new Date(r.completedAt).toLocaleTimeString() : "";
        const summaryLine = r.summary
          ? r.summary.split("\n").filter((l: string) => l.trim())[0]?.slice(0, 80) || ""
          : "";
        console.log(`  ✓ ${r.id}  (${r.status})  ${time}${prTag}`);
        if (summaryLine) console.log(`    ⤷ ${summaryLine}`);
      }
      return;
    }
    console.log();
    log.info("No active agents");
    console.log();
    console.log(`${fmt.BOLD}Recently Completed${fmt.NC}  ${fmt.DIM}(last 24h)${fmt.NC}`);
    console.log(
      `${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`,
    );
    for (const r of recent) {
      const prTag = r.pr ? `  ${fmt.BLUE}${r.pr}${fmt.NC}` : "";
      const time = r.completedAt
        ? `${fmt.DIM}${new Date(r.completedAt).toLocaleTimeString()}${fmt.NC}`
        : "";
      console.log(
        `  ${fmt.DIM}✓${fmt.NC} ${fmt.BOLD}${r.id}${fmt.NC}  ${time}${prTag}`,
      );
      if (r.summary) {
        const short = r.summary.split("\n").filter((l: string) => l.trim())[0] || "";
        if (short) {
          const display = short.length > 80 ? short.slice(0, 77) + "..." : short;
          console.log(`    ${fmt.DIM}⤷ ${display}${fmt.NC}`);
        }
      }
    }
    console.log();
    return;
  }

  const root = gitRoot();
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

  // Get recent completions from history (agents no longer running)
  const activeNames = new Set(agents.map((a) => a.name));
  const recent = getRecentCompletions(24).filter((r) => !activeNames.has(r.id));

  if (brief) {
    // Compact format for MCP consumption
    for (const a of agents) {
      const prTag = a.pr ? `  ${a.pr}` : "";
      console.log(`${a.statusIcon} ${a.name}  (${a.status})${a.runtime ? `  ${a.runtime}` : ""}${prTag}`);
    }
    if (recent.length > 0) {
      console.log("");
      console.log("Recently completed:");
      for (const r of recent) {
        const prTag = r.pr ? `  ${r.pr}` : "";
        const time = r.completedAt ? new Date(r.completedAt).toLocaleTimeString() : "";
        const summaryLine = r.summary
          ? r.summary.split("\n").filter((l: string) => l.trim())[0]?.slice(0, 80) || ""
          : "";
        console.log(`  ✓ ${r.id}  (${r.status})  ${time}${prTag}`);
        if (summaryLine) console.log(`    ⤷ ${summaryLine}`);
      }
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

  if (recent.length > 0) {
    console.log();
    console.log(`${fmt.BOLD}Recently Completed${fmt.NC}  ${fmt.DIM}(last 24h)${fmt.NC}`);
    console.log(
      `${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`,
    );
    for (const r of recent) {
      const prTag = r.pr ? `  ${fmt.BLUE}${r.pr}${fmt.NC}` : "";
      const time = r.completedAt
        ? `${fmt.DIM}${new Date(r.completedAt).toLocaleTimeString()}${fmt.NC}`
        : "";
      console.log(
        `  ${fmt.DIM}✓${fmt.NC} ${fmt.BOLD}${r.id}${fmt.NC}  ${time}${prTag}`,
      );
      if (r.summary) {
        const short = r.summary.split("\n").filter((l: string) => l.trim())[0] || "";
        if (short) {
          const display = short.length > 80 ? short.slice(0, 77) + "..." : short;
          console.log(`    ${fmt.DIM}⤷ ${display}${fmt.NC}`);
        }
      }
    }
  }

  console.log();
}

export function cmdHistory(args: string[]): void {
  const limit = parseInt(args.find((a) => /^\d+$/.test(a)) || "20", 10);
  const summaries = getAgentSummaries().slice(0, limit);

  if (summaries.length === 0) {
    log.info("No agent history");
    return;
  }

  console.log();
  console.log(`${fmt.BOLD}Agent History${fmt.NC}  ${fmt.DIM}(last ${summaries.length})${fmt.NC}`);
  console.log(
    `${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`,
  );

  for (const a of summaries) {
    const statusMap: Record<string, string> = {
      launched: `${fmt.GREEN}●${fmt.NC} launched`,
      completed: `${fmt.BLUE}●${fmt.NC} completed`,
      stopped: `${fmt.YELLOW}●${fmt.NC} stopped`,
      cleaned: `${fmt.DIM}●${fmt.NC} cleaned`,
    };
    const statusStr = statusMap[a.status] || a.status;
    const time = a.completedAt || a.launchedAt || "";
    const timeStr = time ? fmt.DIM + new Date(time).toLocaleString() + fmt.NC : "";
    const prStr = a.pr ? `  ${fmt.BLUE}${a.pr}${fmt.NC}` : "";

    console.log(`  ${statusStr}  ${fmt.BOLD}${a.id}${fmt.NC}  ${timeStr}${prStr}`);
    if (a.summary) {
      const short = a.summary.split("\n").filter((l: string) => l.trim())[0] || "";
      if (short) {
        const display = short.length > 80 ? short.slice(0, 77) + "..." : short;
        console.log(`    ${fmt.DIM}⤷ ${display}${fmt.NC}`);
      }
    }
  }
  console.log();
}

/** Look up PR info for a branch. Shared across commands. */
export function getPrInfo(branch: string): string {
  const prInfo = execQuiet(
    `gh pr list --head "${branch}" --state all --json number,state,url --jq '.[0] | "#\\(.number) \\(.state) \\(.url)"'`,
  );
  if (prInfo && prInfo.startsWith("#") && !prInfo.includes("null")) return prInfo;
  return "";
}

const MAX_ACTIONS = 8;

/** Parse a .dispatch.log JSON stream and extract structured status. */
export function parseAgentLog(logContent: string): {
  turns: number;
  filesModified: string[];
  toolsUsed: Map<string, number>;
  commits: string[];
  lastActions: string[];
  lastText: string;
} {
  let turnCount = 0;
  const filesModified = new Set<string>();
  const toolsUsed = new Map<string, number>();
  const commits: string[] = [];
  // Ring buffer — only keep the last MAX_ACTIONS entries
  const lastActions: string[] = [];
  let lastText = "";

  const lines = logContent.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === "assistant") {
      turnCount++;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === "text" && block.text) {
          lastText = block.text;
        }
        if (block.type === "tool_use") {
          const name = block.name || "unknown";
          toolsUsed.set(name, (toolsUsed.get(name) || 0) + 1);

          // Track file modifications
          const input = block.input || {};
          if (
            (name === "Edit" || name === "Write" || name === "NotebookEdit") &&
            input.file_path
          ) {
            filesModified.add(input.file_path);
          }

          // Track commits from Bash
          if (name === "Bash" && typeof input.command === "string") {
            const cmd = input.command;
            if (cmd.includes("git commit") || cmd.includes("git push")) {
              const msgMatch = cmd.match(/-m\s+["']([^"']+)["']/);
              if (msgMatch) {
                commits.push(msgMatch[1].slice(0, 100));
              } else if (cmd.includes("git push")) {
                pushAction("Pushed to remote");
              }
            }
            if (cmd.includes("gh pr create")) {
              pushAction("Created PR");
            }
          }

          // Build action description
          if (name === "Edit" && input.file_path) {
            pushAction(`Edited ${basename(input.file_path)}`);
          } else if (name === "Write" && input.file_path) {
            pushAction(`Created ${basename(input.file_path)}`);
          } else if (name === "Read" && input.file_path) {
            pushAction(`Read ${basename(input.file_path)}`);
          } else if (name === "Grep") {
            pushAction(`Searched for "${(input.pattern || "").slice(0, 30)}"`);
          } else if (name === "Bash" && input.command) {
            pushAction(`Ran: ${input.command.slice(0, 50)}`);
          }
        }
      }
    }
  }

  function pushAction(action: string) {
    if (lastActions.length >= MAX_ACTIONS) lastActions.shift();
    lastActions.push(action);
  }

  return {
    turns: turnCount,
    filesModified: Array.from(filesModified),
    toolsUsed,
    commits,
    lastActions,
    lastText,
  };
}

/** Format status for display (used by both CLI and MCP). */
export function formatStatus(
  id: string,
  status: string,
  parsed: ReturnType<typeof parseAgentLog>,
  pr?: string,
): string {
  const lines: string[] = [];
  lines.push(`Agent: ${id}  (${status})`);
  lines.push(`Turns: ${parsed.turns}`);

  if (pr) lines.push(`PR: ${pr}`);

  if (parsed.commits.length > 0) {
    lines.push(`Commits: ${parsed.commits.length}`);
    for (const c of parsed.commits.slice(-3)) {
      lines.push(`  - ${c}`);
    }
  }

  if (parsed.filesModified.length > 0) {
    lines.push(`Files modified: ${parsed.filesModified.length}`);
    // Show just filenames, not full paths
    for (const f of parsed.filesModified.slice(-10)) {
      lines.push(`  - ${basename(f)}`);
    }
    if (parsed.filesModified.length > 10) {
      lines.push(`  ... and ${parsed.filesModified.length - 10} more`);
    }
  }

  if (parsed.lastActions.length > 0) {
    lines.push("");
    lines.push("Recent actions:");
    for (const a of parsed.lastActions) {
      lines.push(`  ${a}`);
    }
  }

  // Last assistant message (truncated)
  if (parsed.lastText) {
    const textLines = parsed.lastText.split("\n").filter((l: string) => l.trim());
    const preview = textLines.slice(-3).join("\n");
    if (preview) {
      lines.push("");
      lines.push("Last output:");
      lines.push(preview.slice(0, 300));
    }
  }

  return lines.join("\n");
}

export function cmdStatus(args: string[], config: Config): void {
  const id = args[0];
  if (!id) {
    log.error("Usage: dispatch status <agent-id>");
    process.exit(1);
  }

  const wtPath = worktreePath(id, config);
  const logFile = join(wtPath, ".dispatch.log");

  // Load history once for both state detection and final fallback
  const histSummaries = getAgentSummaries();
  const hist = histSummaries.find((s) => s.id === id);

  // Determine agent state
  let agentStatus = "unknown";
  if (sessionExists(id)) {
    if (useCmux()) {
      agentStatus = "running";
    } else {
      const windowLines = tmuxListWindows();
      for (const line of windowLines.split("\n")) {
        const [name, pid] = line.split("|");
        if (name === id && pid && execQuiet(`pgrep -P ${pid}`) !== null) {
          agentStatus = "running";
        } else if (name === id) {
          agentStatus = "idle";
        }
      }
    }
  } else if (hist) {
    agentStatus = hist.status;
  }

  // Try log file first
  if (existsSync(logFile)) {
    const content = readFileSync(logFile, "utf-8");
    const parsed = parseAgentLog(content);
    const pr = getPrInfo(id);

    const output = formatStatus(id, agentStatus, parsed, pr);
    console.log();
    console.log(output);
    console.log();
    return;
  }

  // Fallback: screen capture for interactive agents
  if (sessionExists(id)) {
    const capture = tmuxCapture(id, 30);
    console.log();
    console.log(`Agent: ${id}  (${agentStatus})`);
    console.log(`Mode: interactive (no log file)`);
    console.log();
    console.log("Screen capture:");
    console.log(capture);
    console.log();
    return;
  }

  // Final fallback: history
  if (hist) {
    console.log();
    console.log(`Agent: ${id}  (${hist.status})`);
    if (hist.launchedAt) console.log(`Launched: ${new Date(hist.launchedAt).toLocaleString()}`);
    if (hist.completedAt) console.log(`Completed: ${new Date(hist.completedAt).toLocaleString()}`);
    if (hist.pr) console.log(`PR: ${hist.pr}`);
    if (hist.summary) {
      console.log();
      console.log("Last output:");
      const preview = hist.summary.split("\n").filter((l: string) => l.trim()).slice(-5).join("\n");
      console.log(preview.slice(0, 500));
    }
    console.log();
    return;
  }

  log.error(`Agent '${id}' not found`);
  process.exit(1);
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
    recordEvent({ id, event: "stopped", ts: new Date().toISOString() });
    log.ok(`Agent stopped: ${id}`);
    return;
  }

  // Fallback: try closing cmux workspace via marker file (works from outside cmux)
  const root = gitRoot();
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

  const sessionId = createSession(id, wtPath);
  if (!sessionId) return;

  if (useCmux()) {
    const wsId = sessionId;
    cmuxUpdateState(id, wtPath, "running", `Resuming agent (${headless ? "headless" : "interactive"})`);
    if (!headless) {
      const modelFlag = config.model ? `--model ${config.model}` : "";
      cmuxSend(wsId!, `unset CLAUDECODE && claude --continue ${modelFlag} --allowedTools "WebSearch,WebFetch"`);
      log.ok(`Resumed agent: ${id} (interactive)`);
      if (!noAttach) tmuxAttach(id, false);
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
      `tmux send-keys -t "${tmuxTarget(id)}" "unset CLAUDECODE && claude --continue ${modelFlag} --allowedTools \\"WebSearch,WebFetch\\"" Enter`,
    );
    log.ok(`Resumed agent: ${id} (interactive)`);
    if (!noAttach) tmuxAttach(id, false);
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

  // Build summary from last lines of log file (avoid reading full file)
  let summary = "";
  const logFile = join(wtPath, ".dispatch.log");
  if (existsSync(logFile)) {
    const tail = execQuiet(`tail -30 '${logFile}'`);
    if (tail) {
      const jsonLines = tail.split("\n").reverse();
      for (const jl of jsonLines) {
        try {
          const obj = JSON.parse(jl);
          if (obj.type === "assistant" && obj.message?.content) {
            const textBlock = obj.message.content.find((b: any) => b.type === "text");
            if (textBlock?.text) {
              summary = textBlock.text.slice(0, 500);
              break;
            }
          }
        } catch {}
      }
    }
  }

  // Record completion in persistent history
  const prTag = prUrl && prUrl.startsWith("http") ? prUrl : "";
  recordEvent({
    id: agentId,
    event: "completed",
    ts: new Date().toISOString(),
    summary: summary.slice(0, 500),
    pr: prTag,
  });

  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(agentId) || loadCmuxWorkspaceId(wtPath);

    // Flash the tab to get attention
    if (wsId) cmuxTriggerFlash(wsId);

    // Extract investigation summary from log file and post to sidebar
    if (wsId) extractSummaryToSidebar(wsId, wtPath);

    // Clear any progress bar
    if (wsId) cmuxClearProgress(wsId);

    if (prUrl && prUrl.startsWith("http")) {
      // Open PR in browser split + update state
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

/** Auto-cleanup on tab/session close: always remove worktree, only delete branch if merged. */
export function cmdAutoCleanup(args: string[], config: Config): void {
  const id = args[0];
  if (!id) return;

  removeWorktree(id, config);
  recordEvent({ id, event: "cleaned", ts: new Date().toISOString() });

  if (isBranchMerged(id, config.baseBranch)) {
    spawnSync("git", ["branch", "-d", id], { stdio: "pipe" });
    log.ok(`Auto-cleaned: ${id} (branch deleted — was merged)`);
  } else {
    log.ok(`Auto-cleaned: ${id} (worktree removed, branch kept)`);
  }
}

/** Extract summary from agent log and post key findings to cmux sidebar. */
function extractSummaryToSidebar(wsId: string, wtPath: string): void {
  const logFile = join(wtPath, ".dispatch.log");
  if (!existsSync(logFile)) return;

  try {
    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    // Parse JSON stream output, collect assistant text blocks
    const findings: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === "text" && block.text) {
              // Extract the last non-empty line as a finding
              const textLines = block.text.split("\n").filter((l: string) => l.trim());
              const last = textLines[textLines.length - 1]?.trim();
              if (last && last.length > 10 && last.length < 200) {
                findings.push(last);
              }
            }
          }
        }
      } catch {}
    }

    // Post the last few findings to sidebar
    const summary = findings.slice(-5);
    for (const finding of summary) {
      cmuxLog(wsId, finding);
    }

    // Count turns for summary
    const turnCount = lines.filter(l => {
      try { return JSON.parse(l).type === "assistant"; } catch { return false; }
    }).length;
    if (turnCount > 0) {
      cmuxLog(wsId, `Completed in ${turnCount} turns`);
    }
  } catch {}
}

export function cmdFind(args: string[]): void {
  const query = args.join(" ");
  if (!query) {
    log.error("Usage: dispatch find <search-term>");
    process.exit(1);
  }

  if (!useCmux()) {
    // Fallback: grep through log files
    const root = gitRoot();
    if (!root) { log.error("Not in a git repo"); return; }
    const wtDir = join(root, ".worktrees");
    if (!existsSync(wtDir)) { log.info("No worktrees to search"); return; }

    let entries: string[];
    try {
      entries = readdirSync(wtDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
    } catch { return; }

    let found = false;
    for (const name of entries) {
      const logFile = join(wtDir, name, ".dispatch.log");
      if (!existsSync(logFile)) continue;
      const content = readFileSync(logFile, "utf-8");
      if (content.includes(query)) {
        log.ok(`Found in agent: ${name}`);
        found = true;
      }
    }
    if (!found) log.info("No matches found");
    return;
  }

  // cmux: search across all workspace terminal content
  const result = cmuxFindWindow(query, { select: true });
  if (result) {
    console.log(result);
  } else {
    log.info("No matches found across agent workspaces");
  }
}

export function cmdTrackProgress(args: string[]): void {
  const agentId = args[0];
  const maxTurns = parseInt(args[1] || "0", 10);
  if (!agentId || !maxTurns) return;

  const wsId = getCmuxWorkspaceId(agentId);
  if (!wsId) return;

  // Read stdin line by line, count assistant turns, update progress
  let turnCount = 0;
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant") {
          turnCount++;
          const progress = Math.min(turnCount / maxTurns, 1);
          cmuxSetProgress(wsId, progress, `Turn ${turnCount}/${maxTurns}`);
        }
      } catch {}
    }
  });
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
