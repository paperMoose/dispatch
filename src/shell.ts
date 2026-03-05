import { execSync, spawnSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";
import type { Config } from "./config.js";
import {
  isCmuxAvailable,
  cmuxNewWorkspace,
  cmuxRenameWorkspace,
  cmuxCloseWorkspace,
  cmuxListWorkspaces,
  parseCmuxWorkspaces,
  cmuxSelectWorkspace,
  cmuxSend,
  cmuxSendKey,
  cmuxReadScreen,
  cmuxPasteBuffer,
  cmuxNotify,
  cmuxSetStatus,
  cmuxClearStatus,
  cmuxSetProgress,
  cmuxClearProgress,
  cmuxSetHook,
  cmuxTriggerFlash,
  cmuxFindWindow,
  cmuxPipePane,
  saveCmuxWorkspaceId,
  loadCmuxWorkspaceId,
} from "./cmux.js";

// ---------------------------------------------------------------------------
// Multiplexer detection — prefer cmux over tmux when available
// ---------------------------------------------------------------------------
let _useCmux: boolean | undefined;
export function useCmux(): boolean {
  if (_useCmux === undefined) _useCmux = isCmuxAvailable();
  return _useCmux;
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------
const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[0;33m";
const BLUE = "\x1b[0;34m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

export const fmt = { RED, GREEN, YELLOW, BLUE, BOLD, DIM, NC };

export const log = {
  info: (...args: unknown[]) =>
    console.log(`${BLUE}▸${NC}`, ...args),
  ok: (...args: unknown[]) =>
    console.log(`${GREEN}✓${NC}`, ...args),
  warn: (...args: unknown[]) =>
    console.log(`${YELLOW}⚠${NC}`, ...args),
  error: (...args: unknown[]) =>
    console.error(`${RED}✗${NC}`, ...args),
  dim: (...args: unknown[]) =>
    console.log(`${DIM}${args.join(" ")}${NC}`),
};

// Tab colors for iTerm2 (cycle through these)
const TAB_COLORS = [
  "2E86AB", "A23B72", "F18F01", "C73E1D",
  "3B1F2B", "44BBA4", "E94F37", "393E41",
];

const DISPATCH_SESSION = "dispatch";

// ---------------------------------------------------------------------------
// Exec helpers
// ---------------------------------------------------------------------------
export function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

export function execQuiet(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
export function gitRoot(): string {
  const root = execQuiet("git rev-parse --show-toplevel");
  if (!root) {
    log.error("Not inside a git repository");
    process.exit(1);
  }
  return root;
}

export function ensureWorktreeDir(config: Config): string {
  const root = gitRoot();
  const dir = join(root, config.worktreeDir);
  mkdirSync(dir, { recursive: true });

  // Add to .gitignore if not already there
  const gitignore = join(root, ".gitignore");
  const entry = `${config.worktreeDir}/`;
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, "utf-8");
    if (!content.split("\n").includes(entry)) {
      appendFileSync(gitignore, `\n${entry}\n`);
    }
  } else {
    writeFileSync(gitignore, `${entry}\n`);
  }

  return dir;
}

export function worktreePath(id: string, config: Config): string {
  return join(gitRoot(), config.worktreeDir, id);
}

export function createWorktree(
  id: string,
  branch: string,
  config: Config,
): void {
  const wtPath = worktreePath(id, config);

  if (existsSync(wtPath)) {
    log.warn(`Worktree already exists: ${wtPath}`);
    return;
  }

  ensureWorktreeDir(config);

  log.info(
    `Creating worktree: ${BOLD}${id}${NC} (branch: ${branch} off ${config.baseBranch})`,
  );
  execQuiet(`git fetch origin "${config.baseBranch}"`);

  const r1 = spawnSync(
    "git",
    ["worktree", "add", "-b", branch, wtPath, `origin/${config.baseBranch}`],
    { stdio: "pipe" },
  );
  if (r1.status !== 0) {
    // Branch might already exist
    const r2 = spawnSync("git", ["worktree", "add", wtPath, branch], {
      stdio: "pipe",
    });
    if (r2.status !== 0) {
      log.error("Failed to create worktree");
      process.exit(1);
    }
  }
  log.ok(`Worktree created at ${wtPath}`);
}

export function removeWorktree(id: string, config: Config): boolean {
  const wtPath = worktreePath(id, config);

  if (!existsSync(wtPath)) {
    log.warn(`Worktree not found: ${id}`);
    return true;
  }

  log.info(`Removing worktree: ${id}`);
  const r = spawnSync("git", ["worktree", "remove", "--force", wtPath], {
    stdio: "pipe",
  });
  if (r.status !== 0) {
    log.error(
      `Failed to remove worktree. Try: git worktree remove --force ${wtPath}`,
    );
    return false;
  }
  execQuiet("git worktree prune");
  log.ok(`Worktree removed: ${id}`);
  return true;
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------
export function ensureMultiplexer(): void {
  if (useCmux()) {
    log.dim("Using cmux as multiplexer backend");
    return;
  }
  const r = spawnSync("command", ["-v", "tmux"], { shell: true, stdio: "pipe" });
  if (r.status !== 0) {
    log.error("tmux is required (or install cmux). Install with: brew install tmux");
    process.exit(1);
  }
}

/** @deprecated Use ensureMultiplexer instead */
export const ensureTmux = ensureMultiplexer;

export function sessionExists(id: string): boolean {
  if (useCmux()) {
    return cmuxWorkspaceExists(id);
  }
  const r = spawnSync("tmux", ["has-session", "-t", sessionName(id)], {
    stdio: "pipe",
  });
  return r.status === 0;
}

function cmuxWorkspaceExists(id: string): boolean {
  // Primary: check marker file in worktree
  const root = execQuiet("git rev-parse --show-toplevel") || "";
  if (root) {
    const wtPath = join(root, ".worktrees", id);
    const wsId = existsSync(wtPath) ? loadCmuxWorkspaceId(wtPath) : null;
    if (wsId) {
      // Verify the workspace still exists in cmux
      const workspaces = parseCmuxWorkspaces();
      return workspaces.some(w => w.ref === wsId);
    }
  }
  // Fallback: fuzzy title match (cmux truncates long titles)
  const workspaces = parseCmuxWorkspaces();
  return workspaces.some(w => w.title === id || w.title.startsWith(id.slice(0, 15)));
}

export function createSession(id: string, cwd: string): boolean {
  if (sessionExists(id)) {
    log.warn(`Session '${id}' already exists`);
    return false;
  }

  if (useCmux()) {
    const workspaceId = cmuxNewWorkspace();
    if (!workspaceId) {
      log.error("Failed to create cmux workspace");
      process.exit(1);
    }
    cmuxRenameWorkspace(workspaceId, id);
    // cd into the worktree directory
    cmuxSend(workspaceId, `cd '${cwd}'`);
    saveCmuxWorkspaceId(cwd, workspaceId);
    cmuxSetStatus(workspaceId, "dispatch", "starting", { color: "#2E86AB" });
    // Auto-prune hook: when the workspace closes, notify dispatch
    cmuxSetHook(workspaceId, "pane-exited", `dispatch _notify-done ${id}`);
    return true;
  }

  const session = sessionName(id);
  const r = spawnSync(
    "tmux",
    ["new-session", "-d", "-s", session, "-c", cwd],
    { stdio: "pipe" },
  );
  if (r.status !== 0) {
    const err = r.stderr?.toString().trim();
    log.error(`Failed to create tmux session: ${err}`);
    process.exit(1);
  }

  // Session-level settings
  execSync(`tmux set -t "${session}" mouse on`);
  execSync(`tmux set -t "${session}" history-limit 50000`);
  execQuiet(`tmux set -t "${session}" set-titles on`);
  execQuiet(`tmux set -t "${session}" set-titles-string "${id}"`);
  execQuiet(`tmux setw -t "${session}" allow-passthrough on`);
  execQuiet(`tmux setw -t "${session}" automatic-rename off`);

  // Auto-prune hook: when the session is destroyed, check if branch was merged
  execQuiet(`tmux set-hook -t "${session}" session-closed "run-shell 'dispatch _notify-done ${id}'"`);

  return true;
}

function sessionName(id: string): string {
  return `${DISPATCH_SESSION}-${id}`;
}

export function tmuxTarget(id: string): string {
  return sessionName(id);
}

export function tmuxSendKeys(id: string, keys: string): void {
  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(id);
    if (wsId) cmuxSendKey(wsId, keys === "C-c" ? "ctrl-c" : keys);
    return;
  }
  execSync(`tmux send-keys -t "${tmuxTarget(id)}" ${keys}`);
}

export function tmuxSendText(id: string, text: string): void {
  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(id);
    if (wsId) cmuxSend(wsId, text);
    return;
  }
  execSync(`tmux send-keys -t "${tmuxTarget(id)}" "${text}" Enter`);
}

export function tmuxCapture(id: string, lines: number): string {
  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(id);
    if (wsId) return cmuxReadScreen(wsId, lines, true);
    return "";
  }
  return (
    execQuiet(
      `tmux capture-pane -t "${tmuxTarget(id)}" -p -S -${lines}`,
    ) || ""
  );
}

