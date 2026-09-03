# Note: what Claude Code and Codex have become

Explored 2026-09-02, against Claude Code 2.1.259 and codex-cli 0.146.0.

Bears directly on the multiplexer seam, and probably changes its shape.

## They have converged more than dispatch assumes

Dispatch's `AgentAdapter` exists because the two CLIs were different. Several
of those differences have quietly gone away.

| | Claude | Codex | Same? |
|---|---|---|---|
| Hook events | `SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse` | identical names | **yes** |
| Turn-end injection | `{"decision":"block","reason":...}` | identical | **yes**, proven live |
| Non-interactive run | `claude -p` | `codex exec` | same idea |
| Structured run output | `--output-format stream-json` | `--json` (JSONL) | same idea |
| Session identity + resume | session ids, `--continue` | session ids and names, `resume` | same idea |
| Config override at launch | `--settings <file-or-json>` | `-c key=value` | same idea |
| Sessions stored on disk | `~/.claude/sessions`, `~/.claude/agents` | `~/.codex/sessions/<year>/...` | same idea |

Codex is not merely similar here, it is deliberately compatible. Its own
`stop.command.output` schema carries the comment: *"Claude requires `reason`
when `decision` is `block`; we enforce that semantic rule during output
parsing."* Codex implements Claude's hook contract on purpose.

Still genuinely different, and still needing the adapter: how a hook is
configured (a settings file versus launch flags), model and reasoning-effort
flags, sandbox and permission flags, and the TUI markers that say a pane is
ready.

## The change that matters: neither needs a terminal multiplexer any more

**Claude** has native background agents:

```
claude --bg                 start a session in the background
claude agents --json        list them, machine-readable
claude attach <id>          open one in this terminal
claude logs <id>            recent output
claude respawn [id]         restart one, or all
```

**Codex** has an app-server daemon with a control socket, a generated JSON
schema and generated TypeScript bindings for its protocol
(`codex app-server generate-json-schema`, `generate-ts`), plus
`codex remote-control` to manage it.

Both are doing what dispatch uses tmux and cmux for.

## What `claude agents --json` already answers

Real output on this machine right now: **18 background agents, 10 of them
already inside dispatch worktrees.**

```json
{
  "id": "f15bc8e9",
  "cwd": ".../noah-server/.worktrees/hey-3824-comprehension-spec",
  "kind": "background",
  "startedAt": 1784091389094,
  "sessionId": "f15bc8e9-8ce5-4203-b939-1f89a7933ef7",
  "name": "Write Noah server specs for agent package refactor",
  "state": "blocked"
}
```

Every field dispatch works hard for:

- `state` is the liveness dispatch reverse-engineers with `lsof`, pane pids and
  256KB of transcript tailing in `turnstate.ts`. Reported natively. Two of the
  eighteen read `blocked`, which is precisely the "waiting on a person" signal
  an orchestrator wants and cannot currently get.
- `cwd` maps to an agent id through the existing `agentIdFromPath`.
- `name` is what `describeWork` reconstructs from three fallback sources.
- The cmux bug where every agent shows as idle cannot occur, because there is
  no pane to fail to inspect.

## What this does to the seam spec

The interface as drafted is **pane-shaped**: `sendText`, `sendKey`, `capture`,
`panePid`. That is the right shape for tmux and cmux and the wrong shape for a
backend where no pane exists.

So the axis is not "which multiplexer" but **"where does an agent run"**, and
there is a third answer neither spec accounts for: the runtime's own background
mode, with no multiplexer at all.

Mapping the drafted interface onto a native backend:

| Method | Native background equivalent |
|---|---|
| `createSession` | `claude --bg` |
| `listSessions` | `claude agents --json` |
| `attach` | `claude attach <id>` |
| `capture` | `claude logs <id>` |
| `killSession` | plausible, unverified |
| `panePid` | not applicable, and `state` is strictly better |
| `sendText` | **unknown, and this is the open question** |

`sendText` is the one that does not obviously map. Sending a message into a
running background session may have no equivalent. Thread delivery no longer
needs it, since that is a hook reading a file, but `dispatch send` does, and so
does pasting the initial prompt.

## What to do about it

