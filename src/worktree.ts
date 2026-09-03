import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { Config } from "./config.js";
import {
  agentProcessAlive,
  fmt,
  gitRoot,
  log,
  sessionExists,
} from "./shell.js";

export const DEFAULT_KEEP_DAYS = 7;

/** The only signals that decide whether a linked worktree is in use.
 *
 * `dirty` is accepted so callers and tests can make the non-signal explicit:
 * uncommitted changes are rescued before removal, never used as liveness.
 */
export interface WorktreeSignals {
  sessionExists: boolean;
  agentProcessAlive: boolean;
  locked: boolean;
  recentlyModified: boolean;
  inspectionFailed?: boolean;
  dirty?: boolean;
}

export type WorktreeDecision =
  | { action: "keep"; reason: string }
  | { action: "collect"; reason: string };

/** Decide without touching git or the filesystem, so every safety branch can
 * be tested with fabricated signals. */
export function decideWorktreeCollection(
  signals: WorktreeSignals,
): WorktreeDecision {
  if (signals.sessionExists) {
    return { action: "keep", reason: "live session" };
  }
  if (signals.agentProcessAlive) {
    return { action: "keep", reason: "live process" };
  }
  if (signals.locked) {
    return { action: "keep", reason: "locked by git" };
  }
  if (signals.inspectionFailed) {
    return {
      action: "keep",
      reason: "could not inspect modification times",
    };
  }
  if (signals.recentlyModified) {
    return { action: "keep", reason: "modified within keep window" };
  }
  return { action: "collect", reason: "inactive beyond keep window" };
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr:
      (result.stderr || "").trim() ||
      result.error?.message ||
      `git ${args[0] || "command"} failed`,
  };
}

export interface LinkedWorktree {
  id: string;
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
}

interface PorcelainWorktree {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
}

function parseWorktreePorcelain(output: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice("worktree ".length),
        head: "",
        branch: null,
        locked: false,
      };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/** List only dispatch-managed linked worktrees. A worktree elsewhere on the
 * machine is not ours to collect merely because git knows about it. */
export function listDispatchWorktrees(
  root: string,
  worktreeDir: string,
): LinkedWorktree[] {
  const result = runGit(root, ["worktree", "list", "--porcelain"]);
  if (!result.ok) {
    throw new Error(`Could not list git worktrees: ${result.stderr}`);
  }

  const managedRoot = resolve(root, worktreeDir);
  const linked: LinkedWorktree[] = [];
  for (const worktree of parseWorktreePorcelain(result.stdout)) {
    const path = resolve(worktree.path);
    const id = relative(managedRoot, path);
    if (
      !id ||
      id === ".." ||
      id.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(id) ||
      !existsSync(path)
    ) {
      continue;
    }
    linked.push({ ...worktree, id, path });
  }
  return linked;
}

interface ModificationScan {
  recentlyModified: boolean;
  inspectionFailed: boolean;
  newestMtimeMs: number | null;
}

/** Scan mtimes without following symlinks. A read error keeps the worktree:
 * inability to prove it old is not permission to delete it. */
export function scanModifications(
  worktreePath: string,
  cutoffMs: number,
): ModificationScan {
  const pending = [worktreePath];
  let newestMtimeMs: number | null = null;

  try {
    while (pending.length > 0) {
      const path = pending.pop()!;
      const stat = lstatSync(path);
      newestMtimeMs = Math.max(newestMtimeMs ?? 0, stat.mtimeMs);
      if (stat.mtimeMs >= cutoffMs) {
        return {
          recentlyModified: true,
          inspectionFailed: false,
          newestMtimeMs,
        };
      }
      if (!stat.isDirectory()) continue;
      for (const entry of readdirSync(path)) {
        pending.push(join(path, entry));
      }
    }
  } catch {
    return {
      recentlyModified: false,
      inspectionFailed: true,
      newestMtimeMs,
    };
  }

  return {
    recentlyModified: false,
    inspectionFailed: false,
    newestMtimeMs,
  };
}

export interface InspectedWorktree extends LinkedWorktree {
  decision: WorktreeDecision;
  newestMtimeMs: number | null;
}

