import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAdapter } from "../src/agents.js";
import { buildAgentCmd, readAgentState } from "../src/commands.js";
import type { Config } from "../src/config.js";
import {
  findInvisibleSession,
  invisibleUnsupportedMessage,
  parseClaudeAgents,
  parseInvisibleLaunchId,
  runModeFromFlags,
} from "../src/runner.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    baseBranch: "main",
    agent: "claude",
    model: "opus[1m]",
    codexModel: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    maxTurns: "7",
    maxBudget: "12.50",
    allowedTools: "Bash,Read,Edit,WebSearch",
    permissionMode: "dontAsk",
    threadDelivery: "ask",
    worktreeDir: ".worktrees",
    claudeTimeout: 30,
    ...overrides,
  };
}

describe("invisible mode selection", () => {
  it("is a third mode, distinct from both existing modes", () => {
    assert.equal(runModeFromFlags([]), "interactive");
    assert.equal(runModeFromFlags(["--headless"]), "headless");
    assert.equal(runModeFromFlags(["-H"]), "headless");
    assert.equal(runModeFromFlags(["--invisible"]), "invisible");
  });

  it("refuses contradictory launch modes", () => {
    assert.throws(
      () => runModeFromFlags(["--headless", "--invisible"]),
      /different launch modes; choose one/,
    );
  });
});

describe("invisible launch lines", () => {
  it("uses Claude's native background session and feeds it the full prompt file", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-invisible-cmd-"));
    const promptPath = join(wtPath, ".dispatch-prompt.txt");
    const command = buildAgentCmd(
      "keep\nthese\nlines",
      "invisible",
      wtPath,
      config(),
      "--extra-flag",
    );

    assert.equal(
      command,
      `claude --bg --model 'opus[1m]' --permission-mode dontAsk ` +
        `--allowedTools "Bash,Read,Edit,WebSearch" --extra-flag < '${promptPath}'`,
    );
    assert.equal(readFileSync(promptPath, "utf8"), "keep\nthese\nlines");
    assert.ok(!command.includes(" -p"), "invisible is a session, not a headless print run");
    assert.ok(!command.includes("--max-turns"), "session mode must not inherit headless-only limits");
  });

  it("names Codex and its experimental-only alternative instead of substituting another mode", () => {
    const message = invisibleUnsupportedMessage("codex");
    assert.match(message, /^Codex does not support --invisible/);
    assert.match(message, /app-server is experimental/);
    assert.equal(getAdapter("codex").invisible, undefined);
    assert.throws(
      () =>
        buildAgentCmd(
          "do work",
          "invisible",
          "/tmp/codex-invisible",
          config({ agent: "codex", maxTurns: "", maxBudget: "" }),
          "",
        ),
      /Codex does not support --invisible/,
    );
  });
});

describe("Claude native session discovery", () => {
  const output = JSON.stringify([
    {
      pid: 12,
      cwd: "/repo/.worktrees/visible",
      kind: "interactive",
      sessionId: "visible-session",
      status: "busy",
    },
    {
      id: "older123",
      cwd: "/repo/.worktrees/agent-a",
      kind: "background",
      startedAt: 100,
      sessionId: "older-session",
      name: "older",
      status: "idle",
      state: "blocked",
    },
    {
      id: "newer456",
      cwd: "/repo/.worktrees/agent-a",
      kind: "background",
      startedAt: 200,
      sessionId: "newer-session",
      name: "newer",
      status: "idle",
      state: "working",
    },
  ]);

  it("keeps background sessions and prefers Claude's own state field", () => {
    const sessions = parseClaudeAgents(output);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].state, "blocked");
    assert.equal(sessions[1].state, "working");
  });

  it("resolves by saved native id, with newest matching cwd as recovery", () => {
    const sessions = parseClaudeAgents(output);
    assert.equal(findInvisibleSession(sessions, "/somewhere/else", "older123")?.id, "older123");
    assert.equal(findInvisibleSession(sessions, "/repo/.worktrees/agent-a")?.id, "newer456");
  });

  it("reads the native id from Claude's real launch receipt shape", () => {
    assert.equal(
      parseInvisibleLaunchId("Starting background service…\nbackgrounded · c1d6dbc0\n"),
      "c1d6dbc0",
    );
  });

  it("persists native identity without changing old marker reads", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-invisible-marker-"));
    writeFileSync(
      join(wtPath, ".dispatch-agent"),
      JSON.stringify({ agent: "claude", mode: "invisible", nativeId: "abc12345" }),
    );
    assert.deepEqual(readAgentState(wtPath), {
      agent: "claude",
      mode: "invisible",
      nativeId: "abc12345",
    });
  });
});
