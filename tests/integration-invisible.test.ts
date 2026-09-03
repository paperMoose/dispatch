// Live proof that invisible mode is a real resumable Claude session and that
// its turn-end hook still closes the thread-delivery loop. This is deliberately
// not mocked: the nonce begins only in the thread buffer and must come back in
// a post written by the running agent after Claude injects the Stop hook output.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { readAgentState } from "../src/commands.js";
import { readThread } from "../src/threads.js";

const CLI = join(process.cwd(), "dist", "cli.js");
const claudeVersion = spawnSync("claude", ["--version"], { stdio: "pipe" });
const auth = spawnSync("claude", ["auth", "status", "--json"], {
  encoding: "utf-8",
  stdio: "pipe",
});
let loggedIn = false;
try {
  loggedIn = auth.status === 0 && JSON.parse(auth.stdout || "{}").loggedIn === true;
} catch {}
const skip = !existsSync(CLI)
  ? "dist/cli.js is not built"
  : claudeVersion.status !== 0
    ? "Claude Code is not installed"
    : !loggedIn
      ? "Claude Code is not authenticated"
      : false;

function run(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.CMUX_WORKSPACE_ID;
  delete env.CMUX_SOCKET_PATH;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...env,
      DISPATCH_AGENT: "claude",
      DISPATCH_MODEL: "haiku",
      DISPATCH_PERMISSION_MODE: "dontAsk",
      DISPATCH_ALLOWED_TOOLS: "Bash,Read",
    },
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 30_000,
  });
}

function initRepo(path: string): void {
  execFileSync("git", ["-C", path, "init", "-q", "-b", "main"]);
  execFileSync(
    "git",
    [
      "-C",
      path,
      "-c",
      "user.email=dispatch-test@example.com",
      "-c",
      "user.name=Dispatch Test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "initial",
    ],
  );
  // Dispatch branches from origin/<base>. A local self-remote gives this
  // disposable repository the same shape without touching the network.
  execFileSync("git", ["-C", path, "remote", "add", "origin", path]);
  execFileSync("git", ["-C", path, "fetch", "-q", "origin", "main"]);
  writeFileSync(join(path, ".dispatch.yml"), "base_branch: main\n");
}

function until(seconds: number, check: () => boolean): boolean {
  for (let i = 0; i < seconds * 2; i++) {
    if (check()) return true;
    spawnSync("sleep", ["0.5"]);
  }
  return check();
}

describe("invisible Claude loop-back", { skip }, () => {
  it(
    "launches without a pane, discovers native state, and receives a thread reply through the hook",
    { timeout: 120_000 },
    () => {
      const repo = mkdtempSync(join(tmpdir(), "dispatch-invisible-live-"));
      const suffix = randomBytes(4).toString("hex");
      const id = `invisible-live-${suffix}`;
      const threadId = `t-invisible-${suffix}`;
      const nonce = `INVISIBLE_HOOK_${randomBytes(8).toString("hex")}`;
      const threadFile = join(homedir(), ".dispatch", "threads", `${threadId}.jsonl`);
      let nativeId = "";

      initRepo(repo);
      try {
        let result = run(repo, ["thread", "new", "human", id, "--id", threadId]);
        assert.equal(result.status, 0, result.stderr);

        result = run(repo, [
          "thread",
          "post",
          threadId,
          "--from",
          "human",
          `@${id} Reply to this thread with exactly ${nonce}.`,
        ]);
        assert.equal(result.status, 0, result.stderr);

        result = run(repo, [
          "run",
          "Reply exactly INITIAL_TURN_COMPLETE. Do not inspect dispatch thread files or run dispatch commands. If a turn-end hook adds new instructions, follow those instructions.",
          "--name",
          id,
          "--invisible",
        ]);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /launched \(invisible\)/);

        const wtPath = join(repo, ".worktrees", id);
        const marker = readAgentState(wtPath);
        assert.equal(marker.mode, "invisible");
        nativeId = marker.nativeId || "";
        assert.ok(nativeId, "the native Claude id must be persisted for attach/status");
        assert.ok(existsSync(join(wtPath, ".dispatch-inbox-hook.sh")));
        assert.ok(statSync(join(wtPath, ".dispatch-inbox-hook.sh")).mode & 0o100);
        assert.match(
          readFileSync(join(wtPath, ".claude", "settings.local.json"), "utf8"),
          /\.dispatch-inbox-hook\.sh/,
        );

        const tmux = spawnSync("tmux", ["has-session", "-t", `dispatch-${id}`]);
        assert.notEqual(tmux.status, 0, "invisible mode must not create a hidden tmux session");

        assert.ok(
          until(90, () => {
            const thread = readThread(join(homedir(), ".dispatch", "threads"), threadId);
            return !!thread?.posts.some((post) => post.from === id && post.text.includes(nonce));
          }),
          `the agent never returned ${nonce} through the thread buffer`,
        );

        result = run(repo, ["list", "--brief"]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`${id}.*invisible`));

        result = run(repo, ["status", id]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Mode: invisible/);
        assert.match(result.stdout, new RegExp(`Native session: ${nativeId}`));

        result = run(repo, ["send", id, "this must not disappear"]);
        assert.equal(result.status, 1);
        assert.match(`${result.stdout}\n${result.stderr}`, /invisible claude session/i);
        assert.match(`${result.stdout}\n${result.stderr}`, /dispatch attach/);
        assert.match(`${result.stdout}\n${result.stderr}`, /shared dispatch thread/);
      } finally {
        if (nativeId) {
          run(repo, ["stop", id]);
          spawnSync("claude", ["rm", nativeId], { stdio: "pipe" });
        }
        if (existsSync(join(repo, ".worktrees", id))) {
          run(repo, ["cleanup", id, "--delete-branch"]);
        }
        rmSync(threadFile, { force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
