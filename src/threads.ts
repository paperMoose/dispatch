import {
  existsSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { gitRoot } from "./shell.js";

/** Shared message buffers so several agents can confer.
 *
 *  One thread is one append-only JSONL file. Every post is delivered to the
 *  other members' panes carrying the thread id, which is the only thing an
 *  agent needs to reply — it does not have to know who else is listening, and
 *  a member added later reads the whole history from the same file.
 *
 *  Append-only on purpose: two agents posting at the same moment both land,
 *  because a single `appendFileSync` under the pipe buffer is atomic. A
 *  read-modify-write store would lose one of them silently, which is the
 *  failure this buffer exists to avoid.
 *
 *  Three record kinds share the file, each on its own line:
 *    {"meta":...}      the thread's members and limits; the last one wins, so
 *                      adding a member is an append rather than a rewrite
 *    {"post":...}      something someone said
 *    {"delivery":...}  who that post actually reached
 *
 *  The delivery record is what makes "nothing said is lost" checkable. A post
 *  to an agent on do-not-disturb, or one past the hop limit, still lands in
 *  the buffer but reaches no pane; without a record of that, the buffer cannot
 *  tell the difference between a post someone read and one they never saw, and
 *  the agent coming back from do-not-disturb has no way to catch up.
 *
 *  Every function takes the threads directory explicitly. The default lives in
 *  `threadsDir()` and is resolved once per command, which keeps the store
 *  testable against a temp directory without a git repository or an env var. */

const THREADS_DIR = ".dispatch-threads";

/** How far a chain of replies runs before it stops being delivered.
 *
 *  This is the cycle brake. Two agents answering each other politely will do
 *  so forever — each reply is a reasonable response to the last — and neither
 *  is doing anything wrong, so nothing else in the system stops them. A hop is
 *  a post whose author had just been delivered a post in this thread; a post
 *  from someone who was not waiting on one (a human stepping in, or an agent
 *  opening a subject) starts a fresh chain at zero. */
export const DEFAULT_MAX_HOPS = 12;

export interface ThreadPost {
  /** Random, so a delivery record can name a post without an index that
   *  concurrent appends would shift. */
  id: string;
  ts: string;
  from: string;
  text: string;
  /** Members the sender addressed. Empty means everyone in the thread. */
  to?: string[];
  /** Replies deep this post sits in an unbroken chain. See DEFAULT_MAX_HOPS. */
  hops: number;
}

export interface ThreadMeta {
  id: string;
  topic: string;
  members: string[];
  created: string;
  maxHops: number;
  /** How many posts the thread already held when each member joined.
   *
   *  A member added on the tenth post was not a recipient of the first nine,
   *  so those are not owed to them — without this, joining a thread reads as
   *  arriving with the entire backlog unread, and coming off do-not-disturb
   *  would type all of it into their pane. They read the history the way
   *  anyone does: `dispatch thread read`.
   *
   *  A count rather than a timestamp: posts are only ever appended, so the
   *  count is exact, where two clock readings in the same millisecond are not
   *  ordered at all. */
  joinedAfter: Record<string, number>;
}

/** What a post actually reached. `undelivered` covers every reason a member's
 *  pane was not written to — exited, headless, on do-not-disturb, over the hop
 *  limit — because to a reader of the buffer they are the same fact: this
 *  member has not seen this yet. */
export interface DeliveryRecord {
  post: string;
  ts: string;
  delivered: string[];
  undelivered: { id: string; why: string }[];
}

export interface Thread {
  meta: ThreadMeta;
  posts: ThreadPost[];
  deliveries: DeliveryRecord[];
}

export function threadsDir(): string {
  return join(gitRoot(), THREADS_DIR);
}

function threadFile(dir: string, id: string): string {
  return join(dir, `${id}.jsonl`);
}

/** Reject anything that could climb out of the threads directory. Thread ids
 *  arrive from agent-typed commands, so this is untrusted input on a path. */
export function isValidThreadId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/** Same shape as an agent id, which is a slug of the branch name. Applied to
 *  members so a typo becomes an error at `thread new` rather than a post that
 *  is delivered to nobody and reported as fine. */
export function isValidMemberId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id);
}

export function threadExists(dir: string, id: string): boolean {
  return isValidThreadId(id) && existsSync(threadFile(dir, id));
}

