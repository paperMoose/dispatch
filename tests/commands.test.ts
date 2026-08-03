import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { writeFileSync } from "fs";
import {
  buildClaudeCmd,
  interactiveClaudeCmd,
  collapseForPane,
  readAgentState,
  TICKET_RE,
} from "../src/commands.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    baseBranch: "dev",
    model: "",
    maxTurns: "",
    maxBudget: "",
    allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch,WebFetch",
    permissionMode: "",
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
    assert.ok(cmd.includes("--output-format stream-json"));
  });

  it("adds model flag when set", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    const cmd = buildClaudeCmd("do stuff", "headless", wtPath, makeConfig({ model: "sonnet" }), "");
    assert.ok(cmd.includes("--model 'sonnet'"));
  });

  it("model flag works in interactive mode too", () => {
    const cmd = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig({ model: "opus" }), "");
    assert.equal(cmd, "claude --model 'opus'");
  });

  it("quotes bracketed model names so zsh does not glob them", () => {
    const cmd = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig({ model: "opus[1m]" }), "");
    assert.equal(cmd, "claude --model 'opus[1m]'");
  });

  it("passes the permission mode through in both modes", () => {
    const wtPath = mkdtempSync(join(tmpdir(), "dispatch-test-"));
    const headless = buildClaudeCmd("do stuff", "headless", wtPath, makeConfig({ permissionMode: "dontAsk" }), "");
    assert.ok(headless.includes("--permission-mode dontAsk"));

    const interactive = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig({ permissionMode: "dontAsk" }), "");
    assert.equal(interactive, "claude --permission-mode dontAsk");
  });

  it("omits the permission mode when prompts are wanted", () => {
    const cmd = buildClaudeCmd("do stuff", "interactive", "/tmp/wt", makeConfig({ permissionMode: "" }), "");
    assert.ok(!cmd.includes("--permission-mode"));
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

describe("interactiveClaudeCmd", () => {
  it("carries model and permission mode into the pane", () => {
    const cmd = interactiveClaudeCmd(makeConfig({ model: "opus[1m]", permissionMode: "dontAsk" }));
    assert.equal(cmd, `claude --model 'opus[1m]' --permission-mode dontAsk --allowedTools "WebSearch,WebFetch"`);
  });

  it("drops the permission mode under --ask", () => {
    const cmd = interactiveClaudeCmd(makeConfig({ model: "opus", permissionMode: "" }));
    assert.equal(cmd, `claude --model 'opus' --allowedTools "WebSearch,WebFetch"`);
  });

  it("puts --continue first when resuming", () => {
    const cmd = interactiveClaudeCmd(makeConfig({ permissionMode: "dontAsk" }), true);
    assert.equal(cmd, `claude --continue --permission-mode dontAsk --allowedTools "WebSearch,WebFetch"`);
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

describe("collapseForPane", () => {
  it("flattens multi-line text into one submission", () => {
    // tmux paste-buffer turns each newline into Enter, which was verified to
    // execute multi-line text as separate shell commands.
    const msg = "line one\nline two\nline three";
    assert.equal(collapseForPane(msg), "line one line two line three");
  });

  it("collapses blank lines and surrounding whitespace", () => {
    assert.equal(collapseForPane("a\n\n\n   b  \n c"), "a b c");
  });

  it("leaves single-line text alone", () => {
    assert.equal(collapseForPane("just one line"), "just one line");
  });

  it("never emits a newline, whatever the input", () => {
    for (const input of ["a\nb", "\n\n", "x\r\ny", " \n lead", "trail \n "]) {
      assert.ok(!collapseForPane(input).includes("\n"), JSON.stringify(input));
    }
  });
});

describe("readAgentState", () => {
  it("reads the runtime and mode from a JSON marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-marker-"));
    writeFileSync(join(dir, ".dispatch-agent"), JSON.stringify({ agent: "codex", mode: "interactive" }));
    assert.deepEqual(readAgentState(dir), { agent: "codex", mode: "interactive" });
  });

  it("reads a pre-0.9.1 marker holding only the runtime", () => {
    // Worktrees created before the mode was recorded must keep working.
    const dir = mkdtempSync(join(tmpdir(), "dispatch-marker-"));
    writeFileSync(join(dir, ".dispatch-agent"), "codex\n");
    assert.deepEqual(readAgentState(dir), { agent: "codex", mode: null });
  });

  it("reports nothing for a worktree with no marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-marker-"));
    assert.deepEqual(readAgentState(dir), { agent: "", mode: null });
  });

  it("survives a corrupt marker rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-marker-"));
    writeFileSync(join(dir, ".dispatch-agent"), "{not json");
    assert.deepEqual(readAgentState(dir), { agent: "", mode: null });
  });
});
