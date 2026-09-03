# SPEC: hook-based thread delivery

Status: in progress. Gate 0 passed. Both runtimes proven end to end. Next is
installing the hook at launch and removing the compensating machinery.
Owner: Ryan
Written: 2026-09-02

## The problem in one paragraph

Thread posts are delivered by typing into a running agent's TUI. That single
choice is the origin of the readiness regex, the transcript-tailing turn
detector, the trust-dialog handling, the 2,500-byte cap, the newline
flattening, and a three second sleep per recipient. This spec replaces the
transport with a pull: dispatch writes the post and stops; the agent fetches it
at its own turn boundary via a hook the agent runtime already supports.

## Goal

A post reaches its recipients' context with newlines intact, at a turn
boundary, without dispatch typing anything into a pane, on every agent runtime
dispatch launches.

## Non-goals

Explicitly out of scope. Touching any of these means stopping and asking first.

- The thread data model. `.jsonl` layout, `ThreadPost`, `ThreadMeta`,
  `recipientsFor`, `nextHops`, hop limits and the approval queue are unchanged.
- The directory, `dispatch done`, DND semantics, the agent registry.
- `turnstate.ts`. It stays until every runtime is proven, then goes, not before.
- Any rewrite of `dispatch send`. Threads only.
- npm publish. No release until every gate below is green.

## Decisions already made

Locked. Reopening one requires saying so explicitly.

| # | Decision | Choice |
|---|---|---|
| D1 | Push or pull | Pull. Agent fetches at its own turn boundary. |
| D2 | Agents that cannot run hooks | Keep pane-typing as fallback. Nothing goes dark. |
| D3 | Which hook event | Turn end (`Stop`). Not `UserPromptSubmit`: a dispatched agent may never be prompted again. |
| D4 | Where the etiquette lives | Installed once at launch. Posts carry only the post. |
| D5 | How far to take backend extensibility | A real plugin system, so a third party can add a multiplexer dispatch does not ship. |

On D5: I recommended the narrower option (extract the seam internally, mirroring
the existing `AgentAdapter`, and document it without publishing an API). Ryan
chose the full plugin system. Recorded here so the scope is deliberate rather
than drifted into. It still needs its own spec: what a plugin may override, how
it is discovered and loaded, and what happens when one misbehaves. **Do not
start D5 from this document.**

## Constraint discovered before writing this

Codex runs hooks **synchronously and blocks until they return**. cmux hit a
~35 second launch hang from a synchronous hook and moved to fire-and-forget
(source: comments in `cmux-codex-wrapper`). Whatever the hook runs must be fast
enough to be invisible once per turn, or Codex agents stall on every turn.

This is what Gate 0 measures.

## Gate 0: latency, thresholds registered before measuring

The hook must spawn a process, read the thread file, and emit JSON. The
question is whether that can be the existing Node `dispatch` binary or whether
it needs a shell shim.

Measured: p50 and p99 wall clock, cold, over >= 20 runs, at thread sizes of
1, 100 and 1,000 posts.

| Result | Verdict |
|---|---|
| p99 <= 200ms | Node `dispatch` binary is the hook. Proceed as designed. |
| 200ms < p99 <= 1s | Node is too slow for Codex. Hook becomes a shell shim reading the `.jsonl` directly; the Node CLI stays the human-facing path. |
| p99 > 1s | Pull model does not work for Codex as specified. Stop and redesign that cell before writing code. |

Claude's hooks are also synchronous but fire once per turn against a local
file; the same numbers apply and the same thresholds govern.

**No code is written until this number exists and is recorded below.**

## The matrix

**Revised after the end-to-end walkthrough on 2026-09-02. It is not a 2x2.**

The pull path never touches a multiplexer. The hook runs inside the agent's own
process, reads a file, and writes stdout; identity comes from cwd and
do-not-disturb from a file in the worktree. Nothing in that chain knows or
cares whether the agent is in tmux, in cmux, or in a bare shell. The live
loop-back below was run in a plain shell with no multiplexer at all and passed.

So the axis that matters is the runtime, not the terminal:

| Runtime | Mechanism | Status |
|---|---|---|
| Claude | `Stop` hook, `.claude/settings.json` | **Proven end to end.** See walkthrough. |
| Codex | `--enable hooks -c hooks.Stop=...` per invocation | **Proven end to end.** Same envelope. |

The multiplexer only re-enters for the pane-typing fallback, which is unchanged
and already works on both. This removes two of the four planned live tests.

## Interface

