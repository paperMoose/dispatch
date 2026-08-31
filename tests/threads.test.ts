// The shared buffer several agents confer in, and the rules that decide who a
// post is typed into.
//
// Everything here asserts on what ends up in the buffer file and what a pane
// was actually handed. Delivery takes its transport as an argument, so a fake
// one records the text each agent received — the recipient's pane content is
// the outcome that matters, and "the writer was called" is not the same claim.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  addMembers,
  appendPost,
  catchUpText,
  createThread,
  deliveryText,
  isValidThreadId,
  listThreads,
  nextHops,
  parseMentions,
  pendingFor,
  readThread,
  recipientsFor,
  recordDelivery,
  type Thread,
  type ThreadMeta,
  type ThreadPost,
} from "../src/threads.js";
import { deliverPost, type DeliveryDeps } from "../src/commands.js";

function store(): string {
  return mkdtempSync(join(tmpdir(), "dispatch-threads-"));
}

/** Post and read back, so every test works against the file rather than the
 *  object it just built. */
function post(dir: string, id: string, from: string, text: string, to?: string[]): ThreadPost {
  const t = readThread(dir, id)!;
  return appendPost(dir, t, { from, text, ...(to ? { to } : {}) });
}

function lines(dir: string, id: string): string[] {
  return readFileSync(join(dir, `${id}.jsonl`), "utf-8").split("\n").filter((l) => l.trim());
}

/** A transport that records what each pane was handed, and can refuse to
 *  reach an agent the way a real exited or do-not-disturb one is refused. */
function fakePanes(unreachable: Record<string, string> = {}) {
  const wrote: { id: string; text: string }[] = [];
  const deps: DeliveryDeps = {
    reach: (id) => (unreachable[id] ? { ok: false, why: unreachable[id] } : { ok: true, why: "" }),
    write: (id, text) => {
      wrote.push({ id, text });
    },
  };
  return { deps, wrote, to: (id: string) => wrote.filter((w) => w.id === id) };
}

describe("the thread buffer", () => {
  it("is self-describing: the file alone names its members", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], topic: "auth", id: "t-one" });

    // Nothing but the file: an agent handed only the id can read the thread.
    const first = JSON.parse(lines(dir, "t-one")[0]);
    assert.deepEqual(first.meta.members, ["alpha", "bravo"]);
    assert.equal(first.meta.topic, "auth");
  });

  it("keeps every post, in the order they were made", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-two" });
    post(dir, "t-two", "alpha", "first");
    post(dir, "t-two", "bravo", "second");
    post(dir, "t-two", "alpha", "third");

    assert.deepEqual(
      readThread(dir, "t-two")!.posts.map((p) => p.text),
      ["first", "second", "third"],
    );
  });

  it("survives a malformed line without losing the conversation", () => {
    // A process killed mid-append leaves a half-written line. Every post
    // either side of it must still be readable, or one crash silently ends a
    // conversation that is still on everyone's screen.
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-three" });
    post(dir, "t-three", "alpha", "before the corruption");
    appendFileSync(join(dir, "t-three.jsonl"), '{"post":{"from":"alpha","tex\n');
    post(dir, "t-three", "bravo", "after the corruption");

    const t = readThread(dir, "t-three")!;
    assert.deepEqual(
      t.posts.map((p) => p.text),
      ["before the corruption", "after the corruption"],
    );
    assert.deepEqual(t.meta.members, ["alpha", "bravo"]);
  });

  it("adds a member by appending, and the newest list wins", () => {
    const dir = store();
    createThread(dir, { members: ["alpha"], id: "t-four" });
    post(dir, "t-four", "alpha", "hello");
    const next = addMembers(dir, "t-four", ["bravo"]);

    assert.deepEqual(next, ["alpha", "bravo"]);
    assert.deepEqual(readThread(dir, "t-four")!.meta.members, ["alpha", "bravo"]);
    // The history is not rewritten, so a member joining late reads all of it.
    assert.equal(readThread(dir, "t-four")!.posts.length, 1);
  });

  it("rejects a thread id that could climb out of the directory", () => {
    assert.equal(isValidThreadId("../../etc/passwd"), false);
    assert.equal(isValidThreadId("t-4f2a"), true);
    assert.throws(() => createThread(store(), { members: ["a"], id: "../escape" }));
  });

  it("lists threads newest first", () => {
    const dir = store();
    createThread(dir, { members: ["alpha"], id: "t-old" });
    createThread(dir, { members: ["bravo"], id: "t-new" });
    const ids = listThreads(dir).map((t) => t.meta.id);
    assert.deepEqual(ids.sort(), ["t-new", "t-old"]);
  });
});

