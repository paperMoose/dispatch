import { execSync, spawnSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import type { Config } from "./config.js";

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
export function ensureTmux(): void {
  const r = spawnSync("command", ["-v", "tmux"], { shell: true, stdio: "pipe" });
  if (r.status !== 0) {
    log.error("tmux is required. Install with: brew install tmux");
    process.exit(1);
  }
}

export function ensureSession(): void {
  const r = spawnSync("tmux", ["has-session", "-t", DISPATCH_SESSION], {
    stdio: "pipe",
  });
  if (r.status !== 0) {
    execSync(
      `tmux new-session -d -s "${DISPATCH_SESSION}" -n "dispatch"`,
    );
    // Enable mouse scrolling and increase scrollback buffer (session-scoped, not global)
    execSync(`tmux set -t "${DISPATCH_SESSION}" mouse on`);
    execSync(`tmux set -t "${DISPATCH_SESSION}" history-limit 50000`);
    // Propagate tmux window names as terminal/tab titles
    execQuiet(`tmux set -t "${DISPATCH_SESSION}" set-titles on`);
    execQuiet(`tmux set -t "${DISPATCH_SESSION}" set-titles-string "#W"`);
    execSync(
      `tmux send-keys -t "${DISPATCH_SESSION}:dispatch" "# Dispatch control window" Enter`,
    );
  }
}

export function windowExists(id: string): boolean {
  const out = execQuiet(
    `tmux list-windows -t "${DISPATCH_SESSION}" -F "#{window_name}"`,
  );
  if (!out) return false;
  return out.split("\n").includes(id);
}

export function createWindow(id: string, cwd: string): boolean {
  if (windowExists(id)) {
    log.warn(`Window '${id}' already exists in tmux session`);
    return false;
  }

  ensureSession();
  // Use spawnSync — some tmux versions need explicit handling
  const r = spawnSync(
    "tmux",
    ["new-window", "-a", "-t", DISPATCH_SESSION, "-n", id, "-c", cwd],
    { stdio: "pipe" },
  );
  if (r.status !== 0) {
    const err = r.stderr?.toString().trim();
    log.error(`Failed to create tmux window: ${err}`);
    process.exit(1);
  }

  const target = `${DISPATCH_SESSION}:${id}`;

  // Allow iTerm2 escape sequences to pass through tmux (requires tmux 3.3+)
  execQuiet(`tmux setw -t "${target}" allow-passthrough on`);
  // Prevent tmux from renaming window based on running process
  execQuiet(`tmux setw -t "${target}" automatic-rename off`);

  // Set tab color (cycle through palette)
  const countStr = execQuiet(
    `tmux list-windows -t "${DISPATCH_SESSION}" | wc -l`,
  );
  const count = parseInt(countStr || "1", 10);
  const hex = TAB_COLORS[(count - 1) % TAB_COLORS.length];
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  const badge = Buffer.from(id).toString("base64");

  // Set terminal title (OSC 0 — works in all terminals) + iTerm2 tab color + badge, then clear
  execSync(
    `tmux send-keys -t "${target}" "printf '\\\\033]0;${id}\\\\007\\\\033]6;1;bg;red;brightness;${red}\\\\007\\\\033]6;1;bg;green;brightness;${green}\\\\007\\\\033]6;1;bg;blue;brightness;${blue}\\\\007\\\\033]1337;SetBadgeFormat=${badge}\\\\007' && clear" Enter`,
  );

  return true;
}

export function tmuxTarget(id: string): string {
  return `${DISPATCH_SESSION}:${id}`;
}

export function tmuxSendKeys(id: string, keys: string): void {
  execSync(`tmux send-keys -t "${tmuxTarget(id)}" ${keys}`);
}

export function tmuxSendText(id: string, text: string): void {
  execSync(`tmux send-keys -t "${tmuxTarget(id)}" "${text}" Enter`);
}

export function tmuxCapture(id: string, lines: number): string {
  return (
    execQuiet(
      `tmux capture-pane -t "${tmuxTarget(id)}" -p -S -${lines}`,
    ) || ""
  );
}

export function tmuxKillWindow(id: string): void {
  execQuiet(`tmux kill-window -t "${tmuxTarget(id)}"`);
}

export function tmuxListWindows(): string {
  return (
    execQuiet(
      `tmux list-windows -t "${DISPATCH_SESSION}" -F "#{window_name}|#{pane_current_command}|#{pane_current_path}|#{pane_dead}"`,
    ) || ""
  );
}

export function tmuxHasSession(): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", DISPATCH_SESSION], {
    stdio: "pipe",
  });
  return r.status === 0;
}

export function tmuxAttach(window?: string): void {
  const target = window ? `${DISPATCH_SESSION}:${window}` : DISPATCH_SESSION;
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
  // Get tab color for this agent window
  const agentName = target.includes(":") ? target.split(":").pop() : target;
  const windowsStr = execQuiet(
    `tmux list-windows -t "${DISPATCH_SESSION}" -F "#{window_name}"`,
  );
  const windows = windowsStr ? windowsStr.split("\n") : [];
  const idx = windows.indexOf(agentName || "");
  const hex = TAB_COLORS[Math.max(0, idx) % TAB_COLORS.length];
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);

  // Check which terminal is running, in preference order
  const terminals = [
    {
      name: "iTerm2",
      bundleId: "com.googlecode.iterm2",
      script: `tell application "iTerm2"
        activate
        tell current window
          create tab with default profile
          tell current session
            set name to "${agentName}"
            write text "printf '\\\\e]6;1;bg;red;brightness;${red}\\\\a\\\\e]6;1;bg;green;brightness;${green}\\\\a\\\\e]6;1;bg;blue;brightness;${blue}\\\\a'; TERM_PROGRAM=dumb tmux attach -t ${target}"
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
export function notify(title: string, message: string): void {
  execQuiet(
    `osascript -e 'display notification "${message}" with title "${title}" sound name "Glass"'`,
  );
}

// ---------------------------------------------------------------------------
// Claude readiness
// ---------------------------------------------------------------------------
export function waitForClaude(id: string, timeout: number): void {
  let waited = 0;
  while (waited < timeout) {
    const content = tmuxCapture(id, 5);
    if (/^\s*[>?]\s*$/m.test(content) || /╭|Welcome|claude/i.test(content)) {
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
