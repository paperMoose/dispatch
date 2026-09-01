// Turn state read from the agent's own transcript, asserted against screens
// and transcripts captured from live agents rather than strings written from
// memory.
//
// That distinction is the point of this file. Two bugs in one evening came
// from a mental model of what a terminal looks like being wrong: claude's
// trust prompt had become an arrow menu, and every readiness marker matched a
// startup banner that scrolls away — so an agent stopped being reachable once
// it had done enough work to be worth reaching. Both would have been caught by
// a single real capture. The fixtures beside this file are those captures.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, utimesSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { claudeTurnState, codexTurnState, readTurnState } from "../src/turnstate.js";
import { getAdapter } from "../src/agents.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const screen = (n: string) => readFileSync(join(HERE, "fixtures/screens", `${n}.txt`), "utf-8");
const transcript = (n: string) =>
  readFileSync(join(HERE, "fixtures/transcripts", `${n}.jsonl`), "utf-8")
    .split("\n")
    .filter((l) => l.trim());

describe("turn state, from the transcript", () => {
  it("reads a finished turn as waiting", () => {
    // Captured from an agent idle at an empty prompt having just printed
    // "Both jobs are done and pushed". Its screen carried no marker dispatch
    // recognised; its transcript said end_turn plainly.
    const r = claudeTurnState(transcript("claude-waiting"));
    assert.equal(r.state, "waiting");
    assert.match(r.evidence, /end_turn|turn_duration/);
  });

  it("reads a turn that is still running as working", () => {
    const r = claudeTurnState(transcript("claude-working"));
    assert.equal(r.state, "working");
  });

  it("reads codex mid-turn as working", () => {
    const r = codexTurnState(transcript("codex-working"));
    assert.equal(r.state, "working");
  });

  it("says unknown rather than guessing when there is no marker", () => {
    // Codex emits no turn-complete event we have observed. Reporting `waiting`
    // there would be a guess wearing the clothes of a fact, and a caller
    // cannot tell the difference.
    assert.equal(claudeTurnState(["{not json", "also not json"]).state, "unknown");
    assert.equal(codexTurnState([]).state, "unknown");
  });

  it("survives a half-written record at the end of the file", () => {
    // The transcript is appended to live, so a read can land mid-write.
    const lines = [...transcript("claude-waiting"), '{"type":"assist'];
    assert.equal(claudeTurnState(lines).state, "waiting");
  });
});

describe("an agent that was never given a prompt", () => {
  it("is named as such, not reported as broken", () => {
    // Three agents sat in exactly this state for an evening while every other
    // check called them healthy: alive, session present, cwd right, and no
    // transcript because they had never received a brief.
    const r = readTurnState(null, "claude");
    assert.equal(r.state, "never-started");
    assert.match(r.evidence, /not been given a prompt/);
    assert.equal(r.idleSeconds, -1);
  });

  it("says the same for a transcript path that does not exist", () => {
    assert.equal(readTurnState("/nope/missing.jsonl", "claude").state, "never-started");
  });
});

describe("how long since the agent last wrote", () => {
  it("is reported, so a stuck turn is distinguishable from a busy one", () => {
    // "working" alone cannot tell those apart, and they need different action.
    const dir = mkdtempSync(join(tmpdir(), "dispatch-turn-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, transcript("claude-working").join("\n") + "\n");
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(f, hourAgo, hourAgo);

    const r = readTurnState(f, "claude");
    assert.equal(r.state, "working");
    assert.ok(r.idleSeconds > 3000, `expected a stale reading, got ${r.idleSeconds}s`);
  });
});

// ---------------------------------------------------------------------------
// The screen predicates, against the same captured reality
// ---------------------------------------------------------------------------
describe("screen predicates against captured screens", () => {
  const claude = getAdapter("claude");

  it("recognises an agent that has worked for hours", () => {
    // The regression that made an agent less reachable the more it had done.
    assert.equal(claude.isReady(screen("claude-idle-after-hours")), true);
  });

  it("recognises a freshly started agent", () => {
    assert.equal(claude.isReady(screen("claude-fresh-ready")), true);
  });

  it("refuses a bare shell", () => {
    // The original false positive: a prompt pasted into a dead shell ran as
    // commands, line by line.
    assert.equal(claude.isReady(screen("shell-bare")), false);
  });

  it("refuses powerlevel10k's ruled prompt", () => {
    // p10k draws a rule above its prompt, so a rule alone cannot be the test.
    assert.equal(claude.isReady(screen("shell-p10k")), false);
  });

  it("sees the trust dialog for what it is", () => {
    const s = screen("claude-trust-dialog");
    assert.equal(claude.isReady(s), false);
    assert.ok(claude.dismissStartupDialog(s), "and knows how to answer it");
  });
});
