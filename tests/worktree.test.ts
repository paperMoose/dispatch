import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import type { Config } from "../src/config.js";
import {
  cmdGc,
  decideWorktreeCollection,
  listRescueRefs,
  parseGcOptions,
  type WorktreeSignals,
} from "../src/worktree.js";

const INACTIVE: WorktreeSignals = {
  sessionExists: false,
  agentProcessAlive: false,
  locked: false,
  recentlyModified: false,
};

describe("worktree collection decision", () => {
  it("keeps a worktree with a live session", () => {
    assert.deepEqual(
      decideWorktreeCollection({ ...INACTIVE, sessionExists: true }),
      { action: "keep", reason: "live session" },
    );
  });

  it("keeps a worktree with a live process", () => {
    assert.deepEqual(
      decideWorktreeCollection({ ...INACTIVE, agentProcessAlive: true }),
      { action: "keep", reason: "live process" },
    );
  });

  it("keeps a worktree git reports as locked", () => {
    assert.deepEqual(
      decideWorktreeCollection({ ...INACTIVE, locked: true }),
      { action: "keep", reason: "locked by git" },
    );
  });

  it("keeps a worktree modified within the keep window", () => {
    assert.deepEqual(
      decideWorktreeCollection({ ...INACTIVE, recentlyModified: true }),
      { action: "keep", reason: "modified within keep window" },
    );
  });

  it("keeps a worktree whose modification times cannot be inspected", () => {
    assert.deepEqual(
      decideWorktreeCollection({ ...INACTIVE, inspectionFailed: true }),
      { action: "keep", reason: "could not inspect modification times" },
    );
  });

  it("collects an inactive old worktree even when it is dirty", () => {
    assert.deepEqual(
      decideWorktreeCollection({ ...INACTIVE, dirty: true }),
      { action: "collect", reason: "inactive beyond keep window" },
    );
  });
});

describe("gc options", () => {
  it("defaults to a seven-day dry run", () => {
    assert.deepEqual(parseGcOptions([]), {
      apply: false,
      olderThanDays: 7,
      rescued: false,
    });
  });

  it("accepts apply, keep-window, and rescue-list modes", () => {
    assert.deepEqual(parseGcOptions(["--apply", "--older-than", "14"]), {
      apply: true,
      olderThanDays: 14,
      rescued: false,
    });
    assert.deepEqual(parseGcOptions(["--rescued"]), {
      apply: false,
      olderThanDays: 7,
      rescued: true,
    });
  });

  it("rejects unsafe or contradictory options", () => {
    assert.throws(() => parseGcOptions(["--older-than", "-1"]));
    assert.throws(() => parseGcOptions(["--older-than", "nope"]));
    assert.throws(() => parseGcOptions(["--rescued", "--apply"]));
    assert.throws(() => parseGcOptions(["--unknown"]));
  });
});

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function refOrEmpty(repo: string, ref: string): string {
  const result = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "--verify", "--quiet", ref],
    { encoding: "utf-8", stdio: "pipe" },
  );
  return result.status === 0 ? result.stdout.trim() : "";
}

function ageTree(path: string, date: Date): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      ageTree(join(path, entry), date);
    }
  }
  utimesSync(path, date, date);
}

function config(): Config {
  return {
    baseBranch: "main",
    agent: "claude",
    model: "",
    codexModel: "",
    reasoningEffort: "",
    maxTurns: "",
    maxBudget: "",
    allowedTools: "",
    permissionMode: "",
    threadDelivery: "ask",
    worktreeDir: ".worktrees",
    claudeTimeout: 1,
  };
}

describe("live rescue and collection", () => {
  it("dry-runs without mutation, then rescues, removes, and restores dirt", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-gc-")));
    cleanup.push(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "gc-test@example.com"]);
    git(repo, ["config", "user.name", "Dispatch GC Test"]);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-qm", "initial"]);

    const id = `gc-live-${basename(repo).slice(-8).toLowerCase()}`;
    const worktree = join(repo, ".worktrees", id);
    git(repo, ["worktree", "add", "-q", "-b", id, worktree]);

    // Seed the shared stack so equality proves rescue neither adds nor moves
    // an entry. Production code must never use `stash push`.
    writeFileSync(join(repo, "tracked.txt"), "stash sentinel\n");
    git(repo, ["stash", "push", "-qm", "pre-existing stash"]);
    const stashBefore = refOrEmpty(repo, "refs/stash");
    assert.ok(stashBefore);

    writeFileSync(join(worktree, "tracked.txt"), "tracked rescue\n");
    writeFileSync(join(worktree, "untracked.txt"), "untracked rescue\n");
    ageTree(worktree, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));

    const statusBefore = git(worktree, ["status", "--short"]);
    const trackedBefore = readFileSync(join(worktree, "tracked.txt"), "utf-8");
    const untrackedBefore = readFileSync(join(worktree, "untracked.txt"), "utf-8");
    const rescueRef = `refs/dispatch-rescue/${id}`;
    const originalCwd = process.cwd();

    try {
      process.chdir(repo);
      cmdGc([], config());

      assert.ok(existsSync(worktree), "dry run must leave the worktree on disk");
      assert.equal(git(worktree, ["status", "--short"]), statusBefore);
      assert.equal(readFileSync(join(worktree, "tracked.txt"), "utf-8"), trackedBefore);
      assert.equal(readFileSync(join(worktree, "untracked.txt"), "utf-8"), untrackedBefore);
      assert.equal(refOrEmpty(repo, rescueRef), "", "dry run must not create a rescue ref");
      assert.equal(refOrEmpty(repo, "refs/stash"), stashBefore);

      cmdGc(["--apply"], config());
    } finally {
      process.chdir(originalCwd);
    }

    assert.ok(!existsSync(worktree), "apply removes the linked checkout");
    assert.ok(refOrEmpty(repo, `refs/heads/${id}`), "the branch survives collection");
    const rescueSha = refOrEmpty(repo, rescueRef);
    assert.ok(rescueSha, "dirty worktree receives a durable rescue ref");
    assert.equal(refOrEmpty(repo, "refs/stash"), stashBefore, "stash stack is unchanged");
    assert.deepEqual(
      listRescueRefs(repo).map(({ id: rescuedId, sha }) => ({ id: rescuedId, sha })),
      [{ id, sha: rescueSha }],
    );

    git(repo, ["worktree", "add", "-q", worktree, id]);
    git(worktree, ["stash", "apply", rescueRef]);
    assert.equal(readFileSync(join(worktree, "tracked.txt"), "utf-8"), trackedBefore);
    assert.equal(readFileSync(join(worktree, "untracked.txt"), "utf-8"), untrackedBefore);
    assert.match(git(worktree, ["status", "--short"]), /tracked\.txt/);
    assert.match(git(worktree, ["status", "--short"]), /untracked\.txt/);
    assert.equal(refOrEmpty(repo, "refs/stash"), stashBefore, "restore also leaves the stack alone");
  });
});
