// Noticing that an account hit a usage limit.
//
// The fixtures are real: two limits Ryan actually hit, lifted out of his own
// transcripts. That matters more than usual here, because the alternative was
// guessing at a string, and guessing at strings is what made agent readiness
// break twice in one day.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  findQuotaRejection,
  limitIsOver,
  parseQuotaRejection,
  resetsIn,
} from "../src/quota.js";

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), "tests", "fixtures", "transcripts", name), "utf-8").trim();

describe("reading a real limit out of a transcript", () => {
  it("recognises the five hour limit", () => {
    const hit = parseQuotaRejection(fixture("claude-limit-five-hour.jsonl"))!;
    assert.ok(hit, "the five hour fixture should parse");
    assert.equal(hit.kind, "five_hour");
    assert.ok(hit.resetsAt > 1_700_000_000, "resetsAt should be unix seconds");
    assert.match(hit.message, /session limit/i);
  });

  it("recognises the weekly limit, and tells it apart from the five hour one", () => {
    // The distinction is the whole point: a five hour limit is worth waiting
    // out, a weekly one means this account is gone until next week and cycling
    // must not come back to it.
    const hit = parseQuotaRejection(fixture("claude-limit-seven-day.jsonl"))!;
    assert.equal(hit.kind, "seven_day");
    assert.match(hit.message, /weekly limit/i);
  });
});

describe("what must NOT be mistaken for a limit", () => {
  it("ignores an agent merely talking about rate limits", () => {
    // 215 transcripts on this machine mention limits in prose; 47 carry the
    // structure. Detection keys on the structure, never the words.
    const chatter = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "We should handle the rate limit and quotaLimits here" }] },
    });
    assert.equal(parseQuotaRejection(chatter), null);
  });

  it("ignores a record whose status is not a rejection", () => {
    const allowed = JSON.stringify({ quotaLimits: { status: "allowed", resetsAt: 123, rateLimitType: "five_hour" } });
    assert.equal(parseQuotaRejection(allowed), null);
  });

  it("ignores a rejection with no reset time, rather than inventing one", () => {
    const broken = JSON.stringify({ quotaLimits: { status: "rejected", rateLimitType: "five_hour" } });
    assert.equal(parseQuotaRejection(broken), null);
  });

  it("ignores a line that is not JSON at all", () => {
    assert.equal(parseQuotaRejection("quotaLimits but not json {"), null);
  });

  it("ignores an ordinary line without the marker", () => {
    assert.equal(parseQuotaRejection('{"type":"assistant"}'), null);
  });
});

describe("scanning a transcript", () => {
  it("takes the newest rejection, not the first", () => {
    // An account limited earlier and cycled away from keeps that record
    // forever. Only the last one describes now.
    const old = JSON.stringify({ quotaLimits: { status: "rejected", resetsAt: 1000, rateLimitType: "five_hour" } });
    const recent = JSON.stringify({ quotaLimits: { status: "rejected", resetsAt: 2000, rateLimitType: "seven_day" } });
    const hit = findQuotaRejection([old, '{"type":"assistant"}', recent])!;
    assert.equal(hit.resetsAt, 2000);
    assert.equal(hit.kind, "seven_day");
  });

  it("says nothing for a healthy transcript", () => {
    assert.equal(findQuotaRejection(['{"type":"assistant"}', '{"type":"user"}']), null);
  });

  it("survives an empty transcript", () => {
    assert.equal(findQuotaRejection([]), null);
  });
});

describe("knowing when an account is usable again", () => {
  const limit = { kind: "five_hour", resetsAt: 1_788_215_400, message: "x" };

  it("is over once the reset time has passed", () => {
    assert.equal(limitIsOver(limit, 1_788_215_400 * 1000 + 1), true);
  });

  it("is not over a second before", () => {
    assert.equal(limitIsOver(limit, 1_788_215_400 * 1000 - 1000), false);
  });

  it("puts the wait in words a person can read", () => {
    assert.equal(resetsIn(limit, (limit.resetsAt - 90) * 1000), "2m");
    assert.equal(resetsIn(limit, (limit.resetsAt - 7200) * 1000), "2h");
    assert.equal(resetsIn(limit, (limit.resetsAt + 60) * 1000), "now");
  });
});
