# SPEC: what dispatch is, and the shape it should arrive in

Status: proposal
Written: 2026-09-02
Supersedes the ordering in `SPEC-multiplexer-seam.md`, which stays valid as an
interface sketch but is no longer the first piece of work.

## The claim

Dispatch is a **worktree and coordination layer**. The agent harness is
pluggable, and so is where the agent runs.

Everything durable about dispatch is in that first sentence, and none of it is
something a harness does or is likely to start doing: a worktree per agent off
the right base, cleaned up afterwards; agents that can confer without routing
through a person; one vocabulary across harnesses so `dispatch list` means the
same thing whichever one is running.

Everything painful is in the second: dispatch drives text UIs through a
terminal and reads the screen to work out what is happening.

## Two tiers, named explicitly

### The floor: four things, required of every harness

1. A launch line, visible or invisible.
2. A way to run a command when a turn ends. Hooks. cmux already integrates
   these for seventeen harnesses, so it is the closest thing to a standard the
   ecosystem has, and thread delivery already depends on it as of 0.15.0.
3. How to resume.
4. A worktree, which is dispatch's own and asks nothing of the harness.

Any harness meeting that gets worktrees, threads, cleanup, and the directory.
**That is the promise, and nothing in the floor requires reading a screen.**

### The fast path: optional, per harness

Native listing, pushed state, native send. Claude and Codex have it today.
Anything else falls back to the floor and works with less fidelity rather than
not at all.

| | Claude | Codex |
|---|---|---|
| list | `claude agents --json` | `ThreadList` |
| state | `state` field | `ThreadStatusChangedNotification` (pushed) |
| turn ended | hook | `TurnCompletedNotification` (pushed) |
| send to a running agent | **none** | `TurnSteer`, `ThreadInjectItems` |
| attach | `claude attach <id>` | app-server |

Codex's app-server is marked experimental in its own help. The floor must stay
sufficient on its own, so that an experimental protocol changing under us
degrades fidelity rather than breaking dispatch.

## Worktree collection

The current rule is wrong. It refuses to remove a worktree with uncommitted
changes, which sounds careful and is not: measured on noah-server, **200
worktrees, 47 dirty, 24 idle a week or more, and 13 both** — and those 13 are
exactly the ones the current rule protects forever.

### What removal actually costs

Removing a worktree destroys **uncommitted changes only**. Commits survive on
the branch, which `git worktree remove` does not touch. So the question is
never "does this worktree have work in it", it is "is anyone using it".

### Rescue, so the question stops mattering

Before removing anything, capture the dirt with `git add -A` followed by
`git stash create`.

Verified: this returns a recoverable commit object, leaves the working tree
untouched, and **leaves the stash stack at zero**. That last part is required,
not incidental: the stash stack is shared across every worktree in the repo and
other sessions pop from it, so `git stash push` is unusable here.

The returned sha is written to a ref under `refs/dispatch-rescue/<id>` so it
survives gc, and reported. Cheap enough to do unconditionally, which means
aggressiveness stops being a risk decision.

Note: `stash create` alone captures tracked modifications only, hence the
`add -A` first. Mutating the index of a worktree about to be deleted is
harmless.

### The signals that actually decide

**Never remove while any of these hold:**

- A live session for it: a tmux window, a cmux workspace, or an entry in the
  harness's own list.
- A live process whose cwd is inside it. Already implemented as
  `agentProcessAlive`.
- `git worktree` reports it locked.
- Anything inside it modified within the keep-window (default 7 days).

**Remove when none of them hold**, dirty or not, having rescued first.

**Referenced by another agent** is the third signal Ryan named and the hardest
to observe. Detectable approximations, in descending confidence: the branch tip
is contained by another branch, the branch is merged into base, the branch
appears in another worktree's reflog. All three mean the work has been consumed
elsewhere, which argues *for* removal rather than against. A worktree another
agent is actively reading is already covered by the live-process check.

**Open question:** whether anything beyond that is worth building. Recording
cross-worktree reads would need dispatch to observe file access it currently
cannot see. Default to the live-process check and the keep-window until there
is a real case it misses.

### Interface

```
dispatch gc                 # what would go, and why, changing nothing
dispatch gc --older-than 14 # override the keep-window
dispatch gc --apply         # do it, rescuing each one first
dispatch gc --rescued       # list rescue refs and how to restore one
```

Dry run is the default. A command that deletes 200 directories should have to
be asked twice.

## The shape it should arrive in

Measured today: `commands.ts` is **3,859 lines, 46 exports, 25 command
handlers**, 43% of the codebase in one file.

Splitting it is not a separate cleanup task and must not become one. Files move
**as part of the work that touches them**, never in a standalone commit that
reshuffles everything and can only be reviewed by trusting it.

Target, reached incrementally:

| Module | Holds |
|---|---|
| `agents.ts` | the harness floor, and the optional fast path per harness |
| `runner.ts` (new) | where an agent runs: tmux, cmux, invisible |
| `worktree.ts` (new) | create, inspect, rescue, collect |
| `threads.ts` + `inbox.ts` | coordination, already the right size |
| `directory.ts` | who is running and what they are on |
| `cli.ts` | argument parsing and help, nothing else |

`commands.ts` should end up holding command handlers and no mechanism.

## Order of work

Chosen so that nothing is built on something about to be deleted.

1. **`dispatch gc`.** Self-contained, needs no refactor, and cannot be
   invalidated by any later decision because it touches only git and the
   filesystem. Also the thing costing you 200 worktrees today.
2. **Split `AgentAdapter` into floor and optional.** Where the measured cost
   is: 70% of `claudeAdapter` and 80% of `codexAdapter` exist only to read a
   screen.
3. **Invisible launch mode**, alongside headless and interactive. Needs only
   the floor, and is the mode that makes the screen-reading half optional in
   practice rather than only on paper.
4. **The multiplexer seam**, on whatever is left of it once 3 lands. It will be
   smaller: fewer callers will need a pane at all.
5. **Plugin loading.** Last, and small by then.

The multiplexer seam moved from first to fourth. It was drafted first because
it looked untidiest, which is not the same as mattering most.

## Verification

Per stage, and no stage starts before the previous one's gate is green.

**`dispatch gc`.** Unit tests over the decision function with fabricated
signals, so every branch is reachable without 200 real worktrees. One live test
that creates a worktree, dirties it, rescues and removes it, and restores the
dirt from the rescue ref. Plus a dry-run assertion that an invocation without
`--apply` changes nothing on disk.

**The adapter split.** The existing suite passes with **zero test-file edits**,
and a harness implementing only the floor can be constructed and launched. That
second one is the real gate: a `FloorOnlyAdapter` in the test suite that
implements the four required things and nothing else.

**Invisible mode.** The same nonce loop-back used for hook delivery: launch
invisibly, post to a thread, assert the reply lands in the buffer. Both
runtimes.

**The seam.** As already specced: zero test edits, three grep counters to zero,
and a `NullMultiplexer` that throws on everything.

**Everywhere: red-on-revert.** Each gate demonstrated failing against the code
it replaces before it is claimed as passing.

## Out of scope

- Account failover. Captured separately in `NOTE-account-failover.md`; it has
  its own blocking question.
- Rewriting `dispatch send`.
- The thread data model, which is settled and shipped.
