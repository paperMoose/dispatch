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

/** What `deliverPost` records when a recipient could not be written to. A
 *  post only becomes owed once a miss is on record, so tests that want a
 *  pending post have to go through this, exactly as production does. */
function held(dir: string, threadId: string, postId: string, who: string): void {
  recordDelivery(dir, threadId, {
    post: postId,
    delivered: [],
    undelivered: [{ id: who, why: "do not disturb: mid-migration" }],
  });
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

  it("keeps the experiment with the claim, for anyone reading later", () => {
    // The thread is the record. A conclusion is worth much less six hours
    // later than the command that reproduces it.
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-rep" });
    const t = readThread(dir, "t-rep")!;
    appendPost(dir, t, {
      from: "alpha",
      text: "3 hits, so your refactor collides with mine",
      replay: "rg -n 'newHelper' src/session.ts",
    });
    assert.equal(
      readThread(dir, "t-rep")!.posts[0].replay,
      "rg -n 'newHelper' src/session.ts",
    );
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
    held(dir, "t-p1", p.id, "bravo");

    assert.deepEqual(
      pendingFor(readThread(dir, "t-p1")!, "bravo").map((x) => x.text),
      ["did you see this"],
    );

    recordDelivery(dir, "t-p1", { post: p.id, delivered: ["bravo"], undelivered: [] });
    assert.deepEqual(pendingFor(readThread(dir, "t-p1")!, "bravo"), []);
  });

  it("does not owe a post whose delivery is still in flight", () => {
    // The duplicate-delivery bug, reproduced. A post is written before its
    // delivery is attempted, and sendToPane waits three seconds per recipient
    // before submitting. In that window the post exists with no delivery
    // record. A `dnd off` landing there used to deliver a second copy while
    // the first write was still going — observed 2026-08-31 in thread
    // s2-group, where carol got the same post typed into its pane twice.
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-flight" });
    post(dir, "t-flight", "alpha", "delivery has not been recorded yet");

    assert.deepEqual(
      pendingFor(readThread(dir, "t-flight")!, "bravo"),
      [],
      "a post nobody has reported missing is not owed to anybody",
    );
  });

  it("owes a post only once a delivery is recorded as missed", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo"], id: "t-missed" });
    const p = post(dir, "t-missed", "alpha", "held while bravo was quiet");
    recordDelivery(dir, "t-missed", {
      post: p.id,
      delivered: [],
      undelivered: [{ id: "bravo", why: "do not disturb: mid-migration" }],
    });

    assert.deepEqual(
      pendingFor(readThread(dir, "t-missed")!, "bravo").map((x) => x.text),
      ["held while bravo was quiet"],
    );
  });

  it("does not include posts addressed to somebody else", () => {
    const dir = store();
    createThread(dir, { members: ["alpha", "bravo", "charlie"], id: "t-p2" });
    const only = post(dir, "t-p2", "alpha", "@charlie only you", ["charlie"]);
    held(dir, "t-p2", only.id, "charlie");

    assert.deepEqual(pendingFor(readThread(dir, "t-p2")!, "bravo"), []);
    assert.equal(pendingFor(readThread(dir, "t-p2")!, "charlie").length, 1);
  });

  it("does not owe a late-joining member the backlog", () => {
    // Otherwise joining a thread means arriving with every earlier post
    // unread, and coming off do-not-disturb types all of it into the pane.
    // A new member reads the history the way anyone does: thread read.
    const dir = store();
    createThread(dir, { members: ["alpha"], id: "t-p5" });
    const before = post(dir, "t-p5", "alpha", "said before charlie was here");
    addMembers(dir, "t-p5", ["charlie"]);
    held(dir, "t-p5", before.id, "charlie");

    assert.deepEqual(pendingFor(readThread(dir, "t-p5")!, "charlie"), []);

    const after = post(dir, "t-p5", "alpha", "said after charlie joined");
    held(dir, "t-p5", after.id, "charlie");
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
    const one = post(dir, "t-p4", "alpha", "the migration is running");
    const two = post(dir, "t-p4", "alpha", "it finished, you can start");
    held(dir, "t-p4", one.id, "bravo");
    held(dir, "t-p4", two.id, "bravo");

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
  const meta: ThreadMeta = {
    id: "t-n",
    topic: "",
    members: ["alpha", "bravo", "charlie"],
    created: "",
    maxHops: 12,
    joinedAfter: {},
  };
  const text = deliveryText(meta, {
    id: "p", ts: "", from: "alpha", text: "hi", hops: 0,
  }, "bravo");

  it("names the other members so a recipient knows who is listening", () => {
    assert.ok(text.includes("alpha, charlie"));
  });

  it("tells a directly addressed recipient that it was asked", () => {
    const asked = deliveryText(
      meta,
      { id: "p", ts: "", from: "alpha", text: "hi", hops: 0, to: ["bravo"] },
      "bravo",
    );
    assert.match(asked, /put this to you directly/);
  });

  it("tells a copied-in recipient that it was not", () => {
    // The observed failure, 2026-08-31 thread s2-group: a post named two other
    // members, t2-alpha was copied on it, and t2-alpha answered — about a file
    // it did not own. Every recipient got identical text, so "delivered to me"
    // read as "asked of me".
    const copied = deliveryText(
      meta,
      { id: "p", ts: "", from: "alpha", text: "hi", hops: 0, to: ["charlie"] },
      "bravo",
    );
    assert.match(copied, /not to you/);
    assert.match(copied, /kept in the loop, not asked/);
  });

  it("treats a broadcast as keeping people informed, not as asking them", () => {
    // No `to` at all: everyone in the thread hears it, nobody was asked.
    assert.match(text, /kept in the loop, not asked/);
  });

  it("forbids repeating back what you were just told", () => {
    // The etiquette stopped "thanks" and "confirmed" but not agreeing at
    // length: in s1-factual an agent restated four identical grep hits it had
    // just been sent, and the chain ran two posts longer than it needed to.
    assert.match(text, /repeat back what you were/);
    assert.match(text, /interruption with extra steps/);
  });

  it("forbids the acknowledgement that turns a thread into a loop", () => {
    // Observed live on 2026-08-31: two agents settled a real question in two
    // hops, then spent hops 3, 4 and 5 on "Confirmed", "Correct", "Thanks".
    // The hop limit caps that; this text is what stops it starting. It is the
    // only instruction an agent reliably reads, because it arrives in the same
    // message as the thing it is deciding whether to answer.
    // Matched loosely on purpose: the rule is what must survive a rewrite of
    // the sentence, not the sentence.
    assert.match(text, /never[^.]*acknowledge/i);
    assert.match(text, /thank/i);
    assert.match(text, /blocked on them/);
  });

  it("hands over the experiment, so the reader can settle it instead of believing it", () => {
    // The point of the field: "session.ts imports the helper" has to be
    // trusted; "run this and you will see it does" can be checked. Two agents
    // trading beliefs converge on whoever is more certain, which is not the
    // same as whoever is right.
    const withReplay = deliveryText(
      meta,
      { id: "p", ts: "", from: "alpha", text: "it already imports the helper", hops: 0, replay: "rg -n newHelper src/session.ts" },
      "bravo",
    );
    assert.match(withReplay, /rg -n newHelper src\/session\.ts/);
    assert.match(withReplay, /Run it yourself before you act on it/);
  });

  it("says so plainly when a claim arrives with nothing to run", () => {
    // An unsupported claim is labelled as one. Silence here would let opinion
    // and evidence arrive looking identical.
    assert.match(text, /Nothing came with it that you can run/);
    assert.match(text, /opinion until you test it yourself/);
  });

  it("asks the reply to carry what was run and what was seen", () => {
    assert.match(text, /--replay/);
    assert.match(text, /what you ran and what you saw, not what you think/);
  });

  it("frames the post as a claim to check, not an instruction to follow", () => {
    // A message from another agent carries its confusion as readily as its
    // knowledge. Without this an agent adopts a wrong premise because it
    // arrived in its terminal, and one agent's bad reasoning becomes two.
    assert.match(text, /claim, not an instruction/);
    assert.match(text, /against the code/i);
  });
});
