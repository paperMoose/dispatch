# SPEC: the multiplexer seam

Status: proposal, not started
Written: 2026-09-02

Prerequisite for D5 (a real plugin system). D5 cannot be built first: an
extension point laid over the current code would publish the tangle, and every
plugin author would be coding against 25 scattered conditionals.

## What is actually there today

Measured, not estimated.

| | Runtime seam (claude/codex) | Multiplexer seam (tmux/cmux) |
|---|---|---|
| Interface | `AgentAdapter`, one lookup table | none |
| Implementations | 2 | 2, by `if` |
| Branch points | 1 | **25** `useCmux()` (8 in commands.ts, 17 in shell.ts) |
| Raw backend calls outside the backend modules | 0 | **28** |
| Cost of adding a method | ~6 lines per runtime, touching nothing else | n/a |

The runtime seam works. `installTurnEndHook` was added through it in one sitting
and touched no caller. This spec proposes the same shape for the other axis.

## Two leaks the interface has to close

**1. Callers do the id mapping.** `getCmuxWorkspaceId` / `loadCmuxWorkspaceId`
appear **24 times** outside `cmux.ts`, in `commands.ts` and `shell.ts`. cmux
addresses workspaces by UUID and tmux by window name, and today the caller is
expected to know that. The adapter owns the mapping; callers pass an agent id
and nothing else, ever.

**2. Key names are translated at the call site.** `shell.ts:422` reads
`cmuxSendKey(wsId, keys === "C-c" ? "ctrl-c" : keys)`, while `commands.ts:1380`
passes the raw tmux spelling `"C-c"`. The interface defines one vocabulary and
each backend translates its own.

## The interface

Derived from the 25 branch points, not invented. Anything not on this list is
deliberately outside the seam.

```ts
export interface MultiplexerAdapter {
  readonly name: string;      // "tmux" | "cmux" | a plugin's id
  readonly apiVersion: number;

  /** Usable on this machine right now. */
  detect(): boolean;

  // ---- sessions (required) ----
  createSession(id: string, cwd: string): string | null;
  sessionExists(id: string): boolean;
  killSession(id: string): void;
  listSessions(): SessionInfo[];
  attach(id: string, explicit: boolean): void;

  // ---- the pane (required) ----
  sendText(id: string, text: string): void;
  sendKey(id: string, key: Key): void;
  capture(id: string, lines: number): string;

  // ---- liveness (required) ----
  /** Pid of the process in the agent's pane, or null when this backend
   *  genuinely cannot say. Null is a supported answer, not a failure. */
  panePid(id: string): number | null;

  // ---- cleanup (required) ----
  onSessionExit(id: string, command: string): void;

  // ---- optional ----
  readonly capabilities: ReadonlySet<Capability>;
  status?(id: string, state: string, detail: string): void;
  notify?(title: string, body: string, id?: string): void;
  flash?(id: string): void;
  search?(query: string): SearchHit[];
  dashboard?(): void;
}
```

`Key` is a closed vocabulary (`"ctrl-c"`, `"enter"`, `"up"`, `"down"`, ...),
never a backend's own spelling.

## Required versus optional, and why the split exists

cmux is much richer than tmux: `cmux.ts` exports 22 functions and about half
have no tmux equivalent at all. A flat interface would therefore either be
tmux-shaped (throwing away what cmux can do) or cmux-shaped (unimplementable by
anyone else). So: a small required core every backend must have, plus optional
capabilities dispatch checks for and degrades without.

This is the shape cmux itself uses. `cmux capabilities` returns a list of
`notification.badge.v1`, `browser.stream.v1` and so on, and callers check before
using. Copying that is cheap and already proven.

Current mapping of the optional set:

| Capability | cmux | tmux | Behaviour without it |
|---|---|---|---|
| `status` | yes | no | No live per-agent state line. `dispatch list` still works. |
| `notify` | yes | partial | Falls back to the existing OS notifier. |
| `flash` | yes | no | Attention-getting is skipped. |
| `search` | yes | no | Falls back to grepping `.dispatch.log`, which is what `commands.ts:2100` already does. |
| `dashboard` | yes | no | `dispatch dashboard` reports that this backend cannot, which is what `commands.ts:1858` already does. |

## `panePid` returning null fixes a live bug

Under cmux, `dispatch list` shows every agent as idle, because there is no pane
pid to inspect (`shell.ts:837` is tmux-only, and `commands.ts:1266` hardcodes
`agentStatus = "running"` for cmux). Today that is a silent lie.

Making null a first-class answer means the directory can say the backend cannot
report liveness, instead of asserting something false. The bug is fixed by
naming the gap in the type rather than by new detection code.

## What is deliberately NOT in the seam

Keeping these out is what stops the interface sprawling to 40 methods.

- **Thread delivery.** It is hooks now. It never touches a multiplexer, which
  the end-to-end walkthrough proved by passing in a bare shell.
- **Worktree creation.** That is git.
- **Agent identity.** That is cwd.
- **The thread buffer.** That is a file.
- **Runtime differences.** That is `AgentAdapter`, which already exists.

## Order of work

1. Land the hook path in real use and delete the compensating machinery
   (readiness regex, `turnstate.ts`, the byte cap, the sleeps). Doing the
   extraction first means abstracting code that is about to be deleted.
2. Define `MultiplexerAdapter` and implement `tmux` and `cmux` behind it.
   Collapse the 25 branches and the 24 id lookups. No behaviour change, and
   the existing suite is the check.
3. Only then D5: discovery, loading, an `apiVersion` check, and what happens
   when a plugin throws. A plugin failure degrades exactly like a failed hook
   install: warn, fall back, never abort a launch.

Step 2 is the bulk. Step 3 is small once the seam exists.

## Open questions

1. **Does a plugin ship as a node module, a directory of scripts, or a
   subprocess speaking a protocol?** A subprocess is the only option that lets
   someone write a backend in another language, and it is also the only one
   where a misbehaving plugin cannot take the process down. It costs a round
   trip per call, which matters for `capture` in a poll loop.
2. **Is `dispatch dashboard` allowed to stay cmux-only**, or does it become a
   capability a plugin can implement?
3. **How much does a plugin get to see?** The agent id and worktree path are
   unavoidable. Thread contents are not, and should not be handed over.