Nothing yet, and specifically **do not widen the seam spec to cover this now**.
The interface should still be extracted from the two backends that exist, or it
becomes speculative design for a backend nobody has asked for.

But two cheap things are worth doing while it is fresh:

1. **Answer the `sendText` question.** Whether a running background session can
   be sent a message decides whether a native backend is a whole backend or
   only a launcher. One experiment.
2. **Take `state` from `claude agents --json` now**, independently of any
   refactor. It is strictly better than what `turnstate.ts` infers, for
   background sessions, and it needs no seam to adopt.

If a native backend does turn out to fit, the payoff is large: no tmux, no
cmux, no readiness detection, no pane at all, and the liveness problem solved
by the runtime rather than by us.

---

# What dispatch is actually for, and what that implies

Added after Ryan set out the constraints: dispatch must launch both visible and
invisible agents, must clean up worktrees reliably, and must work with **every**
agent harness rather than only Claude and Codex.

## The three asks are one change

### Measured: most of a harness adapter exists only to read a screen

| Adapter | Total | Screen and transcript reverse-engineering |
|---|---|---|
| `claudeAdapter` | 178 lines | ~126 (**70%**) |
| `codexAdapter` | 275 lines | ~222 (**80%**) |

`AgentAdapter` has 13 methods. Roughly eight of them exist only because dispatch
drives a text UI through a terminal and has to work out what is on the screen:
`paneCmd`, `isReady`, `isBusy`, `dismissStartupDialog`, `shellPrefix`,
`findSessionFile`, `parseSession`, `parseLog`.

That is the barrier to a third harness. Not the launching, which is a line. The
screen-reading, which is a research project per harness, and the part that broke
twice in one day: `isReady` matched only a startup banner, so agents got *less*
reachable the more work they had done.

### "Invisible rather than headless" removes exactly that code

What Ryan described — not headless, just not shown, still a real session you can
open later — already exists:

```
claude --bg          start it, invisible
claude attach <id>   open it when you want to look
claude logs <id>     see what it has been doing
```

An agent with no visible pane has no screen to read. So `isReady`, `isBusy`,
`dismissStartupDialog` and `paneCmd` stop being needed, and `state` comes from
`claude agents --json` instead of from `parseSession`.

**A new harness would need about five things instead of thirteen:** what the
binary is called, how to launch it, how to make it run something when a turn
ends, how to resume it, and optionally how to read its log.

### Hooks are the one thing the ecosystem already agrees on

cmux ships hook integrations for seventeen harnesses:

> codex, grok, opencode, pi, omp, campfire, amp, cursor, gemini, kiro,
> antigravity, rovodev, hermes-agent, copilot, codebuddy, factory, qoder

So "make it run something when a turn ends" is not a bet on an unusual feature.
It is the closest thing this ecosystem has to a standard, and dispatch already
depends on it for thread delivery as of 0.15.0.

## What stays dispatch's own

Worth being explicit, because it is what survives whatever the harnesses grow
next. None of them do any of this:

- **Worktree lifecycle.** Create one per agent off the right base, keep agents
  out of each other's way, remove it after, delete the branch only if merged.
- **Refusing to destroy work.** Bulk and automatic cleanup already skip
  worktrees with uncommitted changes rather than forcing them, and a merged
  branch with dirty state is kept. That is the behaviour people would be upset
  to lose, and it is already right.
- **Coordination between agents.** Threads, the directory, do-not-disturb,
  `dispatch done`.
- **One vocabulary across harnesses.** `dispatch list` meaning the same thing
  whether an agent is Claude, Codex, or something not written yet.

## The order this suggests

1. **Answer the one open question:** can a running background session be sent a
   message? If yes, invisible mode is a complete backend. If no, it is a
   launcher and the pane path stays for `dispatch send`.
2. **Add invisible as a third launch mode**, alongside headless and
   interactive. Small, and it is what Ryan actually wants day to day.
3. **Then split `AgentAdapter`**: a small required core every harness must
   implement, and the screen-reading half as optional, needed only by harnesses
   run in a visible pane.
4. Multiplexer seam after that, on whatever is left of it.

Note the reordering. The harness axis is the one Ryan asked to open, and it is
also where the measured cost is. The multiplexer seam was drafted first because
it looked untidiest, which is not the same as mattering most.
