import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { excludeDispatchArtifacts } from "../src/shell.js";
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

describe("excludeDispatchArtifacts", () => {
  it("hides dispatch's own files from git", () => {
    // Agents routinely run `git add -A && git commit`. Without this, dispatch's
    // bookkeeping lands in the user's PR: noah-server's 2ab87ecf2 shipped a
    // prompt file and a workspace id alongside real code.
    const dir = mkdtempSync(join(tmpdir(), "dispatch-exclude-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);

    for (const f of [".dispatch-agent", ".dispatch-prompt.txt", ".dispatch.log"]) {
      writeFileSync(join(dir, f), "x");
    }
    assert.notEqual(
      execFileSync("git", ["-C", dir, "status", "--short"], { encoding: "utf-8" }).trim(),
      "",
      "precondition: artifacts should be untracked before the call",
    );

    excludeDispatchArtifacts(dir);

    assert.equal(
      execFileSync("git", ["-C", dir, "status", "--short"], { encoding: "utf-8" }).trim(),
      "",
      "artifacts must be invisible to git",
    );
  });

  it("does not append duplicates when run repeatedly", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-exclude-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);

    excludeDispatchArtifacts(dir);
    excludeDispatchArtifacts(dir);
    excludeDispatchArtifacts(dir);

    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf-8");
    assert.equal(exclude.split(".dispatch-agent").length - 1, 1);
  });

  it("keeps whatever the repo already excluded", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-exclude-"));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    const exclude = join(dir, ".git", "info", "exclude");
    writeFileSync(exclude, "# theirs\nmy-local-scratch/\n");

    excludeDispatchArtifacts(dir);

    const after = readFileSync(exclude, "utf-8");
    assert.ok(after.includes("my-local-scratch/"), "existing entries must survive");
    assert.ok(after.includes(".dispatch-agent"));
  });
});
