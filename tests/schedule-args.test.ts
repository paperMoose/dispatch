import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseScheduleAddArgs } from "../src/commands.js";

describe("parseScheduleAddArgs", () => {
  it("parses a minimal cron-based schedule", () => {
    const out = parseScheduleAddArgs([
      "voice-check",
      "--cron", "0 9 * * 5",
      "--prompt-file", "/tmp/p.md",
    ]);
    assert.equal(out.name, "voice-check");
    assert.equal(out.cron, "0 9 * * 5");
    assert.equal(out.promptFile, "/tmp/p.md");
  });

  it("parses every supported flag", () => {
    const out = parseScheduleAddArgs([
      "rel",
      "--cron", "0 16 * * 5",
      "--prompt-file", "/p.md",
      "--branch-prefix", "rel",
      "--model", "opus",
      "--repo", "/repo",
      "--max-turns", "30",
      "--notify", "slack",
    ]);
    assert.equal(out.branchPrefix, "rel");
    assert.equal(out.model, "opus");
    assert.equal(out.repo, "/repo");
    assert.equal(out.maxTurns, "30");
    assert.equal(out.notify, "slack");
  });

  it("accepts --at instead of --cron", () => {
    const out = parseScheduleAddArgs([
      "one-off",
      "--at", "2099-01-01T00:00:00",
      "--prompt-file", "/p.md",
    ]);
    assert.equal(out.at, "2099-01-01T00:00:00");
    assert.equal(out.cron, undefined);
  });

  it("accepts --command instead of --prompt-file", () => {
    const out = parseScheduleAddArgs([
      "echo-test",
      "--cron", "* * * * *",
      "--command", 'echo "hello $(date)"',
    ]);
    assert.equal(out.command, 'echo "hello $(date)"');
    assert.equal(out.promptFile, undefined);
  });

  it("rejects missing name", () => {
    assert.throws(() => parseScheduleAddArgs(["--cron", "0 9 * * 5", "--prompt-file", "/p.md"]));
  });

  it("rejects multiple positional args", () => {
    assert.throws(() =>
      parseScheduleAddArgs(["a", "b", "--cron", "0 9 * * 5", "--prompt-file", "/p.md"]),
    );
  });

  it("rejects invalid name characters", () => {
    assert.throws(() =>
      parseScheduleAddArgs(["bad name", "--cron", "0 9 * * 5", "--prompt-file", "/p.md"]),
    );
    assert.throws(() =>
      parseScheduleAddArgs(["..bad", "--cron", "0 9 * * 5", "--prompt-file", "/p.md"]),
    );
  });

  it("requires either --cron or --at", () => {
    assert.throws(() => parseScheduleAddArgs(["x", "--prompt-file", "/p.md"]));
  });

  it("rejects both --cron and --at", () => {
    assert.throws(() =>
      parseScheduleAddArgs([
        "x",
        "--cron", "0 9 * * 5",
        "--at", "2099-01-01T00:00:00",
        "--prompt-file", "/p.md",
      ]),
    );
  });

  it("requires either --prompt-file or --command", () => {
    assert.throws(() => parseScheduleAddArgs(["x", "--cron", "0 9 * * 5"]));
  });

  it("rejects both --prompt-file and --command", () => {
    assert.throws(() =>
      parseScheduleAddArgs([
        "x",
        "--cron", "0 9 * * 5",
        "--prompt-file", "/p.md",
        "--command", "echo hi",
      ]),
    );
  });

  it("rejects unknown flags", () => {
    assert.throws(() =>
      parseScheduleAddArgs([
        "x",
        "--cron", "0 9 * * 5",
        "--prompt-file", "/p.md",
        "--bogus", "value",
      ]),
    );
  });

  it("accepts dot, underscore, hyphen in name", () => {
    const out = parseScheduleAddArgs([
      "voice.reliability_check-v2",
      "--cron", "0 9 * * 5",
      "--prompt-file", "/p.md",
    ]);
    assert.equal(out.name, "voice.reliability_check-v2");
  });
});
