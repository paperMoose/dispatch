// The agent directory and do-not-disturb: the file and string half, which is
// everything except the multiplexer. The pane-level behaviour — that a
// do-not-disturb agent is genuinely not written to — is in
// integration-tmux.test.ts, against a real pane.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DND_MARKER,
  agentIdFromPath,
  clearDnd,
  describeWork,
  directoryJson,
  formatDirectory,
  readDnd,
  setDnd,
  type DirectoryEntry,
} from "../src/directory.js";

const PLAIN = { BOLD: "", DIM: "", GREEN: "", YELLOW: "", RED: "", NC: "" };

function worktree(): string {
  return mkdtempSync(join(tmpdir(), "dispatch-dnd-"));
}

describe("do-not-disturb", () => {
  it("is off until it is set, and carries the reason back", () => {
    const wt = worktree();
    assert.equal(readDnd(wt), null);

    setDnd(wt, "mid-migration, do not interrupt");
    const dnd = readDnd(wt)!;
    assert.equal(dnd.reason, "mid-migration, do not interrupt");
    assert.ok(dnd.since, "the marker records when, so a stale one is visible");
  });

  it("lives in the agent's own worktree, so the agent can set its own", () => {
    const wt = worktree();
    setDnd(wt, "");
    assert.ok(existsSync(join(wt, DND_MARKER)));
  });

  it("survives the marker `dispatch resume` rewrites", () => {
    // Do-not-disturb deliberately does not live in .dispatch-agent: resume
    // rewrites that file, which would silently clear the flag and start
    // interrupting an agent that asked not to be.
    const wt = worktree();
    setDnd(wt, "careful work");
    writeFileSync(join(wt, ".dispatch-agent"), JSON.stringify({ agent: "claude", mode: "interactive" }));
    assert.equal(readDnd(wt)!.reason, "careful work");
  });

  it("reads a corrupt marker as off rather than silencing an agent forever", () => {
    const wt = worktree();
    writeFileSync(join(wt, DND_MARKER), "{not json");
    assert.equal(readDnd(wt), null);
  });

  it("reports whether clearing it changed anything", () => {
    const wt = worktree();
    setDnd(wt, "x");
    assert.equal(clearDnd(wt), true);
    assert.equal(readDnd(wt), null);
    assert.equal(clearDnd(wt), false, "clearing twice is not an error");
  });
});

describe("working out which agent is running a command", () => {
  const root = "/repo";

  it("names the agent whose worktree the command was run in", () => {
    assert.equal(agentIdFromPath("/repo/.worktrees/hey-837", root, ".worktrees"), "hey-837");
  });

  it("works from a subdirectory of that worktree", () => {
    assert.equal(agentIdFromPath("/repo/.worktrees/hey-837/src/api", root, ".worktrees"), "hey-837");
  });

  it("names nobody outside the worktree directory", () => {
    // The orchestrator runs from the repo root and must stay "human": its
    // posts start a fresh reply chain, which is how a stalled thread restarts.
    assert.equal(agentIdFromPath("/repo", root, ".worktrees"), "");
    assert.equal(agentIdFromPath("/repo/src", root, ".worktrees"), "");
    assert.equal(agentIdFromPath("/elsewhere/.worktrees/x", root, ".worktrees"), "");
  });

  it("honours a configured worktree directory", () => {
    assert.equal(agentIdFromPath("/repo/agents/hey-1", root, "agents"), "hey-1");
  });
});

describe("what an agent is working on", () => {
  it("prefers the brief it was launched with", () => {
    const work = describeWork({
      prompt: "Fix the auth bug in session.ts",
      history: "something older",
      lastText: "Running the tests",
    });
    assert.deepEqual(work, { text: "Fix the auth bug in session.ts", source: "prompt" });
  });

  it("falls back to the history event when the worktree has no brief", () => {
    const work = describeWork({ history: "Linear ticket HEY-837: rate limiting", lastText: "x" });
    assert.equal(work.source, "history");
    assert.equal(work.text, "Linear ticket HEY-837: rate limiting");
  });

  it("falls back to the agent's own last message when there is no brief at all", () => {
    // An agent started by hand, or one whose prompt was typed into the pane:
    // its last message is the only real evidence of what it is doing.
    const work = describeWork({ lastText: "I have finished the migration and am writing tests" });
    assert.equal(work.source, "last-message");
  });

  it("says nothing rather than inventing something", () => {
    assert.deepEqual(describeWork({}), { text: "", source: "unknown" });
    assert.deepEqual(describeWork({ prompt: "   \n\n  " }), { text: "", source: "unknown" });
  });

  it("takes the first line that says something, past the markdown", () => {
    const work = describeWork({
      prompt: "# Build agent threads\n\nThis is a major feature.",
    });
    assert.equal(work.text, "Build agent threads");
  });

  it("truncates so one agent's brief cannot fill the directory", () => {
    const work = describeWork({ prompt: "x".repeat(500) });
    assert.ok(work.text.length <= 140, `got ${work.text.length} characters`);
    assert.ok(work.text.endsWith("…"));
  });
});

describe("the directory an agent reads", () => {
  const entries: DirectoryEntry[] = [
    {
      id: "hey-837",
      branch: "hey-837",
      status: "running",
      reachable: true,
      dnd: false,
      working: "Fix the auth bug",
      workingFrom: "prompt",
      threads: ["t-4f2a"],
      waiting: 0,
    },
    {
      id: "hey-838",
      branch: "hey-838-rate-limit",
      status: "idle",
      reachable: false,
      unreachable: "do not disturb: mid-migration — held in the buffer",
      dnd: true,
      dndReason: "mid-migration",
      working: "Add rate limiting",
      workingFrom: "history",
      threads: ["t-4f2a"],
      waiting: 2,
    },
  ];

  it("says of every agent whether it can be reached, and why not", () => {
    const out = formatDirectory(entries, PLAIN);
    assert.ok(out.includes("hey-837"));
    assert.ok(out.includes("reach:   yes"));
    assert.ok(
      out.includes("do not disturb: mid-migration"),
      "an agent deciding who to ask has to see why the answer would not come",
    );
  });

  it("shows what each one is working on and where that came from", () => {
    const out = formatDirectory(entries, PLAIN);
    assert.ok(out.includes("Fix the auth bug"));
    assert.ok(out.includes("(prompt)"));
    assert.ok(out.includes("Add rate limiting"));
    assert.ok(out.includes("(history)"));
  });

  it("shows which threads an agent is in and how much it has not seen", () => {
    const out = formatDirectory(entries, PLAIN);
    assert.ok(out.includes("t-4f2a"));
    assert.ok(out.includes("2 unseen"));
  });

  it("is machine-readable, with the reach reason intact", () => {
    // An agent reads this to pick who to contact, so the fields have to be
    // parseable rather than only pretty.
    const parsed = JSON.parse(directoryJson(entries));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, "hey-837");
    assert.equal(parsed[1].reachable, false);
    assert.equal(parsed[1].dnd, true);
    assert.equal(parsed[1].dndReason, "mid-migration");
    assert.equal(parsed[1].waiting, 2);
    assert.deepEqual(parsed[1].threads, ["t-4f2a"]);
  });

  it("tells a reader what to do when nothing is running", () => {
    assert.ok(formatDirectory([], PLAIN).includes("dispatch run"));
    assert.equal(directoryJson([]), "[]");
  });
});
