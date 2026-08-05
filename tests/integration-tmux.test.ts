// Integration tests for the multiplexer paths, against a real tmux binary.
//
// The unit tests feed canned strings to the predicates. Every bug covered here
// got past that: the pane, the process tree and the tty line discipline are the
// parts that were wrong, and none of them can be faked convincingly. So these
// drive real tmux sessions, real processes and real repositories.
//
// Sessions are uniquely named and killed in a finally. Nothing here touches a
// session it did not create, and `kill-server` is never used: the suite
// routinely runs inside a multiplexer the developer is also using.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  agentProcessAlive,
  excludeDispatchArtifacts,
  isClaudeReady,
  tmuxTarget,
  useCmux,
  waitForAgent,
  worktreePath,
} from "../src/shell.js";
import { cmdSend } from "../src/commands.js";
import { getAdapter } from "../src/agents.js";
import type { Config } from "../src/config.js";

// cmux wins over tmux whenever CMUX_WORKSPACE_ID or CMUX_SOCKET_PATH is set,
// and every developer machine running dispatch inside cmux has them. Clearing
// them here — before any test body runs, and useCmux() is never called at
// import time — is what makes this file test the tmux backend rather than
// whatever the host happens to be. node:test gives each file its own process,
// so nothing else sees this.
delete process.env.CMUX_WORKSPACE_ID;
delete process.env.CMUX_SOCKET_PATH;

const HAVE_TMUX = spawnSync("tmux", ["-V"], { stdio: "pipe" }).status === 0;
const skip = HAVE_TMUX ? false : "tmux is not installed";

// The cwd half of agentProcessAlive shells out to lsof, which is present on
// macOS but not on a stock Linux CI runner. Skip rather than fail there: a
// missing tool is not a regression, and asserting on it turns every CI run
// into a blocked release.
const HAVE_LSOF = spawnSync("lsof", ["-v"], { stdio: "pipe" }).status !== null;
const skipLiveness = !HAVE_TMUX
  ? "tmux is not installed"
  : !HAVE_LSOF
    ? "lsof is not installed"
    : false;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Agent id with a random suffix, so concurrent runs cannot collide on a tmux
 *  session name (they are server-wide) and a crashed run cannot poison a
 *  later one. */
function agentId(what: string): string {
  return `disp-it-${what}-${randomBytes(4).toString("hex")}`;
}

function tempDir(what: string): string {
  // Resolved: /var/folders/… is a symlink to /private/var/…, and both `git
  // rev-parse --show-toplevel` and lsof report the physical path.
  return realpathSync(mkdtempSync(join(tmpdir(), `dispatch-it-${what}-`)));
}

function tmux(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("tmux", args, { encoding: "utf-8", stdio: "pipe" });
  return { status: r.status, stdout: (r.stdout || "").trim() };
}

/** Start a detached session named exactly as dispatch names it, so the code
 *  under test addresses it the same way it addresses a real agent. */
function startPane(id: string, cwd: string, command: string): void {
  const r = tmux(["new-session", "-d", "-s", tmuxTarget(id), "-c", cwd, command]);
  assert.equal(r.status, 0, `could not start tmux session for ${id}`);
}

function killPane(id: string): void {
  spawnSync("tmux", ["kill-session", "-t", tmuxTarget(id)], { stdio: "pipe" });
}

function capture(id: string): string {
  return tmux(["capture-pane", "-t", tmuxTarget(id), "-p", "-S", "-40"]).stdout;
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

/** Poll until `check` holds, up to `seconds`. Returns whether it held. */
function until(seconds: number, check: () => boolean): boolean {
  for (let i = 0; i < seconds * 10; i++) {
    if (check()) return true;
    spawnSync("sleep", ["0.1"]);
  }
  return check();
}

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    baseBranch: "main",
    agent: "claude",
    model: "",
    codexModel: "",
    reasoningEffort: "",
    maxTurns: "",
    maxBudget: "",
    allowedTools: "Bash,Read,Write,Edit",
    permissionMode: "",
    worktreeDir: ".worktrees",
    claudeTimeout: 30,
    ...overrides,
  };
}