export function tmuxKillWindow(id: string): void {
  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(id);
    if (wsId) cmuxCloseWorkspace(wsId);
    return;
  }
  execQuiet(`tmux kill-session -t "${tmuxTarget(id)}"`);
}

export function tmuxListWindows(): string {
  if (useCmux()) {
    return cmuxListDispatchWorkspaces();
  }
  // List all dispatch-* sessions, format to match old window-based output
  const out = execQuiet(
    `tmux list-sessions -F "#{session_name}" 2>/dev/null`,
  );
  if (!out) return "";
  const prefix = `${DISPATCH_SESSION}-`;
  const sessions = out.split("\n").filter((s) => s.startsWith(prefix));
  const results: string[] = [];
  for (const session of sessions) {
    const id = session.slice(prefix.length);
    const paneInfo = execQuiet(
      `tmux list-panes -t "${session}" -F "#{pane_pid}|#{pane_current_path}|#{pane_dead}"`,
    );
    const created = execQuiet(
      `tmux display-message -t "${session}" -p "#{session_created}"`,
    );
    const info = paneInfo?.split("\n")[0] || "||";
    results.push(`${id}|${info}|${created || ""}`);
  }
  return results.join("\n");
}

export function tmuxHasSession(): boolean {
  if (useCmux()) {
    return cmuxListDispatchWorkspaces() !== "";
  }
  // Check if any dispatch sessions exist
  const out = execQuiet(
    `tmux list-sessions -F "#{session_name}" 2>/dev/null`,
  );
  if (!out) return false;
  return out.split("\n").some((s) => s.startsWith(`${DISPATCH_SESSION}-`));
}

