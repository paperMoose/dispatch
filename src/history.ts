import { existsSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { gitRoot } from "./shell.js";

const HISTORY_FILE = ".dispatch-history.jsonl";

export interface HistoryEvent {
  id: string;
  event: "launched" | "completed" | "stopped" | "cleaned";
  ts: string;
  prompt?: string;
  branch?: string;
  mode?: string;
  summary?: string;
  pr?: string;
}

function historyPath(): string {
  return join(gitRoot(), HISTORY_FILE);
}

let _writeCount = 0;

export function recordEvent(event: HistoryEvent): void {
  try {
    const path = historyPath();
    appendFileSync(path, JSON.stringify(event) + "\n");
    // Trim periodically (every 50 writes) to prevent unbounded growth
    if (++_writeCount % 50 === 0) trimHistory();
  } catch {}
}

export function readHistory(): HistoryEvent[] {
  try {
    const path = historyPath();
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as HistoryEvent[];
  } catch {
    return [];
  }
}

export interface AgentSummary {
  id: string;
  branch?: string;
  prompt?: string;
  mode?: string;
  launchedAt?: string;
  completedAt?: string;
  stoppedAt?: string;
  cleanedAt?: string;
  summary?: string;
  pr?: string;
  status: "launched" | "completed" | "stopped" | "cleaned";
}

/** Aggregate history events into per-agent summaries, most recent first. */
export function getAgentSummaries(): AgentSummary[] {
  const events = readHistory();
  const agents = new Map<string, AgentSummary>();

  for (const e of events) {
    let agent = agents.get(e.id);
    if (!agent) {
      agent = { id: e.id, status: e.event };
      agents.set(e.id, agent);
    }

    agent.status = e.event;
    if (e.branch) agent.branch = e.branch;
    if (e.prompt) agent.prompt = e.prompt;
    if (e.mode) agent.mode = e.mode;
    if (e.summary) agent.summary = e.summary;
    if (e.pr) agent.pr = e.pr;

    switch (e.event) {
      case "launched":
        agent.launchedAt = e.ts;
        // Reset downstream state for re-launches
        agent.completedAt = undefined;
        agent.stoppedAt = undefined;
        agent.cleanedAt = undefined;
        agent.summary = undefined;
        agent.pr = undefined;
        break;
      case "completed":
        agent.completedAt = e.ts;
        break;
      case "stopped":
        agent.stoppedAt = e.ts;
        break;
      case "cleaned":
        agent.cleanedAt = e.ts;
        break;
    }
  }

  // Sort by most recent activity
  return Array.from(agents.values()).sort((a, b) => {
    const aTime = a.cleanedAt || a.completedAt || a.stoppedAt || a.launchedAt || "";
    const bTime = b.cleanedAt || b.completedAt || b.stoppedAt || b.launchedAt || "";
    return bTime.localeCompare(aTime);
  });
}

/** Get recent completions (last N hours, default 24). */
export function getRecentCompletions(hours = 24): AgentSummary[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return getAgentSummaries().filter(
    (a) =>
      (a.status === "completed" || a.status === "cleaned") &&
      (a.completedAt || a.cleanedAt || "") > cutoff,
  );
}

/** Trim history to last N entries to prevent unbounded growth. */
export function trimHistory(maxEntries = 500): void {
  try {
    const path = historyPath();
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length <= maxEntries) return;
    writeFileSync(path, lines.slice(-maxEntries).join("\n") + "\n");
  } catch {}
}
