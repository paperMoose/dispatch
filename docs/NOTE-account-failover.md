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

## Before any code

Question 2 decides whether this is a small feature or a redesign. Answer it
first, the same way Gate 0 was answered first: cheapest experiment that can
invalidate the design.