describe("who a post is addressed to", () => {
  const meta: ThreadMeta = {
    id: "t-x",
    topic: "",
    members: ["alpha", "bravo", "charlie"],
    created: "",
    maxHops: 12,
    joinedAfter: {},
  };

  it("never sends a post back to its author", () => {
    // A thread of two where the author is a recipient is a loop by
    // construction: every delivery provokes a reply that is delivered again.
    assert.deepEqual(recipientsFor(meta, "alpha", undefined), ["bravo", "charlie"]);
  });

  it("addresses only the mentioned members when there are mentions", () => {
    const mentioned = parseMentions("@charlie does this hit you?");
    assert.deepEqual(mentioned, ["charlie"]);
    assert.deepEqual(recipientsFor(meta, "alpha", mentioned), ["charlie"]);
  });

  it("drops the author from an addressed list that names them", () => {
    assert.deepEqual(recipientsFor(meta, "alpha", ["alpha", "bravo"]), ["bravo"]);
  });
});

describe("reply chains", () => {
  it("starts at zero for someone nobody was talking to", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-h1" });
    assert.equal(post(dir, "t-h1", "alpha", "opening").hops, 0);
  });

  it("counts one hop per reply to something that was delivered", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-h2" });
    const first = post(dir, "t-h2", "alpha", "one");
    recordDelivery(dir, "t-h2", { post: first.id, delivered: ["bravo"], undelivered: [] });

    const reply = post(dir, "t-h2", "bravo", "two");
    assert.equal(reply.hops, 1, "a reply to a delivered post is one hop deeper");

    recordDelivery(dir, "t-h2", { post: reply.id, delivered: ["alpha"], undelivered: [] });
    assert.equal(post(dir, "t-h2", "alpha", "three").hops, 2);
  });

  it("resets when someone who was not delivered to speaks", () => {
    // This is how a person breaks a stalled thread: a human is not a pane, is
    // never delivered to, and so starts a fresh chain rather than inheriting
    // the depth of the one that stalled.
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-h3" });
    const a = post(dir, "t-h3", "alpha", "one");
    recordDelivery(dir, "t-h3", { post: a.id, delivered: ["bravo"], undelivered: [] });
    const b = post(dir, "t-h3", "bravo", "two");
    recordDelivery(dir, "t-h3", { post: b.id, delivered: ["alpha"], undelivered: [] });

    assert.equal(post(dir, "t-h3", "human", "stop and do this instead").hops, 0);
  });

  it("takes the depth of the last thing the sender was told, not the deepest", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-h4" });
    const deep = post(dir, "t-h4", "alpha", "deep");
    // Pretend this one already sat far down a chain.
    appendFileSync(
      join(dir, "t-h4.jsonl"),
      JSON.stringify({ post: { ...deep, id: "deadbeef", hops: 9, text: "older and deeper" } }) + "\n",
    );
    recordDelivery(dir, "t-h4", { post: "deadbeef", delivered: ["bravo"], undelivered: [] });
    const shallow = post(dir, "t-h4", "alpha", "a new subject");
    recordDelivery(dir, "t-h4", { post: shallow.id, delivered: ["bravo"], undelivered: [] });

    const t: Thread = readThread(dir, "t-h4")!;
    assert.equal(nextHops(t, "bravo"), 1, "the chain follows the most recent delivery");
  });
});

describe("what a member has not seen", () => {
  it("is pending until a delivery record says it landed", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-p1" });
    const p = post(dir, "t-p1", "alpha", "did you see this");

    assert.deepEqual(
      pendingFor(readThread(dir, "t-p1")!, "bravo").map((x) => x.text),
      ["did you see this"],
    );

    recordDelivery(dir, "t-p1", { post: p.id, delivered: ["bravo"], undelivered: [] });
    assert.deepEqual(pendingFor(readThread(dir, "t-p1")!, "bravo"), []);
  });

  it("does not include posts addressed to somebody else", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo", "charlie"], id: "t-p2" });
    post(dir, "t-p2", "alpha", "@charlie only you", ["charlie"]);

    assert.deepEqual(pendingFor(readThread(dir, "t-p2")!, "bravo"), []);
    assert.equal(pendingFor(readThread(dir, "t-p2")!, "charlie").length, 1);
  });

  it("does not owe a late-joining member the backlog", () => {
    // Otherwise joining a thread means arriving with every earlier post
    // unread, and coming off do-not-disturb types all of it into the pane.
    // A new member reads the history the way anyone does: thread read.
    const dir = store();
    createThread(dir, { members: ["alpha"], id: "t-p5" });
    post(dir, "t-p5", "alpha", "said before charlie was here");
    addMembers(dir, "t-p5", ["charlie"]);

    assert.deepEqual(pendingFor(readThread(dir, "t-p5")!, "charlie"), []);

    post(dir, "t-p5", "alpha", "said after charlie joined");
    assert.deepEqual(
      pendingFor(readThread(dir, "t-p5")!, "charlie").map((p) => p.text),
      ["said after charlie joined"],
    );
  });

  it("never counts a post against its own author", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-p3" });
    post(dir, "t-p3", "alpha", "mine");
    assert.deepEqual(pendingFor(readThread(dir, "t-p3")!, "alpha"), []);
  });

  it("carries the missed text itself into the catch-up, not a pointer to it", () => {
    const dir = store();
    const meta = createThread(dir, { members: ["alpha", "bravo"], id: "t-p4" });
    post(dir, "t-p4", "alpha", "the migration is running");
    post(dir, "t-p4", "alpha", "it finished, you can start");

    const text = catchUpText(meta, pendingFor(readThread(dir, "t-p4")!, "bravo"), "bravo");
    assert.ok(text.includes("the migration is running"));
    assert.ok(text.includes("it finished, you can start"));
    assert.ok(text.includes("dispatch thread post t-p4 --from bravo"));
  });
});