function inspectWorktree(
  worktree: LinkedWorktree,
  olderThanDays: number,
  nowMs: number,
): InspectedWorktree {
  const hasSession = sessionExists(worktree.id);
  if (hasSession) {
    return {
      ...worktree,
      decision: decideWorktreeCollection({
        sessionExists: true,
        agentProcessAlive: false,
        locked: worktree.locked,
        recentlyModified: false,
      }),
      newestMtimeMs: null,
    };
  }

  const hasAgentProcess =
    agentProcessAlive(worktree.path, "claude", worktree.id) ||
    agentProcessAlive(worktree.path, "codex", worktree.id);
  if (hasAgentProcess || worktree.locked) {
    return {
      ...worktree,
      decision: decideWorktreeCollection({
        sessionExists: false,
        agentProcessAlive: hasAgentProcess,
        locked: worktree.locked,
        recentlyModified: false,
      }),
      newestMtimeMs: null,
    };
  }

  const cutoffMs = nowMs - olderThanDays * 24 * 60 * 60 * 1000;
  const modifications = scanModifications(worktree.path, cutoffMs);
  const signals: WorktreeSignals = {
    sessionExists: false,
    agentProcessAlive: false,
    locked: false,
    recentlyModified: modifications.recentlyModified,
    inspectionFailed: modifications.inspectionFailed,
  };
  return {
    ...worktree,
    decision: decideWorktreeCollection(signals),
    newestMtimeMs: modifications.newestMtimeMs,
  };
}

function reinspectWorktree(
  root: string,
  worktreeDir: string,
  previous: LinkedWorktree,
  olderThanDays: number,
): InspectedWorktree | null {
  const current = listDispatchWorktrees(root, worktreeDir).find(
    (worktree) => worktree.path === previous.path,
  );
  return current
    ? inspectWorktree(current, olderThanDays, Date.now())
    : null;
}

function rescueRef(id: string): string {
  return `refs/dispatch-rescue/${id}`;
}

export interface RescueResult {
  ref: string;
  sha: string | null;
}

/** Capture tracked, untracked, staged, and unstaged changes without touching
 * the repository-wide stash stack. `git add -A` is what brings untracked files
 * into the stash-shaped commit made by `git stash create`. */
export function rescueWorktree(worktree: LinkedWorktree): RescueResult {
  const ref = rescueRef(worktree.id);
  const validRef = runGit(worktree.path, ["check-ref-format", ref]);
  if (!validRef.ok) {
    throw new Error(`Cannot rescue ${worktree.id}: invalid rescue ref ${ref}`);
  }

  const add = runGit(worktree.path, ["add", "-A"]);
  if (!add.ok) {
    throw new Error(`Cannot rescue ${worktree.id}: ${add.stderr}`);
  }

  const create = runGit(worktree.path, [
    "stash",
    "create",
    `dispatch rescue ${worktree.id}`,
  ]);
  if (!create.ok) {
    throw new Error(`Cannot rescue ${worktree.id}: ${create.stderr}`);
  }

  const sha = create.stdout.trim() || null;
  if (!sha) return { ref, sha: null };
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`Cannot rescue ${worktree.id}: git returned an invalid object id`);
  }

  const update = runGit(worktree.path, [
    "update-ref",
    "-m",
    `dispatch rescue ${worktree.id}`,
    ref,
    sha,
  ]);
  if (!update.ok) {
    throw new Error(`Cannot preserve rescue for ${worktree.id}: ${update.stderr}`);
  }
  return { ref, sha };
}

/** Remove the linked checkout only. The branch is deliberately left alone. */
export function removeCollectedWorktree(
  root: string,
  worktree: LinkedWorktree,
): void {
  const remove = runGit(root, [
    "worktree",
    "remove",
    "--force",
    worktree.path,
  ]);
  if (!remove.ok) {
    throw new Error(`Could not remove ${worktree.id}: ${remove.stderr}`);
  }
}

export interface RescueRef {
  id: string;
  ref: string;
  sha: string;
  created: string;
}