/** A git repo with one commit, ready to hang worktrees off. */
function initRepo(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t",
     "commit", "-q", "--allow-empty", "-m", "init"],
    { stdio: "pipe" },
  );
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["-C", dir, "status", "--short"], {
    encoding: "utf-8",
  }).trim();
}

describe("tmux backend is the one under test", () => {
  it("cmux is not active for this file", () => {
    assert.equal(useCmux(), false);
  });
});

// ---------------------------------------------------------------------------
// 1. A bare shell prompt is not agent readiness
// ---------------------------------------------------------------------------
describe("waitForAgent against a real pane", { skip }, () => {
  it("times out on a pane sitting at a shell, and the prompt is never run", () => {
    const id = agentId("ready");
    const dir = tempDir("ready");
    const marker = join(dir, "EXECUTED");

    // `❯` is the default prompt character of pure, starship and powerlevel10k.
    // The old readiness regex was /^\s*[>?❯]\s*$/, so this pane — a dead shell,
    // exactly what is left behind when the agent CLI fails to start — reported
    // ready on the first poll.
    startPane(id, dir, `env PS1='❯ ' /bin/sh -i`);
    try {
      assert.ok(
        until(5, () => capture(id).includes("❯")),
        "precondition: the pane should be showing a shell prompt",
      );
      assert.equal(
        isClaudeReady(capture(id)),
        false,
        "a real shell prompt must not read as a rendered agent TUI",
      );

      // Multi-line, like every Linear ticket. The middle line is what the shell
      // would run if readiness were believed.
      const prompt = [
        "Investigate the flaky integration test.",
        `touch '${marker}'`,
        "Report back when done.",
      ].join("\n");

      const ready = waitForAgent(id, 3, getAdapter("claude"));

      // Do exactly what launchAgent does next when readiness is believed, so a
      // regression reproduces the original damage rather than only failing an
      // equality check.
      if (ready) {
        const pf = join(dir, "prompt.txt");
        writeFileSync(pf, prompt);
        const buf = `dispatch-it-${id}`;
        tmux(["load-buffer", "-b", buf, pf]);
        tmux(["paste-buffer", "-b", buf, "-t", tmuxTarget(id)]);
        tmux(["delete-buffer", "-b", buf]);
        sleep(1);
        tmux(["send-keys", "-t", tmuxTarget(id), "Enter"]);
        sleep(1);
      }

      assert.equal(
        existsSync(marker),
        false,
        "nothing from the prompt may reach the shell",
      );
      assert.equal(
        ready,
        false,
        "a pane at a shell prompt must never be reported as a ready agent",
      );
    } finally {
      killPane(id);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Liveness must be scoped to the pane
// ---------------------------------------------------------------------------
describe("agentProcessAlive against a real pane", { skip: skipLiveness }, () => {
  it("ignores an agent process that is not in this pane", (t) => {
    const id = agentId("alive");
    const wt = tempDir("alive-wt");
    const binDir = tempDir("alive-bin");

    // A stand-in for the agent CLI: long-running, and named whatever we like.
    // Copying a system binary breaks its signature and it is SIGKILLed on
    // macOS, so symlink instead — ps and pgrep both report the link's name.
    const bin = `dispatchagent${randomBytes(3).toString("hex")}`;
    const binPath = join(binDir, bin);
    symlinkSync("/bin/sleep", binPath);

    // The decoy: same executable name, cwd is the worktree, but it belongs to
    // no pane at all. A worktree routinely hosts several of these — an operator
    // attached in another window, a second dispatch run, a sub-agent.
    const decoy = spawn(binPath, ["120"], {
      cwd: wt,
      detached: true,
      stdio: "ignore",
    });
    decoy.unref();

    // The pane's own agent is gone; what is left is a live shell.
    startPane(id, wt, "/bin/sh -i");

    try {
      assert.ok(
        until(5, () => (tmux(["list-panes", "-t", tmuxTarget(id), "-F", "#{pane_pid}"]).stdout !== "")),
        "precondition: the pane should exist",
      );
      // The decoy has to be exactly what the old cwd-based check looked for, or
      // the test could pass for the wrong reason. Establishing it depends on
      // pgrep/lsof behaviour that differs between platforms, so treat an unmet
      // setup as "cannot run here" rather than as a regression: asserting on it
      // turns an environment difference into a blocked release.
      const decoyVisible = until(5, () => {
        const pids = spawnSync("pgrep", ["-x", bin], { encoding: "utf-8" }).stdout || "";
        return pids.trim().split("\n").some((pid) => {
          if (!/^\d+$/.test(pid)) return false;
          const info = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], {
            encoding: "utf-8",
          }).stdout || "";
          return info.split("\n").some((l) => l.startsWith("n") && l.slice(1) === wt);
        });
      });
      if (!decoyVisible) {
        t.skip(`cannot observe a decoy ${bin} via pgrep/lsof on this platform`);
        return;
      }

      assert.equal(
        agentProcessAlive(wt, bin, id),
        false,
        "a process outside the pane must not count as the pane's agent",
      );

      // Positive control: the same binary, this time in the pane. Without it a
      // liveness check hardwired to false would pass the assertion above.
      tmux(["send-keys", "-t", tmuxTarget(id), `exec ${binPath} 120`, "Enter"]);
      assert.ok(
        until(10, () => agentProcessAlive(wt, bin, id)),
        "an agent running in the pane must count as alive",
      );
    } finally {
      killPane(id);
      try { process.kill(decoy.pid!, "SIGKILL"); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-line text arrives as ONE submission
// ---------------------------------------------------------------------------
describe("dispatch send through a real pane", { skip }, () => {
  it("delivers a multi-line message as a single submission", () => {
    const id = agentId("send");
    const repo = tempDir("send-repo");
    initRepo(repo);

    const cwdBefore = process.cwd();
    const realExit = process.exit;
    // cmdSend exits the process on any failed precondition, which would take
    // the whole test run down. Turn that into an ordinary test failure.
    (process as unknown as { exit: (code?: number) => never }).exit = ((
      code?: number,
    ) => {
      throw new Error(`cmdSend called process.exit(${code})`);
    }) as never;

    try {
      process.chdir(repo);
      const config = makeConfig();
      const wt = worktreePath(id, config);
      mkdirSync(wt, { recursive: true });

      // dispatch reads the runtime and the mode from this marker; an
      // interactive claude agent is the case `dispatch send` is built for.
      writeFileSync(
        join(wt, ".dispatch-agent"),
        JSON.stringify({ agent: "claude", mode: "interactive" }) + "\n",
      );

      // The receiver stands in for the agent TUI. It has to satisfy the same
      // three gates a real one does — a process named `claude` inside the pane,
      // a painted readiness marker, no dialog — and it records each submitted
      // line separately, which is the whole point: one line per submission is
      // what the bug produced.
      const binDir = join(wt, "bin");
      mkdirSync(binDir);
      const binPath = join(binDir, "claude");
      symlinkSync("/bin/sh", binPath);

      const received = join(wt, "received.txt");
      const receiver = join(wt, "receiver.sh");
      writeFileSync(
        receiver,
        [
          `printf 'Claude Code v9.9.9\\n? for shortcuts\\n'`,
          `while IFS= read -r line; do printf '<<%s>>\\n' "$line" >> '${received}'; done`,
          "",
        ].join("\n"),
      );
      writeFileSync(received, "");

      startPane(id, wt, `${binPath} ${receiver}`);
      try {
        assert.ok(
          until(10, () => capture(id).includes("? for shortcuts")),
          "precondition: the receiver should have painted its readiness marker",
        );

        const message = [
          "First line alpha.",
          "Second line bravo.",
          "Third line charlie.",
          "Fourth line delta.",
        ].join("\n");
        const messageFile = join(repo, "message.txt");
        writeFileSync(messageFile, message);

        cmdSend([id, "--message-file", messageFile], config);

        assert.ok(
          until(10, () => readFileSync(received, "utf-8").trim() !== ""),
          "the message should have reached the pane",
        );
        // A late second submission is exactly the failure mode, so give the
        // pane time to produce one before counting.
        sleep(2);

        const submissions = readFileSync(received, "utf-8")
          .split("\n")
          .filter((l) => l.trim() !== "");

        assert.deepEqual(
          submissions,
          ["<<First line alpha. Second line bravo. Third line charlie. Fourth line delta.>>"],
          "a multi-line message must arrive as one submission carrying all of it",
        );
      } finally {
        killPane(id);
      }
    } finally {
      process.exit = realExit;
      process.chdir(cwdBefore);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Dispatch's own files stay out of the user's commits
// ---------------------------------------------------------------------------
const ARTIFACTS = [
  ".dispatch-agent",
  ".dispatch-prompt.txt",
  ".dispatch-cmux-workspace",
  ".dispatch.log",
];

describe("excludeDispatchArtifacts in a real repository", () => {
  it("hides every artifact from git status, in the main checkout", () => {
    const repo = tempDir("exclude-main");
    initRepo(repo);
    for (const f of ARTIFACTS) writeFileSync(join(repo, f), "x");

    assert.notEqual(
      gitStatus(repo),
      "",
      "precondition: the artifacts should be untracked before the call",
    );

    excludeDispatchArtifacts(repo);

    assert.equal(gitStatus(repo), "", "no dispatch artifact may be visible to git");
  });

  it("hides them in a linked worktree, where agents actually run", () => {
    // The worktree is where an agent runs `git add -A && git commit`, and it
    // shares .git/info/exclude with the main checkout rather than owning one.
    const repo = tempDir("exclude-wt");
    initRepo(repo);
    const wt = join(repo, ".worktrees", "agent");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "agent", wt], {
      stdio: "pipe",
    });

    for (const f of ARTIFACTS) writeFileSync(join(wt, f), "x");
    assert.notEqual(gitStatus(wt), "", "precondition: artifacts should be untracked");

    excludeDispatchArtifacts(wt);

    assert.equal(gitStatus(wt), "", "no dispatch artifact may be visible to git");
  });

  it("stays clean and duplicate-free when it runs twice", () => {
    // Every launch calls this, and a worktree gets reused across resumes.
    const repo = tempDir("exclude-twice");
    initRepo(repo);

    excludeDispatchArtifacts(repo);
    excludeDispatchArtifacts(repo);

    for (const f of ARTIFACTS) writeFileSync(join(repo, f), "x");
    assert.equal(gitStatus(repo), "", "artifacts must stay hidden after a second run");

    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf-8");
    for (const f of ARTIFACTS) {
      assert.equal(
        exclude.split(`${f}\n`).length - 1,
        1,
        `${f} should appear exactly once`,
      );
    }
  });

  it("preserves entries the repo already had", () => {
    const repo = tempDir("exclude-keep");
    initRepo(repo);
    const excludePath = join(repo, ".git", "info", "exclude");
    writeFileSync(excludePath, "# theirs\nmy-local-scratch/\nnotes.md\n");
    writeFileSync(join(repo, "notes.md"), "mine");
    mkdirSync(join(repo, "my-local-scratch"));
    writeFileSync(join(repo, "my-local-scratch", "x"), "x");

    excludeDispatchArtifacts(repo);
    for (const f of ARTIFACTS) writeFileSync(join(repo, f), "x");

    const after = readFileSync(excludePath, "utf-8");
    assert.ok(after.includes("my-local-scratch/"), "existing entries must survive");
    assert.ok(after.includes("notes.md"), "existing entries must survive");
    assert.equal(
      gitStatus(repo),
      "",
      "the repo's own exclusions must still apply alongside dispatch's",
    );
  });
});
