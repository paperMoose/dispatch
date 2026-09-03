# Note: automatic account failover

Status: requirement captured, not specced, not started
Written: 2026-09-02

Not part of the hook-delivery work. Recorded so the requirement and the
correction that produced it are not lost.

## The requirement, in Ryan's words

> I just need a way of easily switching between accounts simply and
> automatically when dispatch hits a session limit

## What I had wrong

I proposed per-agent account pinning: give each dispatched agent its own
account so their rate limits never pool. I also claimed that isolating an
agent's config would cost it your skills.

Both were off.

- **Skills are not lost.** They live in the repo's own `.claude/skills/`, not
  in `~/.claude`. Confirmed independently: cmux emits hook events with a cwd of
  `noah-server/.claude/skills/replay`. So config isolation does not take them
  away, and the "separate wallets, same toolbox" problem I described is much
  smaller than I said.
- **Pinning is not the ask.** The ask is failover: keep working when one
  account runs out, without hand-editing 50 sessions.

## What is actually established

`CLAUDE_CONFIG_DIR` fully isolates authentication. Measured, read-only:

```
$ claude auth status
{"loggedIn": true, "authMethod": "claude.ai", "email": "..."}

$ CLAUDE_CONFIG_DIR=$(mktemp -d) claude auth status
{"loggedIn": false, "authMethod": "none"}
```

This is Claude Code behaviour, not cmux. It is also why changing the account
appears to change it everywhere: every session shares one config dir, so one
account, so one rate limit.

## The open questions, none of them answered yet

1. **Detecting the limit.** What does dispatch observe when an agent hits a
   session cap? Candidates: text in the pane, a `agent.hook.Notification`
   event, something in the transcript. Screen-matching is the wrong answer for
   the same reason it was wrong for readiness. Needs a live observation of a
   real limit being hit, captured as a fixture.
2. **Switching without losing the session.** Session history lives inside the
   config dir, so swapping `CLAUDE_CONFIG_DIR` mid-run orphans the
   conversation. Either credentials get swapped inside one config dir, or the
   session has to be resumable across dirs. Unresolved, and it is the hard
   part.
3. **Non-interactive login.** `claude auth login` is interactive.
   `claude setup-token` claims to produce a long-lived token. Unverified.
4. **How many accounts, and any rules** about which work goes where. Asked,
   not yet answered.
5. **Codex.** Ryan uses Codex as the implementer specifically because its
   limits are better. Failover may matter far less there. Worth checking
   before building anything symmetrical.

## Question 2, answered 2026-09-02. It is a small feature.

Two measurements settle it.

**Session history follows the config dir.** A run under an isolated
`CLAUDE_CONFIG_DIR` created its own `projects/`, `sessions/` and
`session-env/` there. So swapping the config dir mid-run *does* orphan the
conversation, and per-agent config dirs are the wrong shape for failover.

**The credential is a file inside that dir.** With a dummy
`.credentials.json` placed in an otherwise-empty config dir,
`claude auth status` reported `loggedIn: true`. The binary reads
`.credentials.json` from the config dir; the macOS keychain entry is not the
only path. (The probe used an obviously invalid token and the directory was
deleted immediately. Never copy a real credential to a temp location to test
this.)

Put together, the design is the opposite of what was proposed above:

> **Keep one config dir per agent for its whole life, and swap only
> `.credentials.json` inside it when a limit is hit.**

History never moves, so nothing is orphaned. The swap is one file write. The
running process will not notice a changed file, so the sequence is: detect the
limit, replace the credential, `dispatch resume`. Resume already reinstalls the
turn-end hook, verified live on 2026-09-02, so a failed-over agent keeps
receiving thread posts.

That leaves exactly one hard problem: **detecting the limit** (question 1),
which still needs a real limit being hit, captured as a fixture. Everything
after it is small.

## Before any code

Answer question 1 the same way: capture what dispatch can actually observe when
a session cap is reached. Screen-matching is the wrong answer for the same
reason it was wrong for readiness.


## Proof that Claude Code accepts a vaulted credential (2026-09-03)

`claude auth status` was not enough evidence and should not have been treated
as any. It reads a file and checks an expiry locally; it can report
`loggedIn: true` for a token the API would refuse. Three things were checked
directly instead.

**A real model call.** With `CLAUDE_CONFIG_DIR` pointed at a directory built
entirely by `useAccount`, `claude -p` returned the requested word and exited 0.
That is the only evidence that matters, and it is the one that had been
skipped.

**The turn-end hook still fires there.** This is the interaction between the
two features built the same day, and the failure would have been silent: an
agent moved to a second account that quietly stopped receiving thread posts.
A project-level `Stop` hook fired under an isolated config dir and its
injection reached the model.

**Identity resolves on first use.** Immediately after `useAccount`, status
reported `email: null` and `orgId: null`, which looked like a gap. It is not:
both populate once a real call has been made, and afterwards match the default
configuration exactly. Worth knowing so it is not chased again.

### What is still unproven

Everything above used **one** account, Ryan's own. Nothing has yet shown two
*different* logins side by side, which is the entire point. That needs a second
account registered, and it is the next thing to verify rather than assume.
