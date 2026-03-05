import { spawnSync } from "child_process";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// cmux CLI path detection
// ---------------------------------------------------------------------------
const CMUX_CLI_PATHS = [
  "/Applications/cmux NIGHTLY.app/Contents/Resources/bin/cmux",
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
];

let _cmuxPath: string | null | undefined;

function cmuxCliPath(): string | null {
  if (_cmuxPath !== undefined) return _cmuxPath;
  // Check PATH first
  const r = spawnSync("which", ["cmux"], { stdio: "pipe" });
  if (r.status === 0) {
    _cmuxPath = r.stdout.toString().trim();
    return _cmuxPath;
  }
  // Check known app bundle locations
  for (const p of CMUX_CLI_PATHS) {
    if (existsSync(p)) {
      _cmuxPath = p;
      return _cmuxPath;
    }
  }
  _cmuxPath = null;
  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Returns true if cmux is available as a multiplexer backend. */
export function isCmuxAvailable(): boolean {
  // cmux restricts socket access to processes started inside cmux.
  // CMUX_WORKSPACE_ID is set in cmux terminals — if it's present, we're inside cmux.
  if (!process.env.CMUX_WORKSPACE_ID && !process.env.CMUX_SOCKET_PATH) {
    return false;
  }
  return cmuxCliPath() !== null && cmuxSocketResponds();
}

/** Check that cmux socket actually accepts our connection. */
function cmuxSocketResponds(): boolean {
  const cli = cmuxCliPath();
  if (!cli) return false;
  const r = spawnSync(cli, ["ping"], { stdio: "pipe", timeout: 3000 });
  // ping succeeds with exit 0, or fails with SIGPIPE/access denied
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------
function cmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const cli = cmuxCliPath();
  if (!cli) {
    return { ok: false, stdout: "", stderr: "cmux CLI not found" };
  }

  // cmux nightly uses a different socket path — respect CMUX_SOCKET_PATH or detect
  const socketPath = process.env.CMUX_SOCKET_PATH;
  const fullArgs = socketPath ? ["--socket", socketPath, ...args] : args;

  const r = spawnSync(cli, fullArgs, {
    stdio: "pipe",
    timeout: 10_000,
  });

  return {
    ok: r.status === 0,
    stdout: r.stdout?.toString().trim() || "",
    stderr: r.stderr?.toString().trim() || "",
  };
}

// ---------------------------------------------------------------------------
// Workspace management
// ---------------------------------------------------------------------------

/** Create a new cmux workspace. Returns the workspace ID/ref, or null on failure. */
export function cmuxNewWorkspace(command?: string): string | null {
  const args = ["new-workspace"];
  if (command) args.push("--command", command);
  const r = cmux(args);
  if (!r.ok) {
    // Log stderr for debugging
    if (r.stderr) console.error(`cmux new-workspace error: ${r.stderr}`);
    return null;
  }
  // Output is typically "workspace:N" or JSON
  const out = r.stdout;
  try {
    const data = JSON.parse(out);
    return data.workspace_id || data.id || out;
  } catch {
    // Parse "workspace:N" ref from output
    const match = out.match(/workspace:\d+/);
    return match ? match[0] : out || null;
  }
}

/** Rename a cmux workspace. */
export function cmuxRenameWorkspace(workspaceId: string, title: string): boolean {
  const r = cmux(["rename-workspace", "--workspace", workspaceId, title]);
  return r.ok;
}

/** Close a cmux workspace. */
export function cmuxCloseWorkspace(workspaceId: string): boolean {
  const r = cmux(["close-workspace", "--workspace", workspaceId]);
  return r.ok;
}

/** Try to close a cmux workspace by reading the marker file from a worktree path.
 *  Works even when called from outside cmux (e.g., MCP server, cleanup commands).
 *  Returns true if successfully closed, false if no marker or CLI unavailable. */
export function tryCmuxCloseFromMarker(wtPath: string): boolean {
  const wsId = loadCmuxWorkspaceId(wtPath);
  if (!wsId) return false;
  const cli = cmuxCliPath();
  if (!cli) return false;
  // Try closing directly — don't require isCmuxAvailable()
  const r = cmux(["close-workspace", "--workspace", wsId]);
  return r.ok;
}

/** List all cmux workspaces. Returns raw text output. */
export function cmuxListWorkspaces(): string {
  const r = cmux(["list-workspaces"]);
  return r.stdout;
}

/** Parse cmux list-workspaces output into structured data.
 *  Format: "  workspace:3  ⠂ Claude Code" or "* workspace:2  ⠂ Title  [selected]" */
export function parseCmuxWorkspaces(): { ref: string; title: string; selected: boolean }[] {
  const raw = cmuxListWorkspaces();
  if (!raw) return [];
  return raw.split("\n").filter(l => l.trim()).map(line => {
    const selected = line.startsWith("*");
    const refMatch = line.match(/workspace:\d+/);
    const ref = refMatch ? refMatch[0] : "";
    // Title is after the ⠂ separator
    const titleMatch = line.match(/⠂\s*(.+?)(?:\s+\[selected\])?\s*$/);
    const title = titleMatch ? titleMatch[1].trim() : "";
    return { ref, title, selected };
  });
}

/** Select (focus) a workspace. */
export function cmuxSelectWorkspace(workspaceId: string): boolean {
  const r = cmux(["select-workspace", "--workspace", workspaceId]);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Terminal I/O
// ---------------------------------------------------------------------------

/** Send text to a workspace's terminal (with Enter). */
export function cmuxSend(workspaceId: string, text: string): boolean {
  const r = cmux(["send", "--workspace", workspaceId, text + "\n"]);
  return r.ok;
}

/** Send a key combo (e.g. "ctrl-c"). */
export function cmuxSendKey(workspaceId: string, key: string): boolean {
  const r = cmux(["send-key", "--workspace", workspaceId, key]);
  return r.ok;
}

/** Read the terminal screen content. */
export function cmuxReadScreen(
  workspaceId: string,
  lines?: number,
  scrollback?: boolean,
): string {
  const args = ["read-screen", "--workspace", workspaceId];
  if (scrollback) args.push("--scrollback");
  if (lines) args.push("--lines", String(lines));
  const r = cmux(args);
  return r.stdout;
}

/** Paste text via buffer (for large prompts). */
export function cmuxPasteBuffer(workspaceId: string, text: string): boolean {
  const bufName = `dispatch-${workspaceId.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const setBuf = cmux(["set-buffer", "--name", bufName, text]);
  if (!setBuf.ok) return false;
  const paste = cmux(["paste-buffer", "--name", bufName, "--workspace", workspaceId]);
  return paste.ok;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/** Open a browser split in a workspace, showing the given URL. */
export function cmuxOpenBrowser(workspaceId: string, url: string): boolean {
  const r = cmux(["browser", "open", url, "--surface", workspaceId]);
  // Fallback: try new-pane with browser type
  if (!r.ok) {
    const r2 = cmux(["new-pane", "--type", "browser", "--workspace", workspaceId, "--url", url]);
    return r2.ok;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Notifications & sidebar metadata
// ---------------------------------------------------------------------------

/** Send a cmux notification (lights up the tab with a blue ring). */
export function cmuxNotify(
  title: string,
  opts?: { subtitle?: string; body?: string; workspaceId?: string },
): boolean {
  const args = ["notify", "--title", title];
  if (opts?.subtitle) args.push("--subtitle", opts.subtitle);
  if (opts?.body) args.push("--body", opts.body);
  if (opts?.workspaceId) args.push("--workspace", opts.workspaceId);
  const r = cmux(args);
  return r.ok;
}

/** Set a status key in the workspace sidebar. */
export function cmuxSetStatus(
  workspaceId: string,
  key: string,
  value: string,
  opts?: { icon?: string; color?: string },
): boolean {
  const args = ["set-status", key, value, "--workspace", workspaceId];
  if (opts?.icon) args.push("--icon", opts.icon);
  if (opts?.color) args.push("--color", opts.color);
  const r = cmux(args);
  return r.ok;
}

/** Clear a status key from the workspace sidebar. */
export function cmuxClearStatus(workspaceId: string, key: string): boolean {
  const r = cmux(["clear-status", key, "--workspace", workspaceId]);
  return r.ok;
}

/** Set a progress bar on the workspace. */
export function cmuxSetProgress(
  workspaceId: string,
  value: number,
  label?: string,
): boolean {
  const args = ["set-progress", String(Math.min(1, Math.max(0, value))), "--workspace", workspaceId];
  if (label) args.push("--label", label);
  const r = cmux(args);
  return r.ok;
}

/** Clear progress bar from the workspace. */
export function cmuxClearProgress(workspaceId: string): boolean {
  const r = cmux(["clear-progress", "--workspace", workspaceId]);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Workspace color coding
// ---------------------------------------------------------------------------
const WORKSPACE_STATES: Record<string, { color: string; icon: string; notify: boolean }> = {
  starting:  { color: "#2E86AB", icon: "hourglass",          notify: false },
  running:   { color: "#44BBA4", icon: "bolt.fill",          notify: false },
  waiting:   { color: "#F18F01", icon: "exclamationmark.bubble.fill", notify: true },
  done:      { color: "#6C757D", icon: "checkmark.circle.fill",      notify: true },
  error:     { color: "#E94F37", icon: "xmark.octagon.fill",         notify: true },
  merged:    { color: "#A23B72", icon: "arrow.triangle.merge",       notify: true },
};

export type AgentState = keyof typeof WORKSPACE_STATES;

/** Set workspace state: status color + icon in sidebar, notify if attention needed. */
export function cmuxSetWorkspaceColor(workspaceId: string, state: AgentState): boolean {
  const s = WORKSPACE_STATES[state];
  if (!s) return false;
  const ok = cmuxSetStatus(workspaceId, "dispatch", state, { color: s.color, icon: s.icon });
  if (s.notify) {
    cmuxNotify(`dispatch: ${state}`, { workspaceId });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Sidebar log
// ---------------------------------------------------------------------------

/** Write a log entry to the workspace's sidebar log panel. */
export function cmuxLog(workspaceId: string, message: string, level?: string): boolean {
  const args = ["log", "--workspace", workspaceId, "--source", "dispatch"];
  if (level) args.push("--level", level);
  args.push("--", message);
  const r = cmux(args);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Markdown viewer
// ---------------------------------------------------------------------------

/** Open a markdown file in a cmux markdown panel (live-reloading). */
export function cmuxOpenMarkdown(workspaceId: string, filePath: string): boolean {
  const r = cmux(["markdown", "open", filePath, "--workspace", workspaceId]);
  return r.ok;
}

// ---------------------------------------------------------------------------
// Workspace ID tracking
// ---------------------------------------------------------------------------
// We store cmux workspace IDs in the worktree so we can map agent ID → workspace.

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CMUX_ID_FILE = ".dispatch-cmux-workspace";

export function saveCmuxWorkspaceId(wtPath: string, workspaceId: string): void {
  writeFileSync(join(wtPath, CMUX_ID_FILE), workspaceId);
}

export function loadCmuxWorkspaceId(wtPath: string): string | null {
  const file = join(wtPath, CMUX_ID_FILE);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8").trim();
}
