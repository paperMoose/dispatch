import type { Thread, ThreadMeta, ThreadPost } from "./threads.js";
import { pendingFor, recipientsFor } from "./threads.js";

/** What an agent is owed, and how it reads when injected at a turn boundary.
 *
 *  This is the pull half of thread delivery. Nothing here touches a terminal:
 *  the agent runs `dispatch thread inbox` from its own hook when it finishes a
 *  turn, and what this module returns goes straight into its context. That is
 *  why the framing is short. Delivery used to carry 1,206 characters of
 *  etiquette on every single post, which ate half the pane budget and was
 *  re-read by the agent every time; the etiquette now goes in once at launch
 *  and a post carries the post.
 *
 *  Kept apart from commands.ts so the decision of what to say can be tested
 *  without a multiplexer, a hook, or a running agent. */

export interface InboxItem {
  meta: ThreadMeta;
  posts: ThreadPost[];
}

/** Every thread this agent is a member of that owes it something.
 *
 *  Takes threads rather than reading them, so a test can hand it a buffer and
 *  so one read serves both this and the delivery accounting that follows. */
export function collectInbox(threads: Thread[], agent: string): InboxItem[] {
  const out: InboxItem[] = [];
  for (const t of threads) {
    if (!t.meta.members.includes(agent)) continue;
    const posts = pendingFor(t, agent);
    if (posts.length) out.push({ meta: t.meta, posts });
  }
  return out;
}

/** One post, as the recipient reads it.
 *
 *  Addressed or merely present is the one distinction worth repeating per
 *  post: a member copied on a broadcast used to answer questions put to
 *  somebody else. Everything else an agent needs to know about how to behave
 *  in a thread was given to it at launch. */
function renderPost(meta: ThreadMeta, post: ThreadPost, recipient: string): string {
  const addressed = !!post.to?.includes(recipient);
  const lines = [
    `${post.from}${addressed ? " → you" : " → the thread"}: ${post.text}`,
  ];
  if (post.replay) {
    lines.push(`  they say this shows it, run it before acting: ${post.replay}`);
  }
  return lines.join("\n");
}

/** Everything owed, as one block of text for the agent's context.
 *
 *  Newlines survive here in a way they never did through a pane: `sendToPane`
 *  had to flatten the whole message to one line to get it past the tty. */
export function inboxBody(items: InboxItem[], recipient: string): string {
  if (!items.length) return "";
  const blocks = items.map((item) => {
    const head = `[thread ${item.meta.id}${item.meta.topic ? `: ${item.meta.topic}` : ""}]`;
    const body = item.posts.map((p) => renderPost(item.meta, p, recipient)).join("\n");
    const others = item.meta.members.filter((m) => m !== recipient);
    const hops = Math.max(...item.posts.map((p) => p.hops)) + 1;
    return (
      `${head}\n${body}\n` +
      `  also here: ${others.length ? others.join(", ") : "(nobody else yet)"}\n` +
      `  reply only if you have what they need or are blocked on them: ` +
      `dispatch thread post ${item.meta.id} --replay "cmd" "what you saw"` +
      ` (reply ${hops} of ${item.meta.maxHops})`
    );
  });
  return blocks.join("\n\n");
}

/** The JSON a Claude Code hook prints to put text into the agent's context.
 *
 *  Shape confirmed against a hook that is live on this machine: the
 *  `UserPromptSubmit` hook at ~/.claude/hooks/inject-datetime.sh emits exactly
 *  this and its text lands in the session. The event name is a parameter
 *  rather than a constant because which event we hang delivery on is settled
 *  per runtime by a live test, not by assumption. */
export function claudeHookJson(event: string, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  });
}

/** Which posts to mark delivered, given what was actually rendered.
 *
 *  Separate from rendering so the caller records exactly what it emitted and
 *  nothing more: a post marked delivered that never reached the agent is gone
 *  for good, and that is the failure this whole design exists to avoid. */
export function deliveredIds(items: InboxItem[]): { thread: string; post: string }[] {
  const out: { thread: string; post: string }[] = [];
  for (const item of items) {
    for (const p of item.posts) out.push({ thread: item.meta.id, post: p.id });
  }
  return out;
}

/** Whether a post is one this agent should ever have been shown.
 *
 *  `pendingFor` already filters by recipient; this is the assertion that keeps
 *  a future change to the queue from leaking somebody else's mail into a
 *  context window, where it cannot be taken back. */
export function isForRecipient(meta: ThreadMeta, post: ThreadPost, recipient: string): boolean {
  return recipientsFor(meta, post.from, post.to).includes(recipient);
}