/** List cmux workspaces that belong to dispatch, formatted for cmdList.
 *  We scan worktree directories for the .dispatch-cmux-workspace marker file,
 *  then verify the workspace still exists in cmux. */
function cmuxListDispatchWorkspaces(): string {
  const root = execQuiet("git rev-parse --show-toplevel") || "";
  if (!root) return "";

  const wtDir = join(root, ".worktrees");
  if (!existsSync(wtDir)) return "";

  let entries: string[];
  try {
    entries = readdirSync(wtDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return ""; }

  const workspaces = parseCmuxWorkspaces();
  const results: string[] = [];

  for (const name of entries) {
    const wtPath = join(wtDir, name);
    const wsId = loadCmuxWorkspaceId(wtPath);
    if (!wsId) continue;
    // Verify workspace still exists in cmux
    const ws = workspaces.find(w => w.ref === wsId);
    if (!ws) continue;
    // Format: name|pid|path|dead|created
    results.push(`${name}||${wtPath}|0|`);
  }
  return results.join("\n");
}

export function tmuxAttach(window?: string): void {
  if (!window) {
    log.error("Agent ID required for attach");
    return;
  }

  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(window);
    if (wsId) {
      cmuxSelectWorkspace(wsId);
      log.ok(`Focused cmux workspace: ${window}`);
    } else {
      log.error(`cmux workspace not found for agent: ${window}`);
    }
    return;
  }

  const target = sessionName(window);
  const hasTTY = process.stdin.isTTY;

  if (hasTTY) {
    spawnSync("tmux", ["attach", "-t", target], {
      stdio: "inherit",
      env: { ...process.env, TERM_PROGRAM: "dumb" },
    });
  } else if (process.platform === "darwin") {
    // No TTY (e.g. inside Claude Code) — open a new terminal tab via AppleScript
    const script = openTerminalTabAppleScript(target);
    if (script) {
      spawnSync("osascript", ["-e", script], { stdio: "pipe" });
    } else {
      log.warn(`No supported terminal detected. Run manually: tmux attach -t ${target}`);
    }
  } else {
    log.warn(`No TTY available. Run manually: tmux attach -t ${target}`);
  }
}

