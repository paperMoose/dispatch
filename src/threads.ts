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
 *  because `appendFileSync` on a single write under the pipe buffer is atomic.
 *  A read-modify-write store would lose one of them silently, which is the
 *  failure this buffer exists to avoid. */

const THREADS_DIR = ".dispatch-threads";

export interface ThreadPost {
  ts: string;
  from: string;
  text: string;
  /** Members the sender addressed. Empty means everyone in the thread. */
  to?: string[];
}

export interface ThreadMeta {
  id: string;
  topic: string;
  members: string[];
  created: string;
}

export function threadsDir(): string {
  return join(gitRoot(), THREADS_DIR);
}

function threadFile(id: string): string {
  return join(threadsDir(), `${id}.jsonl`);
}

/** Reject anything that could climb out of the threads directory. Thread ids
 *  arrive from agent-typed commands, so this is untrusted input on a path. */
export function isValidThreadId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

export function threadExists(id: string): boolean {
  return isValidThreadId(id) && existsSync(threadFile(id));
}

/** Create a thread and return its id. The first line is the metadata record,
 *  so a thread file is self-describing — reading it needs no side table. */
export function createThread(
  members: string[],
  topic: string,
  idOverride?: string,
): ThreadMeta {
  const id = idOverride || `t-${randomBytes(3).toString("hex")}`;
  if (!isValidThreadId(id)) throw new Error(`Invalid thread id: ${id}`);
  const dir = threadsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const meta: ThreadMeta = {
    id,
    topic,
    members: dedupe(members),
    created: new Date().toISOString(),
  };
  writeFileSync(threadFile(id), JSON.stringify({ meta }) + "\n", { mode: 0o600 });
  return meta;
}

export function readThread(id: string): { meta: ThreadMeta; posts: ThreadPost[] } | null {
  if (!threadExists(id)) return null;
  const lines = readFileSync(threadFile(id), "utf-8").split("\n").filter((l) => l.trim());
  let meta: ThreadMeta | null = null;
  const posts: ThreadPost[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.meta) meta = rec.meta;
      else if (rec.post) posts.push(rec.post);
    } catch {
      // One malformed line must not hide the rest of the conversation.
    }
  }
  return meta ? { meta, posts } : null;
}

export function appendPost(id: string, post: ThreadPost): void {
  appendFileSync(threadFile(id), JSON.stringify({ post }) + "\n");
}

/** Add members that are not already in the thread; returns the new full list. */
export function addMembers(id: string, members: string[]): string[] {
  const t = readThread(id);
  if (!t) throw new Error(`No such thread: ${id}`);
  const next = dedupe([...t.meta.members, ...members]);
  appendFileSync(
    threadFile(id),
    JSON.stringify({ meta: { ...t.meta, members: next } }) + "\n",
  );
  return next;
}

export function listThreads(): ThreadMeta[] {
  const dir = threadsDir();
  if (!existsSync(dir)) return [];
  const out: ThreadMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const t = readThread(f.replace(/\.jsonl$/, ""));
    if (t) out.push(t.meta);
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
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
    `Do not answer in your own transcript — a reply only reaches them through the command above.`
  );
}

/** Extract @mentions so a human or agent can address part of a thread. */
export function parseMentions(text: string): string[] {
  const found = text.match(/@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g) || [];
  return dedupe(found.map((m) => m.slice(1)));
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim()))].map((x) => x.trim());
}
