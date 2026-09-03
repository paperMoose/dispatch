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

/** An agent's own declaration that it has finished.
 *
 *  Everything else dispatch knows about "done" is inferred — a quiet pane, no
 *  child processes, a branch that stopped moving — and every one of those is
 *  also what a long test run looks like. Inference cannot tell "finished and
 *  reported" from "thinking hard", which is why an orchestrator watching seven
 *  agents could not say which were waiting on it.
 *
 *  So the agent says so. A file in its own worktree, for the same reasons
 *  do-not-disturb is one: it needs no id, races nothing, and goes away with
 *  the worktree. The history event is the audit trail; this is the fast read,
 *  and it survives history being trimmed at 500 entries. */
export const DONE_MARKER = ".dispatch-done";

export interface Done {
  at: string;
  summary: string;
  pr: string;
  /** What the agent left for a person: the sentence an orchestrator most
   *  needs and can least reconstruct from a diff. */
  handoff: string;
}

export function readDone(wtPath: string): Done | null {
  try {
    const raw = readFileSync(join(wtPath, DONE_MARKER), "utf-8").trim();
    if (!raw) return null;
    const p = JSON.parse(raw);
    return {
      at: p.at || "",
      summary: p.summary || "",
      pr: p.pr || "",
      handoff: p.handoff || "",
    };
  } catch {
    return null;
  }
}

export function setDone(wtPath: string, d: Omit<Done, "at">): Done {
  const done: Done = { at: new Date().toISOString(), ...d };
  writeFileSync(join(wtPath, DONE_MARKER), JSON.stringify(done) + "\n", { mode: 0o600 });
  return done;
}

/** Cleared on resume: an agent picked back up is working again, and a stale
 *  declaration would tell the orchestrator to stop watching it. */
export function clearDone(wtPath: string): boolean {
  const was = readDone(wtPath) !== null;
  try {
    unlinkSync(join(wtPath, DONE_MARKER));
  } catch {
    // Already gone.
  }
  return was;
}

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
  /** What the agent is doing, with `done` coming from its own declaration
   *  rather than from guessing at a quiet pane. `working` and `idle` remain
   *  inferred and remain unreliable — that is exactly why `done` is not. */
  state: "done" | "working" | "idle" | "exited";
  /** What the agent's own transcript says it is doing, and how stale that
   *  reading is. Carried separately from `state` so a reader can see the
   *  evidence rather than only the verdict — the verdict is what was wrong all
   *  the previous times. */
  turn?: { state: string; idleSeconds: number; evidence: string };
  /** Set when state is "done". */
  done?: { at: string; summary: string; pr: string; handoff: string };
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

function fmtAge(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

export function directoryJson(entries: DirectoryEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** The directory as an agent reads it: one entry per agent, every field on a
 *  labelled line. Not a table — a table wraps in a pane and the columns stop
 *  lining up the moment an id is long, which is most of them. */
export function formatDirectory(
  entries: DirectoryEntry[],
  fmt: { BOLD: string; DIM: string; GREEN: string; YELLOW: string; RED: string; BLUE: string; NC: string },
): string {
  if (!entries.length) {
    return "No agents are running. Launch one with: dispatch run <ticket|prompt>";
  }
  const out: string[] = [];
  for (const e of entries) {
    // Done is its own mark, because "has this one finished" is the question an
    // orchestrator asks most and the one it could previously only guess at.
    const dot =
      e.state === "done"
        ? `${fmt.BLUE}✓${fmt.NC}`
        : e.state === "working"
          ? `${fmt.GREEN}●${fmt.NC}`
          : e.state === "idle"
            ? `${fmt.YELLOW}●${fmt.NC}`
            : `${fmt.RED}●${fmt.NC}`;
    out.push(
      `${dot} ${fmt.BOLD}${e.id}${fmt.NC}  ${fmt.DIM}${e.branch}${fmt.NC}` +
        (e.state === "done" ? `  ${fmt.BLUE}done${fmt.NC}` : ""),
    );
    if (e.done) {
      if (e.done.summary) out.push(`    did:     ${e.done.summary.split("\n")[0]}`);
      if (e.done.handoff) out.push(`    left:    ${e.done.handoff.split("\n")[0]}`);
      if (e.done.pr) out.push(`    pr:      ${e.done.pr}`);
    }
    out.push(
      `    reach:   ${e.reachable ? "yes" : `no — ${e.unreachable || "unknown"}`}`,
    );
    if (e.working) {
      out.push(`    working: ${e.working} ${fmt.DIM}(${e.workingFrom})${fmt.NC}`);
    }
    if (e.turn && e.turn.state === "never-started") {
      out.push(`    ${fmt.RED}never started${fmt.NC} — it has not been given a prompt`);
    } else if (e.turn && e.turn.state !== "unknown") {
      const stale = e.turn.idleSeconds >= 0 ? `, quiet ${fmtAge(e.turn.idleSeconds)}` : "";
      out.push(`    turn:    ${e.turn.state}${stale}  ${fmt.DIM}(${e.turn.evidence})${fmt.NC}`);
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


/** Whether a pull request line means the work is over.
 *
 *  `list` fetches this string already (`"#8792 MERGED"`) and printed it beside
 *  agents it was simultaneously filing under "Running Agents". Measured on one
 *  repository before this existed: 18 agents had merged pull requests and only
 *  10 were marked done, so a dozen finished agents looked busy. "Running" was
 *  describing the terminal, not the work.
 *
 *  MERGED only. A CLOSED pull request means abandoned or superseded, which is
 *  not the same as finished and should not be reported as success. */
export function prMeansFinished(pr: string | undefined | null): boolean {
  return !!pr && /\bMERGED\b/.test(pr);
}