function openTerminalTabAppleScript(target: string): string | null {
  const prefix = `${DISPATCH_SESSION}-`;
  const agentName = target.startsWith(prefix) ? target.slice(prefix.length) : target;

  // Check which terminal is running, in preference order
  const terminals = [
    {
      name: "cmux",
      bundleId: "ai.manaflow.cmux",
      script: `tell application "System Events"
        set frontmost of process "cmux" to true
        tell process "cmux"
          keystroke "t" using command down
          delay 0.3
          keystroke "TERM_PROGRAM=dumb tmux attach -t ${target}"
          key code 36
        end tell
      end tell`,
    },
    {
      name: "iTerm2",
      bundleId: "com.googlecode.iterm2",
      script: `tell application "iTerm2"
        activate
        tell current window
          create tab with default profile
          tell current session
            set name to "${agentName}"
            write text "TERM_PROGRAM=dumb tmux attach -t ${target}"
          end tell
        end tell
      end tell`,
    },
    {
      name: "Warp",
      bundleId: "dev.warp.Warp-Stable",
      script: `tell application "Warp"
        activate
        tell application "System Events" to tell process "Warp"
          keystroke "t" using command down
          delay 0.3
          keystroke "tmux attach -t ${target}"
          key code 36
        end tell
      end tell`,
    },
    {
      name: "Terminal",
      bundleId: "com.apple.Terminal",
      script: `tell application "Terminal"
        activate
        do script "tmux attach -t ${target}"
      end tell`,
    },
  ];

  for (const t of terminals) {
    const r = spawnSync("osascript", [
      "-e",
      `tell application "System Events" to return (name of processes) contains "${t.name}"`,
    ], { stdio: "pipe" });
    if (r.stdout?.toString().trim() === "true") {
      return t.script;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Linear integration
// ---------------------------------------------------------------------------
interface LinearTicket {
  title: string;
  description: string;
}

export async function fetchLinearTicket(
  ticketId: string,
): Promise<LinearTicket> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    log.warn("Could not fetch ticket details (set LINEAR_API_KEY for auto-fetch)");
    return { title: ticketId, description: "" };
  }

  const teamKey = ticketId.split("-")[0];
  const issueNum = parseInt(ticketId.split("-")[1], 10);

  log.info(`Fetching Linear ticket: ${ticketId}`);

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: `{ issueSearch(filter: { number: { eq: ${issueNum} }, team: { key: { eq: "${teamKey}" } } }) { nodes { title description identifier url branchName } } }`,
      }),
    });

    const data = (await response.json()) as any;
    const nodes = data?.data?.issueSearch?.nodes;

    if (nodes && nodes.length > 0) {
      log.ok(`Ticket: ${nodes[0].title}`);
      return {
        title: nodes[0].title || ticketId,
        description: nodes[0].description || "",
      };
    }
  } catch {
    // Network error — fall through
  }

  log.warn("Could not fetch ticket details");
  return { title: ticketId, description: "" };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export function notify(title: string, message: string, agentId?: string): void {
  if (useCmux()) {
    const wsId = agentId ? getCmuxWorkspaceId(agentId) : undefined;
    cmuxNotify(title, {
      body: message,
      workspaceId: wsId || undefined,
    });
    // Also update sidebar status
    if (wsId) {
      cmuxSetStatus(wsId, "dispatch", "done", { color: "#44BBA4" });
      cmuxClearProgress(wsId);
    }
    return;
  }
  execQuiet(
    `osascript -e 'display notification "${message}" with title "${title}" sound name "Glass"'`,
  );
}

// ---------------------------------------------------------------------------
// cmux workspace ID lookup
// ---------------------------------------------------------------------------

/** Resolve agent ID to a cmux workspace ID by checking worktree marker files. */
function getCmuxWorkspaceId(id: string): string | null {
  // Primary: check marker file in worktree
  const cwd = process.env.DISPATCH_CWD || process.cwd();
  const root = execQuiet("git rev-parse --show-toplevel") || cwd;
  const wtPath = join(root, ".worktrees", id);
  if (existsSync(wtPath)) {
    const wsId = loadCmuxWorkspaceId(wtPath);
    if (wsId) return wsId;
  }
  // Fallback: search by workspace title (exact or prefix match, since cmux truncates)
  const workspaces = parseCmuxWorkspaces();
  const ws = workspaces.find(w => w.title === id) ||
    workspaces.find(w => id.startsWith(w.title) || w.title.startsWith(id.slice(0, 15)));
  return ws?.ref || null;
}

export { getCmuxWorkspaceId };

// ---------------------------------------------------------------------------
// Claude readiness
// ---------------------------------------------------------------------------
export function waitForClaude(id: string, timeout: number): void {
  if (useCmux()) {
    const wsId = getCmuxWorkspaceId(id);
    if (wsId) cmuxSetStatus(wsId, "dispatch", "initializing", { color: "#F18F01" });
  }

  let waited = 0;
  while (waited < timeout) {
    const content = tmuxCapture(id, 5);
    if (/^\s*[>?]\s*$/m.test(content) || /╭|Welcome|claude/i.test(content)) {
      if (useCmux()) {
        const wsId = getCmuxWorkspaceId(id);
        if (wsId) cmuxSetStatus(wsId, "dispatch", "running", { color: "#44BBA4" });
      }
      return;
    }
    spawnSync("sleep", ["1"]);
    waited++;
  }
  log.warn(`Claude Code may not be fully initialized (waited ${timeout}s)`);
}

// ---------------------------------------------------------------------------
// Tail (async — only used by logs command)
// ---------------------------------------------------------------------------
export function tailFile(path: string): ChildProcess {
  return spawn("tail", ["-f", path], { stdio: "inherit" });
}
