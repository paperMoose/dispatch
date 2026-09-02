// The pull half of thread delivery: what an agent is owed when it asks at its
// own turn boundary, and how that reads once it is in its context.
//
// Everything here is the decision of what to say, with no terminal involved.
// The pane-level half — that a hook actually fires and its output reaches a
// running agent — is a live loop-back test per multiplexer/runtime cell, and
// cannot be faked convincingly at this level.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hookJson,
  collectInbox,
  deliveredIds,
  inboxBody,
  isForRecipient,
  type InboxItem,
} from "../src/inbox.js";
import type { Thread, ThreadMeta, ThreadPost } from "../src/threads.js";

function meta(over: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    id: "t-4f2a",
    topic: "auth refactor",
    members: ["alice", "bob", "carol"],
    created: "2026-09-02T22:00:00Z",
    maxHops: 12,
    joinedAfter: {},
    ...over,
  } as ThreadMeta;
}

function post(over: Partial<ThreadPost> = {}): ThreadPost {
  return {
    id: "p1",
    from: "alice",
    to: ["bob"],
    text: "session.ts already imports the helper",
    ts: "2026-09-02T22:00:01Z",
    hops: 0,
    ...over,
  } as ThreadPost;
}

/** A thread where `p` has been attempted and missed by `who` — which is what
 *  production writes when a pane write fails, and the only state `pendingFor`
 *  treats as owed. Building it by hand is how four earlier tests ended up
 *  asserting the duplicate-delivery bug instead of the fix. */
function owed(m: ThreadMeta, posts: ThreadPost[], who: string): Thread {
  return {
    meta: m,
    posts,
    deliveries: posts.map((p) => ({
      post: p.id,
      delivered: [],
      undelivered: [{ id: who, why: "pane not ready" }],
      ts: "2026-09-02T22:00:02Z",
    })),
  } as Thread;
}

describe("what an agent is owed", () => {
  it("returns the posts waiting for it, per thread", () => {
    const t = owed(meta(), [post()], "bob");
    const got = collectInbox([t], "bob");
    assert.equal(got.length, 1);
    assert.equal(got[0].posts[0].id, "p1");
  });

  it("says nothing to an agent that is not in the thread", () => {
    // Addressed straight at a non-member, which is the case that bites:
    // `recipientsFor` honours an explicit `to` without checking membership
    // (src/threads.ts:325), so a typo'd id or an agent dropped from the
    // thread would otherwise be handed somebody else's mail. Membership is
    // checked here, and this is the only thing checking it.
    const t = owed(meta({ members: ["alice", "bob"] }), [post({ to: ["dave"] })], "dave");
    assert.deepEqual(collectInbox([t], "dave"), []);
  });

  it("says nothing when a post was already delivered", () => {
    const t: Thread = {
      meta: meta(),
      posts: [post()],
      deliveries: [{ post: "p1", delivered: ["bob"], undelivered: [], ts: "x" }],
    } as Thread;
    assert.deepEqual(collectInbox([t], "bob"), []);
  });

  it("never returns a post to its own author", () => {
    // The first cycle brake: a post that came back to the sender would be
    // answered, and answered again.
    const t = owed(meta(), [post({ from: "alice", to: ["bob"] })], "alice");
    assert.deepEqual(collectInbox([t], "alice"), []);
  });

  it("skips threads with nothing owed rather than emitting an empty block", () => {
    const quiet: Thread = { meta: meta({ id: "t-quiet" }), posts: [], deliveries: [] } as Thread;
    const loud = owed(meta(), [post()], "bob");
    const got = collectInbox([quiet, loud], "bob");
    assert.equal(got.length, 1);
    assert.equal(got[0].meta.id, "t-4f2a");
  });
});