describe("delivering a post to panes", () => {
  const meta: ThreadMeta = {
    id: "t-d",
    topic: "auth",
    members: ["alpha", "bravo", "charlie"],
    created: "",
    maxHops: 12,
    joinedAfter: {},
  };
  const made = (over: Partial<ThreadPost> = {}): ThreadPost => ({
    id: "p1",
    ts: "2026-08-31T00:00:00.000Z",
    from: "alpha",
    text: "I am changing session.ts",
    hops: 0,
    ...over,
  });

  it("types the post into the others' panes and never the author's", () => {
    const panes = fakePanes();
    const out = deliverPost(meta, made(), panes.deps);

    assert.deepEqual(out.delivered, ["bravo", "charlie"]);
    assert.deepEqual(panes.to("alpha"), [], "the author's own pane must stay untouched");
    assert.ok(panes.to("bravo")[0].text.includes("I am changing session.ts"));
  });

  it("hands each recipient the thread id and the command to answer with", () => {
    const panes = fakePanes();
    deliverPost(meta, made(), panes.deps);
    const got = panes.to("charlie")[0].text;

    assert.ok(got.includes("t-d"), "the pane must carry the thread id");
    assert.ok(
      got.includes("dispatch thread post t-d --from charlie"),
      "and the exact command that reaches the others, addressed as this recipient",
    );
  });

  it("still reaches the others when one member has exited, and says who was missed", () => {
    const panes = fakePanes({ bravo: "not running — nothing reaches it until 'dispatch resume bravo'" });
    const out = deliverPost(meta, made(), panes.deps);

    assert.deepEqual(out.delivered, ["charlie"], "one dead member must not stop the thread");
    assert.deepEqual(out.undelivered.map((u) => u.id), ["bravo"]);
    assert.ok(out.undelivered[0].why.includes("dispatch resume bravo"));
    assert.deepEqual(panes.to("bravo"), []);
  });

  it("writes to nobody once a reply chain is past its hop limit", () => {
    // The cycle brake. The agent making this reply cannot tell it is in a
    // loop, so the stop has to happen here, at delivery.
    const panes = fakePanes();
    const out = deliverPost({ ...meta, maxHops: 3 }, made({ hops: 4 }), panes.deps);

    assert.deepEqual(panes.wrote, [], "a capped chain must wake nobody up");
    assert.deepEqual(out.delivered, []);
    assert.deepEqual(out.undelivered.map((u) => u.id), ["bravo", "charlie"]);
    assert.ok(out.undelivered[0].why.includes("hop limit"));
  });

  it("delivers right up to the limit", () => {
    const panes = fakePanes();
    const out = deliverPost({ ...meta, maxHops: 3 }, made({ hops: 3 }), panes.deps);
    assert.deepEqual(out.delivered, ["bravo", "charlie"]);
  });

  it("reports a pane that threw rather than losing the recipient", () => {
    const wrote: string[] = [];
    const deps: DeliveryDeps = {
      reach: () => ({ ok: true, why: "" }),
      write: (id) => {
        if (id === "bravo") throw new Error("tmux: no such session");
        wrote.push(id);
      },
    };
    const out = deliverPost(meta, made(), deps);

    assert.deepEqual(wrote, ["charlie"]);
    assert.deepEqual(out.undelivered.map((u) => u.id), ["bravo"]);
    assert.ok(out.undelivered[0].why.includes("no such session"));
  });

  it("tells each recipient how far the chain can still run", () => {
    const panes = fakePanes();
    deliverPost({ ...meta, maxHops: 12 }, made({ hops: 4 }), panes.deps);
    assert.ok(
      panes.to("bravo")[0].text.includes("Reply 5 of at most 12"),
      "an agent should know the thread is bounded before it answers",
    );
  });
});

describe("deliveryText", () => {
  it("names the other members so a recipient knows who is listening", () => {
    const meta: ThreadMeta = {
      id: "t-n",
      topic: "",
      members: ["alpha", "bravo", "charlie"],
      created: "",
      maxHops: 12,
    };
    const text = deliveryText(meta, {
      id: "p", ts: "", from: "alpha", text: "hi", hops: 0,
    }, "bravo");
    assert.ok(text.includes("alpha, charlie"));
  });
});