export function listRescueRefs(root: string): RescueRef[] {
  const result = runGit(root, [
    "for-each-ref",
    "--format=%(refname:strip=2)%09%(objectname)%09%(creatordate:iso8601)",
    "refs/dispatch-rescue/",
  ]);
  if (!result.ok) {
    throw new Error(`Could not list rescue refs: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, sha, created = ""] = line.split("\t");
      return { id, ref: rescueRef(id), sha, created };
    });
}

export interface GcOptions {
  apply: boolean;
  olderThanDays: number;
  rescued: boolean;
}

function parseOlderThan(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("--older-than requires a number of days");
  }
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error("--older-than must be a non-negative number of days");
  }
  return days;
}

export function parseGcOptions(args: string[]): GcOptions {
  let apply = false;
  let rescued = false;
  let olderThanDays = DEFAULT_KEEP_DAYS;
  let olderThanSet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--rescued") {
      rescued = true;
    } else if (arg === "--older-than") {
      const raw = args[++i];
      olderThanSet = true;
      olderThanDays = parseOlderThan(raw);
    } else if (arg.startsWith("--older-than=")) {
      olderThanSet = true;
      olderThanDays = parseOlderThan(arg.slice("--older-than=".length));
    } else {
      throw new Error(`Unknown gc option: ${arg}`);
    }
  }

  if (rescued && (apply || olderThanSet)) {
    throw new Error("--rescued cannot be combined with collection options");
  }
  return { apply, olderThanDays, rescued };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function showRescues(root: string, config: Config): void {
  const rescues = listRescueRefs(root);
  if (rescues.length === 0) {
    log.info("No rescued worktrees");
    return;
  }

  console.log(`${fmt.BOLD}Rescued worktrees${fmt.NC}`);
  console.log(`${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`);
  for (const rescue of rescues) {
    const path = resolve(root, config.worktreeDir, rescue.id);
    const branchRef = `refs/heads/${rescue.id}`;
    const hasBranch = runGit(root, [
      "show-ref",
      "--verify",
      "--quiet",
      branchRef,
    ]).ok;
    console.log(`  ${fmt.BLUE}●${fmt.NC} ${rescue.id}  ${fmt.DIM}${rescue.sha.slice(0, 12)}${fmt.NC}`);
    if (rescue.created) console.log(`    ${rescue.created}`);
    if (hasBranch) {
      console.log(
        `    git worktree add ${shellQuote(path)} ${shellQuote(rescue.id)}`,
      );
    } else {
      console.log(
        `    git worktree add --detach ${shellQuote(path)} ${shellQuote(`${rescue.ref}^1`)}`,
      );
    }
    console.log(
      `    git -C ${shellQuote(path)} stash apply ${shellQuote(rescue.ref)}`,
    );
  }
}

function describeWindow(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** `dispatch gc`: inspect by default; rescue and remove only with --apply. */
export function cmdGc(args: string[], config: Config): void {
  const options = parseGcOptions(args);
  const root = gitRoot();
  if (options.rescued) {
    showRescues(root, config);
    return;
  }

  const worktrees = listDispatchWorktrees(root, config.worktreeDir);
  if (worktrees.length === 0) {
    log.info("No dispatch worktrees found");
    return;
  }

  const inspected = worktrees.map((worktree) =>
    inspectWorktree(worktree, options.olderThanDays, Date.now()),
  );
  console.log(
    `${fmt.BOLD}Worktree collection${fmt.NC}  ${fmt.DIM}(older than ${describeWindow(options.olderThanDays)})${fmt.NC}`,
  );
  console.log(`${fmt.DIM}──────────────────────────────────────────────${fmt.NC}`);
  for (const worktree of inspected) {
    const mark = worktree.decision.action === "collect" ? fmt.RED : fmt.GREEN;
    console.log(
      `  ${mark}●${fmt.NC} ${worktree.id}  ${fmt.DIM}(${worktree.decision.action}: ${worktree.decision.reason})${fmt.NC}`,
    );
  }
  console.log();

  const candidates = inspected.filter(
    (worktree) => worktree.decision.action === "collect",
  );
  if (!options.apply) {
    if (candidates.length === 0) {
      log.ok("No worktrees would be collected");
    } else {
      log.info(
        `${candidates.length} worktree(s) would be collected. Run dispatch gc --apply to remove them.`,
      );
    }
    return;
  }

  let removed = 0;
  const failures: string[] = [];
  for (const candidate of candidates) {
    const beforeRescue = reinspectWorktree(
      root,
      config.worktreeDir,
      candidate,
      options.olderThanDays,
    );
    if (!beforeRescue) {
      log.warn(`Kept ${candidate.id}: worktree disappeared while inspecting`);
      continue;
    }
    if (beforeRescue.decision.action === "keep") {
      log.warn(`Kept ${candidate.id}: ${beforeRescue.decision.reason}`);
      continue;
    }

    try {
      const rescue = rescueWorktree(candidate);
      if (rescue.sha) {
        log.ok(
          `Rescued ${candidate.id} at ${rescue.ref} (${rescue.sha.slice(0, 12)})`,
        );
      } else {
        log.dim(`  ${candidate.id}: no uncommitted changes to rescue`);
      }

      // Rescue takes long enough for a session or process to appear. Check all
      // safety signals again before the irreversible step.
      const beforeRemove = reinspectWorktree(
        root,
        config.worktreeDir,
        candidate,
        options.olderThanDays,
      );
      if (!beforeRemove) {
        log.warn(`Kept ${candidate.id}: worktree disappeared after rescue`);
        continue;
      }
      if (beforeRemove.decision.action === "keep") {
        log.warn(`Kept ${candidate.id}: ${beforeRemove.decision.reason}`);
        continue;
      }

      removeCollectedWorktree(root, beforeRemove);
      log.ok(`Collected ${candidate.id} (branch preserved)`);
      removed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(candidate.id);
      log.error(message);
    }
  }

  if (removed === 0 && failures.length === 0) {
    log.ok("No worktrees collected");
  } else if (removed > 0) {
    log.ok(`Collected ${removed} worktree(s)`);
  }
  if (failures.length > 0) {
    throw new Error(`Failed to collect: ${failures.join(", ")}`);
  }
}
