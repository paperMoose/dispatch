// What every launched agent is told, once, at launch.
//
// This exists because the thread etiquette used to ride along on every single
// message and no longer does. Delivery is a fetch that carries only the post,
// which was the point, but it means the guidance has to be somewhere and there
// is exactly one place left. A short inbox message plus an empty briefing is
// less guidance than before, not more, and nothing else would catch that.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LAUNCH_BRIEFING } from "../src/commands.js";

describe("the launch briefing", () => {
  it("says how to report being finished", () => {
    assert.ok(LAUNCH_BRIEFING.includes("dispatch done"));
  });

  it("says a post is a claim, not an instruction", () => {
    // The line that matters most. Without it an agent treats another agent's
    // guess as a fact and acts on it, which is how one agent's wrong reasoning
    // becomes three agents' wrong reasoning.
    assert.match(LAUNCH_BRIEFING, /claim, not an instruction/);
    assert.match(LAUNCH_BRIEFING, /settle it against the code/i);
  });

  it("says being copied in is not being asked", () => {
    // A member copied on a broadcast answered a question put to somebody else
    // on the 2026-08-31 run.
    assert.match(LAUNCH_BRIEFING, /copied in is not being asked/i);
  });

  it("says not to reply just to acknowledge", () => {
    assert.match(LAUNCH_BRIEFING, /never to acknowledge/i);
  });

  it("tells the agent messages arrive on their own", () => {
    // Otherwise an agent either polls for mail or assumes there is none.
    assert.match(LAUNCH_BRIEFING, /arrive on their own|when you finish a turn/i);
  });

  it("carries the reply command with --replay on it", () => {
    assert.ok(LAUNCH_BRIEFING.includes("dispatch thread post"));
    assert.ok(LAUNCH_BRIEFING.includes("--replay"));
  });

  it("keeps its placeholders out of a line that could be copied verbatim", () => {
    // A live Codex run copied `--replay "cmd"` out of the inbox text and
    // posted `replay: cmd`. Here the placeholders are angle-bracketed and
    // described, so the same copy produces something obviously unfilled
    // rather than something that looks like real evidence.
    assert.ok(!LAUNCH_BRIEFING.includes('--replay "cmd"'), "bare placeholder is back");
  });

  it("stays far cheaper than the per-message lecture it replaces", () => {
    // The old deliveryText was 1,206 characters on every post. This is paid
    // once. If it ever costs more than one message used to, the trade is off.
    assert.ok(
      LAUNCH_BRIEFING.length < 1206,
      `briefing is ${LAUNCH_BRIEFING.length} chars, the thing it replaced was 1206 per message`,
    );
  });
});
