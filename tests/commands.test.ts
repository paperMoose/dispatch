import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { buildClaudeCmd, TICKET_RE } from "../src/commands.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    baseBranch: "dev",
    model: "",
    maxTurns: "",
    maxBudget: "",
    allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch,WebFetch",
    worktreeDir: ".worktrees",
    claudeTimeout: 30,
    ...overrides,
  };
}

describe("buildClaudeCmd", () => {
  it("interactive mode returns just 'claude'", () => {
    const cmd = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig(), "");
    assert.equal(cmd, "claude");
  });

  it("headless mode includes -p, --allowedTools, --output-format json", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    const cmd = buildClaudeCmd("do stuff", "headless", wtPath, makeConfig(), "");
    assert.ok(cmd.startsWith("claude -p"));
    assert.ok(cmd.includes("--allowedTools"));
    assert.ok(cmd.includes("--output-format json"));
  });

  it("adds model flag when set", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    const cmd = buildClaudeCmd("do stuff", "headless", wtPath, makeConfig({ model: "sonnet" }), "");
    assert.ok(cmd.includes("--model sonnet"));
  });

  it("model flag works in interactive mode too", () => {
    const cmd = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig({ model: "opus" }), "");
    assert.equal(cmd, "claude --model opus");
  });

  it("maxTurns and maxBudget only in headless", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    const cmd = buildClaudeCmd("do stuff", "headless", wtPath, makeConfig({ maxTurns: "10", maxBudget: "5" }), "");
    assert.ok(cmd.includes("--max-turns 10"));
    assert.ok(cmd.includes("--max-budget-usd 5"));

    const interactive = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig({ maxTurns: "10", maxBudget: "5" }), "");
    assert.ok(!interactive.includes("--max-turns"));
    assert.ok(!interactive.includes("--max-budget"));
  });

  it("appends extra args", () => {
    const cmd = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig(), "--verbose");
    assert.ok(cmd.endsWith("--verbose"));
  });

  it("writes prompt file in headless mode", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    buildClaudeCmd("my prompt text", "headless", wtPath, makeConfig(), "");
    const written = readFileSync(join(wtPath, ".dispatch-prompt.txt"), "utf-8");
    assert.equal(written, "my prompt text");
  });
});

describe("TICKET_RE", () => {
  it("matches valid ticket IDs", () => {
    assert.ok(TICKET_RE.test("HEY-123"));
    assert.ok(TICKET_RE.test("AB-1"));
    assert.ok(TICKET_RE.test("PROJ-99999"));
  });

  it("rejects invalid ticket IDs", () => {
    assert.ok(!TICKET_RE.test("hey-123"));
    assert.ok(!TICKET_RE.test("HEY123"));
    assert.ok(!TICKET_RE.test("123"));
    assert.ok(!TICKET_RE.test("HEY-"));
    assert.ok(!TICKET_RE.test("-123"));
    assert.ok(!TICKET_RE.test("Fix the auth bug"));
  });
});
