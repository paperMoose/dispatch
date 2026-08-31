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
  paneDelivery,
  MAX_PANE_WRITE_BYTES,
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

describe("paneDelivery", () => {
  const HANDOFF = "/tmp/wt/.dispatch-message-1.md";

  it("types a short message straight into the pane", () => {
    const plan = paneDelivery("do the thing", HANDOFF);
    assert.equal(plan.needsFile, false);
    assert.equal(plan.inline, "do the thing");
  });

  it("hands over a message the pty would silently cut", () => {
    // Measured on cmux 2026-08-31: 3500 bytes arrive whole, 4000 do not, and
    // the write reports success either way. A brief this size was delivered
    // headless twice and the agent acted on the surviving prefix.
    const long = "step one. " + "x".repeat(6000) + " step nine.";
    const plan = paneDelivery(long, HANDOFF);
    assert.equal(plan.needsFile, true);
    assert.ok(
      plan.inline.includes(HANDOFF),
      "the pointer must name the file the agent has to read",
    );
    assert.equal(plan.body, long, "the file gets the message unflattened");
  });

  it("never types more than one pty buffer can hold", () => {
    // The property that matters: whatever comes back for the pane is small
    // enough to survive the write. Sizes either side of the cap and far past it.
    for (const n of [10, 2000, 2600, 5000, 200000]) {
      const plan = paneDelivery("y".repeat(n), HANDOFF);
      assert.ok(
        Buffer.byteLength(plan.inline, "utf8") <= MAX_PANE_WRITE_BYTES,
        `a ${n}-byte message produced a ${Buffer.byteLength(plan.inline, "utf8")}-byte write`,
      );
    }
  });

  it("keeps the newlines the pane would have flattened", () => {
    // Why a file beats chunking: numbered instructions stay numbered, and
    // that is what an agent loses when a long brief is collapsed to one line.
    const numbered = Array.from({ length: 400 }, (_, i) => `${i + 1}. item`).join("\n");
    const plan = paneDelivery(numbered, HANDOFF);
    assert.equal(plan.needsFile, true);
    assert.ok(plan.body.includes("\n"), "the handed-over body keeps its line breaks");
  });

  it("measures the cap in bytes, not characters", () => {
    // A multi-byte character counts against the pty buffer at its real width.
    const wide = "\u00e9".repeat(MAX_PANE_WRITE_BYTES - 100);
    const plan = paneDelivery(wide, HANDOFF);
    assert.equal(plan.needsFile, true, "2x-width text over the cap must hand over");
  });
});
