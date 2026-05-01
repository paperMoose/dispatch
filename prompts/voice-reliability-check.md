# Weekly voice-agent reliability check

You are running as a scheduled headless agent. Your job is to compute reliability metrics for Noah's voice agent over the last 7 days, compare them to the Apr 28 baseline, and post the result to Ryan on Slack.

## Setup

1. `cd ~/git/vunda-customers/noah/repos/noah-server`
2. `source env.dev` (puts dev DB credentials and Django config on the env)
3. Confirm Django shell starts:
   ```
   uv run python manage.py shell -c 'from agents.models import CallRun; print(CallRun.objects.count())'
   ```
   If that fails, abort and post the error to Slack — do not invent numbers.

## Metrics to compute

Window: `started_at >= now() - interval '7 days'`. Include only `CallRun` rows whose call has actually completed (`ended_at IS NOT NULL`).

Use the Django ORM via `uv run python manage.py shell`. Do not run raw SQL unless the ORM is genuinely insufficient.

For each metric, report `n / total = rate%` and the absolute change vs. the Apr 28 baseline (which Ryan will eyeball — just narrate it).

1. **`ivr_stuck` rate** — fraction of calls whose final outcome / phase tag indicates the agent got stuck inside an IVR tree without escalating. Look at `CallRun.outcome`, `phase`, and any `ivr_state` audit fields.
2. **`fallback_human` timer fires** — count of calls where the "ask for human" fallback timer fired. Look for `fallback_human_fired_at`, `fallback_human=True`, or matching events in `CallEvent` / equivalent.
3. **IVR navigator turn counts** — distribution (median, p90, max) of turn counts spent in IVR phases. If the schema doesn't expose turns directly, count `CallTurn` rows with `phase` matching `ivr_*`.
4. **Post-call SMS honesty** — for calls with an outbound SMS in the 10 minutes after `ended_at`, fraction whose SMS body matches the recorded outcome (e.g. an SMS claiming "appointment booked" should not be paired with a `failed_to_book` outcome). A simple keyword-vs-outcome check is fine; do NOT over-engineer the matcher.
5. **HEY-2197 pre-dial gate trigger rate** — fraction of attempted calls where the pre-dial gate aborted before dialing. Look for the gate's marker on `CallRun` (likely `pre_dial_aborted=True`, a `gate_*` outcome, or events with `event_type='pre_dial_gate_blocked'`).

For each metric, dump 2–3 example `CallRun.id`s so Ryan can spot-check.

## Regression flags

After computing metrics, check the linked tickets for known regressions and explicitly call out anything that looks worse than baseline:
- HEY-2182, HEY-2194, HEY-2195, HEY-2196, HEY-2197

If any metric has degraded materially (>20% relative, or moved across an obvious threshold), tag it as **REGRESSION** in the summary. Otherwise tag it **OK**.

## Output

Compose a single Slack-friendly summary. Format:

```
*Voice reliability — week ending {YYYY-MM-DD}*
• ivr_stuck:           {n}/{total} = {rate}%   (baseline {baseline}%)  [OK|REGRESSION]
• fallback_human:      {n}/{total} = {rate}%   (baseline {baseline}%)  [OK|REGRESSION]
• ivr_navigator turns: median {m}, p90 {p}, max {x}                    [OK|REGRESSION]
• post-call SMS honesty: {n}/{total} matched = {rate}%                 [OK|REGRESSION]
• HEY-2197 pre-dial gate: {n}/{total} aborted = {rate}%                [OK|REGRESSION]

Regressions vs baseline:
- {bullet per flagged metric, with example CallRun ids}

Ticket watch (HEY-2182/2194/2195/2196/2197): {one-line status}
```

Keep it under ~30 lines.

## Posting to Slack

There is currently **no clean send-only Slack helper** in `~/git/cursor-crm/scripts/`. `slack_dump.py` is read-only.

Try, in this order, until one works:

1. `python3 ~/git/cursor-crm/scripts/slack_send.py` — if it exists by the time you run, prefer it.
2. Use the Slack API directly via `curl` and the token in `secret-agent` (look for a `SLACK_TOKEN` or `SLACK_BOT_TOKEN` secret). DM Ryan (Slack ID `U0A84V7NSFP`):
   ```
   curl -s -X POST https://slack.com/api/chat.postMessage \
     -H "Authorization: Bearer $SLACK_TOKEN" \
     -H "Content-Type: application/json; charset=utf-8" \
     --data "{\"channel\":\"U0A84V7NSFP\",\"text\":\"...\"}"
   ```
3. If neither works, write the summary to `~/.dispatch/scheduled-logs/voice-reliability-{date}.md` and end your final assistant message with the same summary so it's visible in the agent log.

Do **not** post anywhere other than DM-to-Ryan. No public channels.

## Hard rules

- This is a **read-only** investigation. Do not write to the database, do not modify code, do not commit or push.
- Do not invent numbers. If a query fails or the schema is different from what's described above, say so explicitly in the Slack message.
- Stop after the summary is posted. No follow-up loops.
