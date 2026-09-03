// The one promise the hook makes to the runtime: it never fails.
//
// This runs the built CLI as a subprocess, because the thing under test is an
// exit code and a stream, and neither can be observed by calling a function.
// Skipped when dist is not built, so it never turns a fresh clone red.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CLI = join(process.cwd(), "dist", "cli.js");
const skip = existsSync(CLI) ? false : "dist/cli.js is not built";

const DIR = join(homedir(), ".dispatch", "threads");
const ID = "t-clitest-donotuse";
const FILE = join(DIR, `${ID}.jsonl`);

function seedOwed(): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    FILE,
    [
      `{"meta":{"id":"${ID}","topic":"t","members":["a","b"],"created":"2026-09-02T22:00:00Z","maxHops":12,"joinedAfter":{},"approved":true}}`,
      `{"post":{"id":"q1","from":"a","to":["b"],"text":"hello","ts":"2026-09-02T22:00:01Z","hops":0}}`,
      `{"delivery":{"post":"q1","delivered":[],"undelivered":[{"id":"b","why":"pane not ready"}],"ts":"2026-09-02T22:00:02Z"}}`,
      "",
    ].join("\n"),
  );
}

const run = () => spawnSync("node", [CLI, "thread", "inbox", "b", "--hook"], { encoding: "utf-8" });

describe("the hook never fails", { skip }, () => {
  it("exits 0 and still delivers when the buffer cannot be written", () => {
    // Measured before this was hardened: the hook wrote 296 bytes of valid
    // JSON and then exited 1. A failing hook that had already spoken, with
    // the delivery unrecorded, so the agent would be handed the same post
    // again on every future turn.
    seedOwed();
    chmodSync(FILE, 0o444);
    try {
      const r = run();
      assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.decision, "block");
      assert.ok(parsed.reason.includes("hello"), "the post must still arrive");
      assert.ok(
        parsed.reason.includes("could not record"),
        "the agent is about to see this again and should be told why",
      );
    } finally {
      chmodSync(FILE, 0o644);
      rmSync(FILE, { force: true });
    }
  });

  it("exits 0 on a truncated buffer rather than reporting a broken hook", () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, '{"meta":{"id":"x","members":["a","b"]}}\n{"post":{"id":"q1","tex\n');
    try {
      const r = run();
      assert.equal(r.status, 0, `exited ${r.status}: ${r.stderr}`);
    } finally {
      rmSync(FILE, { force: true });
    }
  });

  it("exits 0 and says nothing when there is no mail", () => {
    const r = run();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "a hook that speaks every turn gets turned off");
  });
});
