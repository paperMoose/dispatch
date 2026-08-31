import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, relative, sep } from "path";

/** The agent directory, and do-not-disturb.
 *
 *  Two halves of one question: who can I reach, and what are they in the
 *  middle of? An agent reads this to decide whether to bother someone, so
 *  everything here is derived from state something else already maintains —
 *  the prompt file dispatch wrote at launch, the history event, the agent's
 *  own last message. Nothing in the directory has to be kept up to date by
 *  hand, because a field somebody has to remember to set is a field that is
 *  wrong by the second day.
 *
 *  The parts that touch a terminal live in commands.ts; what is here is file
 *  and string work, so it can be tested without a multiplexer. */

/** Do-not-disturb lives in the agent's own worktree, next to `.dispatch-agent`.
 *
 *  A file rather than a flag in a central table, for three reasons: the agent
 *  can set its own without knowing its id or racing another writer, it is
 *  removed with the worktree so a finished agent cannot leave a stale entry
 *  behind, and it survives `dispatch resume` — which rewrites `.dispatch-agent`
 *  and would therefore clear a flag stored there. */
export const DND_MARKER = ".dispatch-dnd";

export interface Dnd {
  since: string;
  reason: string;
}

export function readDnd(wtPath: string): Dnd | null {
  try {
    const raw = readFileSync(join(wtPath, DND_MARKER), "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { since: parsed.since || "", reason: parsed.reason || "" };
  } catch {
    // Missing is the common case. A corrupt marker reads as "not on
    // do-not-disturb": failing open keeps a bad file from silencing an agent
    // nobody can then reach.
    return null;
  }
}

export function setDnd(wtPath: string, reason: string): Dnd {
  const dnd: Dnd = { since: new Date().toISOString(), reason };
  writeFileSync(join(wtPath, DND_MARKER), JSON.stringify(dnd) + "\n", { mode: 0o600 });
  return dnd;
}

/** Returns whether it was on before. */
export function clearDnd(wtPath: string): boolean {
  const was = readDnd(wtPath) !== null;
  try {
    unlinkSync(join(wtPath, DND_MARKER));
  } catch {
    // Already gone.
  }
  return was;
}

/** The agent whose worktree this path is inside, or "".
 *
 *  How `dispatch dnd on` and `dispatch thread post` work with no id typed: an
 *  agent runs them from its own worktree and dispatch works out who it is.
 *  Asking an agent to pass its own id invites it to pass the wrong one, and a
 *  post attributed to the wrong sender is delivered back to the real one. */
export function agentIdFromPath(
  cwd: string,
  root: string,
  worktreeDir: string,
): string {
  const rel = relative(join(root, worktreeDir), cwd);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return "";
  return rel.split(sep)[0] || "";
}

export type WorkSource = "prompt" | "history" | "last-message" | "unknown";

const WORK_WIDTH = 140;

/** What an agent is working on, in one line.
 *
 *  In order of how well each source answers "should I interrupt this one":
 *  the brief it was launched with says what it is for, the history event says
 *  the same for an agent whose worktree is gone, and its last message says
 *  what it is doing right now — which is the only thing left when a worktree
 *  was reused or the prompt was typed straight into the pane. */
export function describeWork(sources: {
  prompt?: string;
  history?: string;
  lastText?: string;
}): { text: string; source: WorkSource } {
  const candidates: [WorkSource, string | undefined][] = [
    ["prompt", sources.prompt],
    ["history", sources.history],
    ["last-message", sources.lastText],
  ];
  for (const [source, raw] of candidates) {
    const text = firstLine(raw);
    if (text) return { text, source };
  }
  return { text: "", source: "unknown" };
}

function firstLine(raw: string | undefined): string {
  if (!raw) return "";
  for (const line of raw.split("\n")) {
    // Markdown headings and list bullets carry no information here and eat
    // into the width, and a dispatch brief routinely opens with one.
    const clean = line.replace(/^\s*(#+|[-*>]+)\s*/, "").trim();
    if (!clean) continue;
    return clean.length > WORK_WIDTH ? clean.slice(0, WORK_WIDTH - 1) + "…" : clean;
  }
  return "";
}

export interface DirectoryEntry {
  id: string;
  branch: string;
  /** running: the agent CLI has live children. idle: the window is there and
   *  nothing is running in it. exited: the pane's process is gone. */
  status: "running" | "idle" | "exited";
  /** Whether a thread post or `dispatch send` would actually land in its pane.
   *  Computed by the same code that delivers, so the directory cannot promise
   *  a delivery that then does not happen. */
  reachable: boolean;
  /** Why not, in the words the sender is shown. */
  unreachable?: string;
  dnd: boolean;
  dndReason?: string;
  working: string;
  workingFrom: WorkSource;
  /** Threads this agent is a member of. */
  threads: string[];
  /** Posts addressed to it that no pane write has carried. */
  waiting: number;
}

export function directoryJson(entries: DirectoryEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** The directory as an agent reads it: one entry per agent, every field on a
 *  labelled line. Not a table — a table wraps in a pane and the columns stop
 *  lining up the moment an id is long, which is most of them. */
export function formatDirectory(
  entries: DirectoryEntry[],
  fmt: { BOLD: string; DIM: string; GREEN: string; YELLOW: string; RED: string; NC: string },
): string {
  if (!entries.length) {
    return "No agents are running. Launch one with: dispatch run <ticket|prompt>";
  }
  const out: string[] = [];
  for (const e of entries) {
    const dot =
      e.status === "running"
        ? `${fmt.GREEN}●${fmt.NC}`
        : e.status === "idle"
          ? `${fmt.YELLOW}●${fmt.NC}`
          : `${fmt.RED}●${fmt.NC}`;
    out.push(`${dot} ${fmt.BOLD}${e.id}${fmt.NC}  ${fmt.DIM}${e.branch}${fmt.NC}`);
    out.push(
      `    reach:   ${e.reachable ? "yes" : `no — ${e.unreachable || "unknown"}`}`,
    );
    if (e.working) {
      out.push(`    working: ${e.working} ${fmt.DIM}(${e.workingFrom})${fmt.NC}`);
    }
    if (e.threads.length) {
      out.push(
        `    threads: ${e.threads.join(", ")}${e.waiting ? `  ${fmt.DIM}(${e.waiting} unseen)${fmt.NC}` : ""}`,
      );
    }
  }
  out.push("");
  out.push(
    `${fmt.DIM}Start a conversation: dispatch thread new <id> <id> --topic "..."${fmt.NC}`,
  );
  return out.join("\n");
}
