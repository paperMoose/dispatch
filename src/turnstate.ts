import { existsSync, readFileSync, statSync } from "fs";

/** Whether an agent is mid-turn, waiting, or has never started — read from the
 *  transcript the agent CLI writes, not from what its terminal looks like.
 *
 *  Every screen-based answer dispatch has ever given was chrome, and chrome
 *  rots. Two failures in one evening came from exactly that: claude moved its
 *  trust prompt from a numbered list to an arrow menu, and the readiness
 *  markers all matched a startup banner that scrolls away — so an agent became
 *  unreachable precisely once it had done enough work to be worth reaching.
 *
 *  A transcript is a better source because it is the agent's own structured
 *  record of what it did, the vendors version it, and dispatch already reads
 *  these files for `dispatch status`. It is still not a contract anyone
 *  promised us, so this reports `unknown` rather than guessing, and callers
 *  keep their existing fallbacks for that case. */

export type TurnState =
  /** Mid-turn: it is running a tool or thinking. Typing queues behind it. */
  | "working"
  /** A turn finished and nothing has started since: it is waiting for input. */
  | "waiting"
  /** Started, but no transcript exists — it has never been given a prompt. */
  | "never-started"
  /** No usable evidence either way. */
  | "unknown";

export interface TurnReading {
  state: TurnState;
  /** Seconds since the transcript was last written, or -1 when there is none.
   *  A "working" reading that has not moved for a long time is a stuck agent,
   *  which the caller can treat differently from one that is genuinely busy. */
  idleSeconds: number;
  /** Which record decided it, for `dispatch status` and for debugging a wrong
   *  answer without re-deriving the whole thing. */
  evidence: string;
}

/** Read only the tail. These transcripts reach megabytes within a session —
 *  1.5MB after 658 records was ordinary — and every marker we need is at the
 *  end. Reading the whole file per agent is what made `dispatch directory`
 *  slow enough to be backgrounded. */
const TAIL_BYTES = 256 * 1024;

function tailLines(file: string): string[] {
  const size = statSync(file).size;
  const raw = readFileSync(file, "utf-8");
  const text = size > TAIL_BYTES ? raw.slice(-TAIL_BYTES) : raw;
  return text.split("\n").filter((l: string) => l.trim());
}

/** Claude records a stop_reason on every assistant message: `tool_use` means
 *  it is about to act and the turn continues, `end_turn` means it has stopped
 *  and is waiting. A `turn_duration` system record is emitted when a turn
 *  completes, which confirms it independently. */
export function claudeTurnState(lines: string[]): { state: TurnState; evidence: string } {
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: any;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (rec.type === "system" && rec.subtype === "turn_duration") {
      return { state: "waiting", evidence: "system/turn_duration" };
    }
    if (rec.type === "assistant" && rec.message?.stop_reason) {
      const stop = rec.message.stop_reason;
      // Anything that is not an explicit end of turn means the turn is still
      // going: tool_use, max_tokens mid-stream, a pause for a tool result.
      return stop === "end_turn"
        ? { state: "waiting", evidence: "assistant/stop_reason=end_turn" }
        : { state: "working", evidence: `assistant/stop_reason=${stop}` };
    }
    // A user record after the last assistant record is a prompt that has been
    // submitted and not yet answered.
    if (rec.type === "user") {
      return { state: "working", evidence: "user turn submitted, not yet answered" };
    }
  }
  return { state: "unknown", evidence: "no turn marker in the transcript tail" };
}

/** Codex writes a different shape: `event_msg` records carrying a payload
 *  type, and `response_item` records for the model's own output. `task_started`
 *  opens a turn; the tool and reasoning items that follow mean it is still
 *  going. There is no observed end-of-turn event, so a finished turn is
 *  inferred from the last item rather than asserted — hence `unknown` where
 *  claude would say `waiting`, so a caller never treats a guess as a fact. */
export function codexTurnState(lines: string[]): { state: TurnState; evidence: string } {
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: any;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const payloadType = rec.payload?.type;
    if (rec.type === "event_msg" && payloadType === "task_started") {
      return { state: "working", evidence: "event_msg/task_started" };
    }
    if (rec.type === "response_item" && payloadType === "custom_tool_call") {
      return { state: "working", evidence: "response_item/custom_tool_call" };
    }
    if (rec.type === "event_msg" && payloadType === "agent_message") {
      // The model spoke. Codex emits no turn-complete event we can rely on, so
      // this is suggestive and not decisive.
      return { state: "unknown", evidence: "event_msg/agent_message, no turn-end marker in codex" };
    }
  }
  return { state: "unknown", evidence: "no turn marker in the transcript tail" };
}

/** Turn state for one agent, given the transcript its runtime writes.
 *
 *  `sessionFile` is resolved by the caller through the adapter, which already
 *  knows where each runtime keeps its transcripts and how to match one to a
 *  worktree. */
export function readTurnState(
  sessionFile: string | null,
  runtime: string,
): TurnReading {
  if (!sessionFile || !existsSync(sessionFile)) {
    // Claude writes nothing until its first real turn, so a live agent with no
    // transcript has never been given a prompt. That is worth saying out loud:
    // three agents sat in exactly this state for an evening while every other
    // check reported them healthy.
    return {
      state: "never-started",
      idleSeconds: -1,
      evidence: "no transcript — the agent has not been given a prompt",
    };
  }
  const idleSeconds = Math.round((Date.now() - statSync(sessionFile).mtimeMs) / 1000);
  const lines = tailLines(sessionFile);
  const { state, evidence } = runtime === "codex" ? codexTurnState(lines) : claudeTurnState(lines);
  return { state, idleSeconds, evidence };
}
