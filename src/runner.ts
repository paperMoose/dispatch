import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** A real session owned by an agent runtime rather than by tmux or cmux. */
export interface InvisibleSession {
  id: string;
  cwd: string;
  kind: "background";
  startedAt: number;
  sessionId: string;
  name: string;
  /** The runtime's own lifecycle verdict. This is stronger than process or
   * pane inference and must be preferred whenever the runtime supplies it. */
  state: string;
}

export interface InvisibleLaunchResult {
  ok: boolean;
  id: string;
  stdout: string;
  stderr: string;
}

/** Optional native-background fast path. It deliberately contains no pane or
 * transcript methods: invisible agents must work without a screen reader. */
export interface InvisibleRuntime {
  launch(command: string, cwd: string): InvisibleLaunchResult;
  list(): InvisibleSession[];
  attach(id: string): number | null;
  logs(id: string): { status: number | null; stdout: string; stderr: string };
  stop(id: string): { status: number | null; stdout: string; stderr: string };
}

/** Parse only native background sessions. `claude agents --json` also returns
 * interactive sessions, which still belong to the multiplexer path. */
export function parseClaudeAgents(output: string): InvisibleSession[] {
  let rows: unknown;
  try {
    rows = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const sessions: InvisibleSession[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.kind !== "background" || typeof r.id !== "string" || typeof r.cwd !== "string") {
      continue;
    }
    // Newer Claude builds expose both `status` (terminal activity) and
    // `state` (the agent lifecycle). The latter is the field dispatch wants.
    const state =
      typeof r.state === "string"
        ? r.state
        : typeof r.status === "string"
          ? r.status
          : "unknown";
    sessions.push({
      id: r.id,
      cwd: r.cwd,
      kind: "background",
      startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
      sessionId: typeof r.sessionId === "string" ? r.sessionId : "",
      name: typeof r.name === "string" ? r.name : "",
      state,
    });
  }
  return sessions;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Resolve a dispatch worktree to its runtime session. The saved native ID is
 * authoritative; cwd is the recovery path for older or interrupted launches. */
export function findInvisibleSession(
  sessions: InvisibleSession[],
  wtPath: string,
  nativeId = "",
): InvisibleSession | null {
  if (nativeId) {
    const exact = sessions.find((session) => session.id === nativeId);
    if (exact) return exact;
  }
  const cwd = canonicalPath(wtPath);
  return (
    sessions
      .filter((session) => canonicalPath(session.cwd) === cwd)
      .sort((a, b) => b.startedAt - a.startedAt)[0] || null
  );
}

/** Read `claude --bg`'s human launch receipt without depending on colour or
 * the surrounding help text. A cwd lookup remains the fallback at the caller. */
export function parseInvisibleLaunchId(output: string): string {
  return /\bbackgrounded\s*[·:]\s*([a-zA-Z0-9_-]+)/i.exec(output)?.[1] || "";
}

export function invisibleUnsupportedMessage(runtime: string): string {
  if (runtime === "codex") {
    return (
      "Codex does not support --invisible: its CLI has no stable native background " +
      "session mode (codex app-server is experimental). Use interactive mode or --headless."
    );
  }
  return `${runtime} does not support --invisible: it has no native background session mode.`;
}

let cachedClaudeSessions: { at: number; sessions: InvisibleSession[] } | null = null;

function listClaudeSessions(): InvisibleSession[] {
  const now = Date.now();
  if (cachedClaudeSessions && now - cachedClaudeSessions.at < 500) {
    return cachedClaudeSessions.sessions;
  }
  const result = spawnSync("claude", ["agents", "--json"], {
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 4 * 1024 * 1024,
  });
  const sessions = result.status === 0 ? parseClaudeAgents(result.stdout || "") : [];
  cachedClaudeSessions = { at: now, sessions };
  return sessions;
}

function runClaude(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Claude Code's stable native background-session surface. */
export const claudeInvisibleRuntime: InvisibleRuntime = {
  launch(command, cwd) {
    const result = spawnSync("/bin/sh", ["-lc", command], {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 4 * 1024 * 1024,
    });
    cachedClaudeSessions = null;
    const stdout = result.stdout || "";
    const stderr = result.stderr || result.error?.message || "";
    return {
      ok: result.status === 0,
      id: result.status === 0 ? parseInvisibleLaunchId(`${stdout}\n${stderr}`) : "",
      stdout,
      stderr,
    };
  },

  list: listClaudeSessions,

  attach(id) {
    return spawnSync("claude", ["attach", id], { stdio: "inherit" }).status;
  },

  logs(id) {
    const result = runClaude("claude", ["logs", id]);
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || result.error?.message || "",
    };
  },

  stop(id) {
    const result = runClaude("claude", ["stop", id]);
    cachedClaudeSessions = null;
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || result.error?.message || "",
    };
  },
};

/** The three launch flags are mutually exclusive. Kept pure so mode parsing
 * is covered without creating a worktree or starting an agent. */
export function runModeFromFlags(args: string[]): "interactive" | "headless" | "invisible" {
  const headless = args.some((arg) => arg === "--headless" || arg === "-H");
  const invisible = args.includes("--invisible");
  if (headless && invisible) {
    throw new Error("--headless and --invisible are different launch modes; choose one.");
  }
  return invisible ? "invisible" : headless ? "headless" : "interactive";
}
