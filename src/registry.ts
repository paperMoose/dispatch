import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/** Every agent this machine has launched, and where its worktree is.
 *
 *  Without this, dispatch can only see agents in the repository you happen to
 *  be standing in: `dispatch directory` run from one repo reported nothing
 *  about agents in another, and an orchestrator concluded its own agent had
 *  not reported itself finished when in fact the declaration was sitting in a
 *  repo the command never looked at.
 *
 *  A swarm that spans repositories is exactly when coordination matters most,
 *  because that is when no single checkout has the whole picture. Agents are a
 *  machine-level thing regardless — a multiplexer session is not scoped to a
 *  repository — so the registry is too.
 *
 *  Append-only, one JSON record per line, same as the thread buffers and for
 *  the same reason: two launches at once both land. */

const REGISTRY = join(homedir(), ".dispatch", "agents.jsonl");

export interface AgentRecord {
  id: string;
  /** Absolute path, which is the whole point: it is meaningful from anywhere. */
  worktree: string;
  /** Repo root, so the directory can group and so `gh` runs in the right place. */
  repo: string;
  branch: string;
  launched: string;
}

export function registryPath(): string {
  return REGISTRY;
}

export function recordAgent(rec: AgentRecord): void {
  try {
    mkdirSync(dirname(REGISTRY), { recursive: true });
    appendFileSync(REGISTRY, JSON.stringify(rec) + "\n");
  } catch {
    // Non-fatal. The registry improves discovery; losing a write costs
    // visibility from other repos, never the agent itself.
  }
}

/** Every agent on record, most recent launch per id.
 *
 *  A worktree that no longer exists is dropped: an id gets reused across runs,
 *  and a cleaned-up agent should not linger in a listing forever. */
export function readRegistry(): AgentRecord[] {
  if (!existsSync(REGISTRY)) return [];
  const byId = new Map<string, AgentRecord>();
  try {
    for (const line of readFileSync(REGISTRY, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as AgentRecord;
        if (rec.id && rec.worktree) byId.set(rec.id, rec);
      } catch {
        // One torn line must not hide the rest, same as the thread buffers.
      }
    }
  } catch {
    return [];
  }
  return [...byId.values()].filter((r) => existsSync(r.worktree));
}

/** Drop records whose worktree is gone, so the file does not grow forever.
 *  Rewrites in place; callers do this occasionally, never on a read path. */
export function pruneRegistry(): void {
  try {
    const live = readRegistry();
    if (!live.length) return;
    writeFileSync(REGISTRY, live.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {
    // Non-fatal.
  }
}
