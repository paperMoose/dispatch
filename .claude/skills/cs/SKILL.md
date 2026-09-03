---
name: cs
description: Explain this like I'm dumb. Feynman brief. Strip the jargon, use one everyday analogy, keep it under 200 words, plain text in the terminal. Use when Ryan types /cs, or says "explain like I'm stupid", "feynman brief", "I don't get it", or "huh?" about something just discussed.
allowed-tools: Read, Glob, Grep, Bash
---

# /cs — explain it like I'm dumb

Explain the thing in plain words. Short. No jargon.

## Arguments

- `/cs` with nothing after it: explain whatever was just being discussed.
- `/cs <topic>`: explain that instead.

## Rules

**Plain text in the terminal.** Never an artifact, never a doc, never a file.
This is a two-breath answer, not a deliverable.

**Under 200 words.** If it runs longer, the explanation failed and padding will
not save it. Cut, do not append.

**One everyday analogy, held all the way through.** Pick something physical and
ordinary: keyboards, mailboxes, keys, queues, a coworker at a desk. Do not
switch analogies halfway. Do not stack three.

**Zero jargon.** Not "hook", "adapter", "async", "buffer", "schema", "pane".
If a term genuinely cannot be avoided, define it in the same sentence in
ordinary words and move on.

**Concrete over abstract.** "It typed on the other worker's keyboard while they
were mid-sentence" beats "delivery was synchronous and interrupt-driven".

**Say what is not known.** If part of it is unproven or untested, say so in one
short line. Never smooth it over to make the story cleaner.

**End by asking which part is fuzzy**, naming two or three specific candidates
so the answer is easy. Not a vague "let me know if you have questions".

## Shape that works

1. What the thing is, in one line.
2. What was broken, as a physical picture.
3. What changed.
4. What was actually proven, and what was not.
5. Which part is fuzzy?

## What fails

Being abstract while sounding simple. "Messages are delivered at turn
boundaries instead of synchronously" uses small words and explains nothing.
The test is whether someone who has never seen the code could draw a picture of
it afterwards.

Being long. A brief that needs scrolling is not a brief.

Being condescending. Simple is not the same as talking down. State things
plainly and trust the reader.