describe("how it reads once injected", () => {
  const items = (): InboxItem[] => [{ meta: meta(), posts: [post()] }];

  it("is empty for an empty inbox, so a hook that fires every turn is silent", () => {
    // A hook that prints something on every turn is a hook that gets disabled.
    assert.equal(inboxBody([], "bob"), "");
  });

  it("carries the thread id, the sender and the message", () => {
    const out = inboxBody(items(), "bob");
    assert.ok(out.includes("t-4f2a"));
    assert.ok(out.includes("alice"));
    assert.ok(out.includes("session.ts already imports the helper"));
  });

  it("distinguishes being asked from being copied in", () => {
    // A member copied on a broadcast answered a question put to somebody else
    // on the 2026-08-31 run. Delivery knows which case this is, so it says.
    const addressed = inboxBody([{ meta: meta(), posts: [post({ to: ["bob"] })] }], "bob");
    const copied = inboxBody([{ meta: meta(), posts: [post({ to: ["carol"] })] }], "bob");
    assert.ok(addressed.includes("→ you"));
    assert.ok(copied.includes("→ the thread"));
  });

  it("passes the replay command through, and marks its absence", () => {
    const withReplay = inboxBody(
      [{ meta: meta(), posts: [post({ replay: "rg -n newHelper src/session.ts" })] }],
      "bob",
    );
    assert.ok(withReplay.includes("rg -n newHelper src/session.ts"));
    assert.ok(withReplay.includes("run it before acting"));
  });

  it("keeps its newlines, which a pane write could never do", () => {
    // sendToPane flattened every message to one line to get it past the tty.
    // This is the whole reason the pull path exists.
    const out = inboxBody([{ meta: meta(), posts: [post({ text: "line one\nline two" })] }], "bob");
    assert.ok(out.includes("line one\nline two"));
  });

  it("tells the agent how many replies are left before delivery stops", () => {
    const out = inboxBody([{ meta: meta(), posts: [post({ hops: 4 })] }], "bob");
    assert.ok(out.includes("reply 5 of 12"), out);
  });

  it("puts no placeholder inside the command it tells the agent to run", () => {
    // A live Codex run copied `--replay "cmd"` straight out of an earlier
    // version of this text and posted `replay: cmd`. A replay command nobody
    // can run is worse than no replay, because it is offered as evidence.
    // Whatever the agent has to substitute stays off the copyable line.
    const out = inboxBody([{ meta: meta(), posts: [post()] }], "bob");
    const cmdLine = out.split("\n").find((l) => l.includes("dispatch thread post"))!;
    assert.ok(cmdLine, "the reply command should be on its own line");
    assert.ok(!cmdLine.includes("--replay"), `placeholder is back on the command line: ${cmdLine}`);
    assert.ok(!/"cmd"|<[a-z ]+>/.test(cmdLine), `copyable placeholder in: ${cmdLine}`);
  });

  it("stays far shorter than the lecture it replaces", () => {
    // The old deliveryText was 1,206 characters of fixed etiquette per post,
    // roughly half the 2,500-byte pane budget, re-read on every delivery. The
    // etiquette now goes in once at launch. If this creeps back up, the
    // regression is silent everywhere else.
    const framing = inboxBody([{ meta: meta(), posts: [post({ text: "" })] }], "bob").length;
    assert.ok(framing < 400, `framing grew to ${framing} characters`);
  });
});

describe("the hook envelope", () => {
  it("is one shape both runtimes accept", () => {
    // Not what we expected going in. Claude's Stop hook also takes
    // hookSpecificOutput.additionalContext, but Codex's stop.command.output
    // schema sets additionalProperties:false and defines no Stop variant of
    // it, so that shape is rejected there. decision/block/reason is accepted
    // by both, and both were confirmed live against a nonce.
    const parsed = JSON.parse(hookJson("you have mail"));
    assert.equal(parsed.decision, "block");
    assert.equal(parsed.reason, "you have mail");
  });

  it("carries no field Codex would reject", () => {
    // additionalProperties:false means one stray key drops the whole message.
    const allowed = new Set([
      "continue", "decision", "reason", "stopReason", "suppressOutput", "systemMessage",
    ]);
    for (const k of Object.keys(JSON.parse(hookJson("x")))) {
      assert.ok(allowed.has(k), `${k} is not in Codex's stop.command.output schema`);
    }
  });

  it("survives quotes and newlines in a post", () => {
    // A post is agent-authored text going through a JSON envelope into another
    // agent's context. Anything that breaks the envelope drops the message.
    const nasty = 'he said "it\'s broken"\nthen: {"json": true}\\';
    const parsed = JSON.parse(hookJson(nasty));
    assert.equal(parsed.reason, nasty);
  });
});

describe("delivery accounting", () => {
  it("names exactly the posts that were rendered", () => {
    // Recording more than was emitted loses a message for good. That is the
    // failure this design exists to avoid, so the list comes from the rendered
    // items rather than from the thread.
    const got = deliveredIds([
      { meta: meta(), posts: [post({ id: "p1" }), post({ id: "p2" })] },
      { meta: meta({ id: "t-other" }), posts: [post({ id: "p9" })] },
    ]);
    assert.deepEqual(got, [
      { thread: "t-4f2a", post: "p1" },
      { thread: "t-4f2a", post: "p2" },
      { thread: "t-other", post: "p9" },
    ]);
  });

  it("records nothing for an empty inbox", () => {
    assert.deepEqual(deliveredIds([]), []);
  });
});

describe("nobody reads somebody else's mail", () => {
  it("holds for a directed post", () => {
    assert.equal(isForRecipient(meta(), post({ to: ["bob"] }), "bob"), true);
    assert.equal(isForRecipient(meta(), post({ to: ["bob"] }), "carol"), false);
  });

  it("holds for a broadcast, minus the author", () => {
    const p = post({ from: "alice", to: [] });
    assert.equal(isForRecipient(meta(), p, "bob"), true);
    assert.equal(isForRecipient(meta(), p, "alice"), false);
  });
});

describe("the latency budget the design depends on", () => {
  it("renders a thousand owed posts well inside the hook budget", () => {
    // Codex runs hooks synchronously and blocks until they return; cmux hit a
    // ~35s launch hang from a slow one. Gate 0 measured the whole hook at
    // 32ms p99 against a 200ms budget, dominated by process startup rather
    // than the thread. This asserts the part we own stays negligible, so a
    // regression here (a network call, a sync spawn) fails a test instead of
    // stalling every agent on every turn.
    const posts = Array.from({ length: 1000 }, (_, i) =>
      post({ id: `p${i}`, text: "x".repeat(280), replay: "rg -n foo src/" }),
    );
    const items: InboxItem[] = [{ meta: meta(), posts }];
    const t0 = performance.now();
    const body = inboxBody(items, "bob");
    hookJson(body);
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `rendering took ${ms.toFixed(1)}ms`);
  });
});