/** Create a thread and return its metadata. The first line is the metadata
 *  record, so a thread file is self-describing — reading it needs no side
 *  table, and an agent handed only the id can reconstruct the membership. */
export function createThread(
  dir: string,
  opts: { members: string[]; topic?: string; id?: string; maxHops?: number },
): ThreadMeta {
  const id = opts.id || `t-${randomBytes(3).toString("hex")}`;
  if (!isValidThreadId(id)) throw new Error(`Invalid thread id: ${id}`);
  const members = dedupe(opts.members);
  for (const m of members) {
    if (!isValidMemberId(m)) throw new Error(`Invalid agent id: ${m}`);
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const created = new Date().toISOString();
  const meta: ThreadMeta = {
    id,
    topic: opts.topic || "",
    members,
    created,
    maxHops: opts.maxHops ?? DEFAULT_MAX_HOPS,
    joinedAfter: Object.fromEntries(members.map((m) => [m, 0])),
  };
  writeFileSync(threadFile(dir, id), JSON.stringify({ meta }) + "\n", {
    mode: 0o600,
  });
  return meta;
}

export function readThread(dir: string, id: string): Thread | null {
  if (!threadExists(dir, id)) return null;
  const lines = readFileSync(threadFile(dir, id), "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  let meta: ThreadMeta | null = null;
  const posts: ThreadPost[] = [];
  const deliveries: DeliveryRecord[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      // A later meta line supersedes the first: that is how a member joins
      // without the file being rewritten under a concurrent append.
      if (rec.meta)
        meta = {
          ...rec.meta,
          maxHops: rec.meta.maxHops ?? DEFAULT_MAX_HOPS,
          joinedAfter: rec.meta.joinedAfter ?? {},
        };
      else if (rec.post) posts.push(rec.post);
      else if (rec.delivery) deliveries.push(rec.delivery);
    } catch {
      // One malformed line must not hide the rest of the conversation. A
      // half-written append (the process died mid-write) would otherwise take
      // the whole thread with it.
    }
  }
  return meta ? { meta, posts, deliveries } : null;
}

/** Append a post and return it, with the id and hop count filled in. Written
 *  before any delivery is attempted: the buffer is the record, and a delivery
 *  that fails must not also lose what was said. */
export function appendPost(
  dir: string,
  thread: Thread,
  post: { from: string; text: string; to?: string[] },
): ThreadPost {
  const full: ThreadPost = {
    id: randomBytes(4).toString("hex"),
    ts: new Date().toISOString(),
    from: post.from,
    text: post.text,
    ...(post.to && post.to.length ? { to: post.to } : {}),
    hops: nextHops(thread, post.from),
  };
  appendFileSync(threadFile(dir, thread.meta.id), JSON.stringify({ post: full }) + "\n");
  return full;
}

export function recordDelivery(
  dir: string,
  id: string,
  rec: Omit<DeliveryRecord, "ts">,
): void {
  appendFileSync(
    threadFile(dir, id),
    JSON.stringify({ delivery: { ...rec, ts: new Date().toISOString() } }) + "\n",
  );
}

/** Add members that are not already in the thread; returns the new full list. */
export function addMembers(dir: string, id: string, members: string[]): string[] {
  const t = readThread(dir, id);
  if (!t) throw new Error(`No such thread: ${id}`);
  for (const m of members) {
    if (!isValidMemberId(m)) throw new Error(`Invalid agent id: ${m}`);
  }
  const next = dedupe([...t.meta.members, ...members]);
  const joinedAfter = { ...t.meta.joinedAfter };
  for (const m of next) joinedAfter[m] = joinedAfter[m] ?? t.posts.length;
  appendFileSync(
    threadFile(dir, id),
    JSON.stringify({ meta: { ...t.meta, members: next, joinedAfter } }) + "\n",
  );
  return next;
}

export function listThreads(dir: string): Thread[] {
  if (!existsSync(dir)) return [];
  const out: Thread[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const t = readThread(dir, f.replace(/\.jsonl$/, ""));
    if (t) out.push(t);
  }
  return out.sort((a, b) => b.meta.created.localeCompare(a.meta.created));
}

/** Who a post goes to: the addressed members if any were named, otherwise
 *  everyone else in the thread. The sender is never a recipient — delivering
 *  a post back to its author is how a two-agent thread becomes a loop. */
export function recipientsFor(
  meta: ThreadMeta,
  from: string,
  to: string[] | undefined,
): string[] {
  const addressed = to && to.length ? to : meta.members;
  return dedupe(addressed).filter((m) => m !== from);
}

/** How deep in a reply chain a post from `from` sits.
 *
 *  One more than the last post actually delivered to them, because that is the
 *  post they are answering — an agent replies to what it was just told. Nobody
 *  told them anything, so this starts a chain rather than continuing one:
 *  zero. That is what lets a human break a stalled ping-pong by posting, since
 *  a human is not a pane and is never delivered to. */
export function nextHops(t: Thread, from: string): number {
  const reached = new Set(
    t.deliveries.flatMap((d) => (d.delivered.includes(from) ? [d.post] : [])),
  );
  for (let i = t.posts.length - 1; i >= 0; i--) {
    if (reached.has(t.posts[i].id)) return t.posts[i].hops + 1;
  }
  return 0;
}

/** Posts a member should have seen and has not: they were a recipient, and no
 *  delivery record puts them among the delivered. This is the queue behind
 *  do-not-disturb — the buffer holds everything, and this is how the agent
 *  finds out what arrived while it was not listening. */
export function pendingFor(t: Thread, agent: string): ThreadPost[] {
  const got = new Set(
    t.deliveries.flatMap((d) => (d.delivered.includes(agent) ? [d.post] : [])),
  );
  const from = t.meta.joinedAfter?.[agent] ?? 0;
  return t.posts.filter(
    (p, i) =>
      i >= from &&
      !got.has(p.id) &&
      recipientsFor(t.meta, p.from, p.to).includes(agent),
  );
}

/** The line an agent sees in its pane. It carries the thread id and the exact
 *  command to answer with, because an agent that has to guess the syntax
 *  answers into its own transcript where nobody else can read it. */
export function deliveryText(
  meta: ThreadMeta,
  post: ThreadPost,
  recipient: string,
): string {
  const others = meta.members.filter((m) => m !== recipient);
  return (
    `[thread ${meta.id}${meta.topic ? `: ${meta.topic}` : ""}] ${post.from} says:\n\n` +
    `${post.text}\n\n` +
    `Reply to everyone in this thread with:\n` +
    `  dispatch thread post ${meta.id} --from ${recipient} "your reply"\n` +
    `Read the whole conversation with:\n` +
    `  dispatch thread read ${meta.id}\n` +
    `Also in this thread: ${others.length ? others.join(", ") : "(nobody else yet)"}. ` +
    `Reply ${post.hops + 1} of at most ${meta.maxHops} before the thread stops ` +
    `delivering and a human has to step in, so answer only if you have something ` +
    `to add. Do not answer in your own transcript — a reply only reaches them ` +
    `through the command above.`
  );
}

/** Everything a member missed, as one message.
 *
 *  Sent when do-not-disturb is lifted. It carries the posts themselves rather
 *  than a pointer to them: `sendToPane` already hands a long message over as a
 *  file, so there is no size reason to make the agent go and fetch what it
 *  missed, and a summary it has to act on is a summary it can ignore. */
export function catchUpText(meta: ThreadMeta, posts: ThreadPost[], recipient: string): string {
  const body = posts
    .map((p) => `${p.from} (${p.ts})${p.to?.length ? ` → ${p.to.join(", ")}` : ""}:\n${p.text}`)
    .join("\n\n---\n\n");
  return (
    `[thread ${meta.id}${meta.topic ? `: ${meta.topic}` : ""}] ` +
    `${posts.length} message${posts.length === 1 ? "" : "s"} arrived while you were ` +
    `on do-not-disturb:\n\n${body}\n\n` +
    `Reply with:\n  dispatch thread post ${meta.id} --from ${recipient} "your reply"\n` +
    `Read the whole conversation with:\n  dispatch thread read ${meta.id}`
  );
}

/** Extract @mentions so a human or agent can address part of a thread. */
export function parseMentions(text: string): string[] {
  const found = text.match(/@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g) || [];
  return dedupe(found.map((m) => m.slice(1)));
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim()).map((x) => x.trim()))];
}
