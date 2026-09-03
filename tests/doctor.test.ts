import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkAgent,
  checkBaseBranch,
  checkGitRepository,
  checkMultiplexer,
  checkNodeVersion,
  checkTurnEndHook,
  checkWorktreeDirectory,
  doctorExitCode,
  type AgentFact,
} from "../src/doctor.js";

describe("doctor checks", () => {
  it("reports a missing multiplexer with the command that fixes it", () => {
    const finding = checkMultiplexer({ tmux: false, cmux: false });
    assert.equal(finding.status, "error");
    assert.match(finding.message, /no usable multiplexer/i);
    assert.match(finding.fix || "", /brew install tmux/);
  });

  it("accepts either supported multiplexer", () => {
    assert.equal(checkMultiplexer({ tmux: true, cmux: false }).status, "ok");
    assert.equal(checkMultiplexer({ tmux: false, cmux: true }).status, "ok");
  });

  it("makes a missing configured agent an error", () => {
    const fact: AgentFact = {
      kind: "codex",
      onPath: false,
      auth: "unknown",
      authCommand: "codex login status",
    };
    const finding = checkAgent(fact, "codex");
    assert.equal(finding.status, "error");
    assert.match(finding.fix || "", /codex.*PATH/i);
  });

  it("makes an unavailable optional agent only a warning", () => {
    const fact: AgentFact = {
      kind: "claude",
      onPath: false,
      auth: "unknown",
      authCommand: "claude auth status",
    };
    assert.equal(checkAgent(fact, "codex").status, "warning");
  });

  it("reports authentication and how to sign in", () => {
    const fact: AgentFact = {
      kind: "codex",
      onPath: true,
      auth: "unauthenticated",
      authCommand: "codex login status",
    };
    const finding = checkAgent(fact, "codex");
    assert.equal(finding.status, "error");
    assert.match(finding.message, /not authenticated/i);
    assert.match(finding.fix || "", /codex login/);
  });

  it("reports when cwd is not in a git repository", () => {
    const finding = checkGitRepository({ inside: false });
    assert.equal(finding.status, "error");
    assert.match(finding.fix || "", /cd .*git repository/i);
  });

  it("reports a missing configured base branch by name", () => {
    const finding = checkBaseBranch({
      name: "dev",
      exists: false,
      repositoryAvailable: true,
      suggested: "main",
    });
    assert.equal(finding.status, "error");
    assert.match(finding.message, /'dev'.*does not exist/i);
    assert.match(finding.fix || "", /base_branch: main/);
  });

  it("reports an unwritable worktree directory with its path", () => {
    const finding = checkWorktreeDirectory({
      path: "/read-only/.worktrees",
      writable: false,
      reason: "permission denied",
    });
    assert.equal(finding.status, "error");
    assert.match(finding.message, /\/read-only\/\.worktrees/);
    assert.match(finding.fix || "", /worktree_dir/);
  });

  it("reports when the configured agent hook cannot be installed", () => {
    const finding = checkTurnEndHook({
      agent: "claude",
      installable: false,
      reason: "permission denied",
    });
    assert.equal(finding.status, "error");
    assert.match(finding.message, /claude.*permission denied/i);
    assert.ok(finding.fix);
  });

  it("enforces the required Node major version", () => {
    assert.equal(
      checkNodeVersion({ version: "19.9.1", minimumMajor: 20 }).status,
      "error",
    );
    assert.equal(
      checkNodeVersion({ version: "20.0.0", minimumMajor: 20 }).status,
      "ok",
    );
  });

  it("exits non-zero only when an error is present", () => {
    const warning = checkAgent(
      {
        kind: "claude",
        onPath: false,
        auth: "unknown",
        authCommand: "claude auth status",
      },
      "codex",
    );
    assert.equal(doctorExitCode([warning]), 0);
    assert.equal(
      doctorExitCode([warning, checkGitRepository({ inside: false })]),
      1,
    );
  });
});
