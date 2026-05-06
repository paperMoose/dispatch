import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isClaudeReady } from "../src/shell.js";

describe("isClaudeReady", () => {
  // Regression: the launch command contains the word "claude" — earlier
  // versions of waitForClaude matched /claude/i and returned immediately,
  // before the TUI was actually rendered. Prompts then fired into a dead
  // terminal and the agent sat idle at an empty prompt.
  it("does not match the typed launch command", () => {
    const cmdline =
      "➜  hey-2286-hey-2286 unset CLAUDECODE && claude --model opus --allowedTools \"WebSearch,WebFetch\"";
    assert.equal(isClaudeReady(cmdline), false);
  });

  it("does not match a fresh shell prompt", () => {
    assert.equal(isClaudeReady("➜  hey-2286-hey-2286 "), false);
    assert.equal(isClaudeReady(""), false);
  });

  it("matches the rendered Claude Code TUI banner", () => {
    const banner = [
      " ▐▛███▜▌   Claude Code v2.1.132",
      "▝▜█████▛▘  Opus 4.7 · Claude Max",
      "  ▘▘ ▝▝    ~/somewhere",
      "──────────",
      "❯",
      "──────────",
      "  ? for shortcuts",
    ].join("\n");
    assert.equal(isClaudeReady(banner), true);
  });

  it("matches the empty input prompt on its own line", () => {
    assert.equal(isClaudeReady("\n❯\n"), true);
    assert.equal(isClaudeReady("\n> \n"), true);
    assert.equal(isClaudeReady("\n? \n"), true);
  });

  it("matches older box-drawn welcome screens", () => {
    assert.equal(isClaudeReady("╭─ Welcome to Claude ─╮"), true);
  });
});