New command. Must NOT be called `pending`: `dispatch thread pending` already
means "groups awaiting your approval" and is human-facing.

```
dispatch thread inbox            # posts owed to the agent whose worktree this is
```

- Resolves its own identity from cwd via `agentIdFromPath`. No id argument.
- Emits the runtime's context-injection JSON on stdout.
- Exits 0 and emits nothing when there is nothing owed. A hook that fires on
  every turn must be silent when idle.
- Records delivery via the existing `recordDelivery`, so `pendingFor` stops
  returning the post. Delivery accounting does not change shape.
- Respects DND by emitting nothing.

## Verification

Three layers. Each must exist before the next is trusted.

**1. Unit.** Existing 319 tests keep passing untouched. `pendingFor`,
`recipientsFor`, hop limits: no change.

**2. Hook contract test.** Runs the hook directly, no agent, no pane. Asserts:
well-formed JSON for the runtime, silence when nothing is owed, DND honoured,
and **wall clock inside the Gate 0 budget**. The latency constraint is an
assertion, not a hope. Runs in CI.

**3. Live loop-back, one per cell.** The only proof that counts.

> Post a message containing a random nonce plus an instruction to post that
> nonce back. Assert the nonce appears in the thread file within a timeout.

One assertion covers the whole chain: hook fired, message arrived intact, agent
read it, reply path worked. Identical per runtime, so it is one harness
parameterized by runtime. It needs no multiplexer at all, which the walkthrough
below established by passing in a bare shell.

**Red-on-revert is mandatory.** Each cell's test must fail when the delivery
code is reverted. A green suite against a gutted transport is what let the
duplicate-delivery bug ship. Demonstrate the red before claiming the green.

## Order of work

1. ~~Gate 0 measurement.~~ **Done.** Band 1, result recorded below.
2. ~~`dispatch thread inbox` plus its contract test.~~ **Done.** `src/inbox.ts`,
   `tests/inbox.test.ts` (19 tests), wired as a `thread` subcommand. Full suite
   338 passing. Four mutations verified to turn the new tests red; one of them
   exposed a test that was asserting a guarantee `pendingFor` already made
   rather than the membership check it claimed to cover, and that test was
   rewritten to the case that binds.
3. ~~Hook installation for the cheapest runtime, with its loop-back test.~~
   **Done for Claude** (walkthrough below).
4. ~~Codex: find the event and output shape that inject context, then its own
   loop-back test.~~ **Done.** Same `Stop` event, same envelope, live loop-back
   passed twice.
5. ~~Install the hook at launch.~~ **Done.** `src/turnhook.ts`, an
   `installTurnEndHook` method on `AgentAdapter`, called from `launchAgent`.
   Claude gets `.claude/settings.local.json` in the worktree (the `.local`
   overlay, so the tracked `settings.json` and the agent's own diff stay
   clean); Codex gets launch flags and persists nothing. 18 tests, four
   mutations verified red.
6. Only once both runtimes are green in production use: delete the
   compensating machinery (readiness regex, `turnstate.ts`, the byte cap, the
   sleeps).
7. Ship.

Pane-typing stays in place as the fallback throughout. It is removed for no
runtime until that runtime's loop-back test is green.

## Stop-and-ask triggers

- Gate 0 lands in the third band.
- Any cell needs a mechanism not listed in the matrix.
- The fix for a failing cell would change the thread data model.
- Scope grows past the file list: `threads.ts`, `commands.ts`, `shell.ts`,
  a new hook module, and tests.

## Walkthrough: the Claude path, proven end to end

Run 2026-09-02 in a real git worktree at `.worktrees/e2e-probe`, no multiplexer.

Seeded a thread with a post from `orchestrator` addressed to `e2e-probe`, marked
undelivered. Installed a `Stop` hook running `dispatch thread inbox --hook Stop`.
Ran `claude -p "Reply with the single word STARTED and nothing else."` The agent
answered the prompt, the hook fired, and the buffer afterwards read:

```
META  members=['orchestrator', 'e2e-probe']
POST  ep1       orchestrator -> ['e2e-probe']  hops=0   "What is 7 times 6? ..."
DELIV ep1       delivered=[]            undelivered=['e2e-probe']   <- seeded
DELIV ep1       delivered=['e2e-probe'] undelivered=[]              <- the hook
POST  15ed7b97  e2e-probe    -> (all)   hops=1   "42"
DELIV 15ed7b97  delivered=[] undelivered=['orchestrator']
```

What that establishes, each of which was an assumption before:

- A `Stop` hook fires at the end of a turn.
- `hookSpecificOutput.additionalContext` on a `Stop` hook reaches the model. A
  separate isolated probe confirmed this first: the model emitted a nonce that
  existed only inside the hook's output.
- The agent resolved its own id from cwd. The reply is attributed to
  `e2e-probe` and no id was typed anywhere.
- The agent understood the post and the reply command well enough to answer
  correctly and post back, from framing alone, with no etiquette preamble.
- Hop counting survives the new path: the reply is `hops=1`.
- Delivery is recorded after emission, and the reply to an offline member stays
  owed rather than being dropped.

### Why this does not loop

A `Stop` hook that always injects would never let an agent stop. Nothing
guards against that explicitly, and nothing needs to: the hook records delivery
after emitting, so the next `Stop` finds an empty inbox and emits nothing. The
silence-when-empty rule is the loop brake, not a bolted-on counter.

The one way that breaks is if `recordDelivery` fails while emission succeeds,
which would re-inject the same post forever.

**Guarded as of the launch-install work.** Both runtimes hand the hook a JSON
payload on stdin carrying `stop_hook_active: true` once a stop hook has already
made this turn continue. The script bails there, which caps injection at one
per real turn end whatever else goes wrong. Verified in a real shell: a
continuation payload produces silence, a normal payload reaches the fetch, and
no stdin at all does not hang.

## Gate 0 result

Measured 2026-09-02, macOS, 25 cold runs each.

| What | p50 | p99 |
|---|---|---|
| process spawn floor (`/usr/bin/true`) | 1.6ms | 3.2ms |
| node boot floor (`node -e ''`) | 20.4ms | 22.6ms |
| `dispatch --version` (full CLI boot) | 38.4ms | 49.8ms |
| hook: parse + compute owed + emit, 1 post | 27.6ms | 29.9ms |
| hook: same, 100 posts | 27.9ms | 30.2ms |
| hook: same, 1,000 posts | 30.0ms | 32.5ms |

**Verdict: band 1. p99 <= 200ms with roughly 4x margin.** The Node `dispatch`
binary can be the hook. No shell shim needed.

Two things worth keeping:

- Cost is dominated by Node boot, not the thread. Going from 1 post to 1,000
  adds 2.6ms. Thread size is not a scaling risk; process startup is the whole
  bill.
- Even the heavy path (full CLI boot at 49.8ms p99, plus ~10ms of work) stays
  under 60ms, once per turn. Invisible against Codex's synchronous hook
  execution, and nowhere near the ~35s hang cmux hit.

The contract test asserts a **200ms p99 budget**. That is 4x current headroom,
so it catches a real regression (a network call, a sync spawn, loading the
whole agent registry) without failing on normal machine noise.

## Walkthrough: Codex, proven end to end

Run 2026-09-02 in a real worktree, `codex exec` with the hook passed per
invocation. The trace, twice:

```
codex -> STARTED
hook: Stop -> Blocked          <- the inbox returned decision:block
codex -> dispatch thread post t-cxprobe "144" --replay "python3 -c 'print(12*12)'"
         Posted to t-cxprobe as cx-probe
codex -> 144
hook: Stop -> Completed        <- second fire, silent, agent stops
```

### One envelope, not two

Expected two formats and found one. Claude's `Stop` accepts
`hookSpecificOutput.additionalContext` (confirmed live), but Codex's
`stop.command.output` schema sets `additionalProperties: false` and defines no
`StopHookSpecificOutputWire`, so that shape is rejected there outright. Its
accepted keys are `continue`, `decision`, `reason`, `stopReason`,
`suppressOutput`, `systemMessage`.

`{"decision":"block","reason":...}` is accepted by both, and each was confirmed
live against a nonce that existed nowhere but inside the envelope. So there is
one `hookJson`, no per-runtime branching, and a test asserts the payload carries
no key outside Codex's allow-list.

### A wording bug only a live run could find

The first Codex run copied the placeholder out of the suggested reply command
and posted `replay: cmd` — a command nobody can run, offered as evidence, which
is worse than offering none. The framing now keeps every placeholder off the
line the agent is meant to copy. The rerun posted
`replay: python3 -c 'print(12*12)'`, a command that genuinely reproduces the
answer. Regression-tested.

### A confound worth recording

The first Codex attempt hung with the hook never firing. Cause: `codex` on PATH
is a cmux shim that injects its own `-c hooks.Stop=...`, which collided with the
one under test. `CMUX_CODEX_HOOKS_DISABLED=1` bypasses it. Any future Codex hook
test needs that, or it is measuring cmux rather than dispatch.
