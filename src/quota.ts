/** Noticing that an account has hit a usage limit.
 *
 *  The signal is structured and lives in the runtime's own transcript, so this
 *  never reads a screen. Claude writes a record carrying `quotaLimits` at the
 *  top level, and it writes it ONLY on rejection: across 47 such records found
 *  on this machine, every single one had `status: "rejected"`. There is no
 *  "allowed" variant to filter out, which is what makes a bare presence check
 *  safe here.
 *
 *  A real one, trimmed:
 *
 *    "quotaLimits": { "status": "rejected", "resetsAt": 1788215400,
 *                     "rateLimitType": "five_hour",
 *                     "overageStatus": "rejected" }
 *
 *  Two fixtures captured from actual limits Ryan hit are in
 *  tests/fixtures/transcripts/claude-limit-*.jsonl. */

export interface QuotaLimit {
  /** "five_hour" resets the same day; "seven_day" means this account is done
   *  for the week. Cycling has to tell them apart or it will keep returning to
   *  an account that cannot come back in time. */
  kind: string;
  /** Unix seconds. */
  resetsAt: number;
  /** What the runtime told the user, for reporting rather than parsing. */
  message: string;
}

function textOf(record: Record<string, unknown>): string {
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    const p = part as { type?: string; text?: string };
    if (p?.type === "text" && typeof p.text === "string") return p.text;
  }
  return "";
}

/** One transcript line, or null when it is not a rejection.
 *
 *  Deliberately strict: a record must carry `quotaLimits.status === "rejected"`
 *  and a numeric `resetsAt`. An agent that merely *discusses* rate limiting in
 *  its own output must never be mistaken for one that hit one, and on this
 *  machine 215 transcripts mention limits in prose against 47 that carry the
 *  structure. */
export function parseQuotaRejection(line: string): QuotaLimit | null {
  if (!line.includes("quotaLimits")) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const q = record.quotaLimits as
    | { status?: string; resetsAt?: number; rateLimitType?: string }
    | undefined;
  if (!q || q.status !== "rejected" || typeof q.resetsAt !== "number") return null;
  return {
    kind: q.rateLimitType || "unknown",
    resetsAt: q.resetsAt,
    message: textOf(record) || "usage limit reached",
  };
}

/** The most recent rejection in a transcript, or null.
 *
 *  Newest wins: an account limited an hour ago and cycled away from will still
 *  have the old record in its transcript forever, so the last one is the only
 *  one that describes now. */
export function findQuotaRejection(lines: string[]): QuotaLimit | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = parseQuotaRejection(lines[i]);
    if (hit) return hit;
  }
  return null;
}

/** Whether a limit has since reset, so the account can be used again. */
export function limitIsOver(limit: QuotaLimit, nowMs: number = Date.now()): boolean {
  return nowMs >= limit.resetsAt * 1000;
}

/** How long until it resets, in words, for a person reading `account list`. */
export function resetsIn(limit: QuotaLimit, nowMs: number = Date.now()): string {
  const secs = Math.round(limit.resetsAt - nowMs / 1000);
  if (secs <= 0) return "now";
  if (secs < 3600) return `${Math.ceil(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}
