import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildPlistXml,
  cronToLaunchdIntervals,
  dateToLaunchdInterval,
  deleteLastSuccess,
  launchctlIsLoaded,
  launchctlLoad,
  launchctlUnload,
  lastSuccessPath,
  nextCronFire,
  parseCronField,
  parseScheduleMeta,
  prevCronFire,
  readLastSuccess,
  serializeScheduleMeta,
  writeLastSuccess,
  writeScheduleMeta,
  readScheduleMeta,
  listSchedules,
  deleteScheduleMeta,
  type LaunchdInterval,
  type LaunchctlRunner,
  type ScheduleMeta,
} from "../src/schedule.js";

describe("parseCronField", () => {
  it("expands wildcard", () => {
    assert.deepEqual(parseCronField("*", [0, 5]), [0, 1, 2, 3, 4, 5]);
  });

  it("parses single value", () => {
    assert.deepEqual(parseCronField("9", [0, 23]), [9]);
  });

  it("parses range", () => {
    assert.deepEqual(parseCronField("1-5", [0, 6]), [1, 2, 3, 4, 5]);
  });

  it("parses list", () => {
    assert.deepEqual(parseCronField("9,17", [0, 23]), [9, 17]);
  });

  it("parses step over wildcard", () => {
    assert.deepEqual(parseCronField("*/15", [0, 59]), [0, 15, 30, 45]);
  });

  it("parses step over range", () => {
    assert.deepEqual(parseCronField("0-30/10", [0, 59]), [0, 10, 20, 30]);
  });

  it("normalizes Sunday=7 to Sunday=0 for day-of-week", () => {
    assert.deepEqual(parseCronField("7", [0, 7]), [0]);
  });

  it("rejects unsupported syntax (L)", () => {
    assert.throws(() => parseCronField("L", [1, 31]));
  });

  it("rejects unsupported syntax (#)", () => {
    assert.throws(() => parseCronField("5#3", [0, 6]));
  });

  it("rejects out-of-range values", () => {
    assert.throws(() => parseCronField("60", [0, 59]));
  });
});

describe("cronToLaunchdIntervals", () => {
  it("translates '0 9 * * 5' (Friday at 9am) to one dict", () => {
    const out = cronToLaunchdIntervals("0 9 * * 5");
    assert.deepEqual(out, [{ Minute: 0, Hour: 9, Weekday: 5 }]);
  });

  it("translates '*/2 * * * *' (every 2 minutes) to 30 dicts", () => {
    const out = cronToLaunchdIntervals("*/2 * * * *");
    assert.equal(out.length, 30);
    assert.deepEqual(out[0], { Minute: 0 });
    assert.deepEqual(out[1], { Minute: 2 });
    assert.deepEqual(out[29], { Minute: 58 });
  });

  it("translates '0 0 1 * *' (1st of month at midnight) to one dict", () => {
    const out = cronToLaunchdIntervals("0 0 1 * *");
    assert.deepEqual(out, [{ Minute: 0, Hour: 0, Day: 1 }]);
  });

  it("translates '0 9,17 * * 1-5' (9am+5pm weekdays) to 10 dicts", () => {
    const out = cronToLaunchdIntervals("0 9,17 * * 1-5");
    assert.equal(out.length, 10);
    // Sample: Monday 9am should be present
    assert.ok(
      out.some((i: LaunchdInterval) => i.Minute === 0 && i.Hour === 9 && i.Weekday === 1),
      "expected Monday 9am",
    );
    // Sample: Friday 5pm should be present
    assert.ok(
      out.some((i: LaunchdInterval) => i.Minute === 0 && i.Hour === 17 && i.Weekday === 5),
      "expected Friday 5pm",
    );
  });

  it("translates '0 0 * * 0' (Sunday midnight) to one dict with Weekday=0", () => {
    const out = cronToLaunchdIntervals("0 0 * * 0");
    assert.deepEqual(out, [{ Minute: 0, Hour: 0, Weekday: 0 }]);
  });

  it("translates '30 14 * * *' (every day at 2:30pm) to one dict", () => {
    const out = cronToLaunchdIntervals("30 14 * * *");
    assert.deepEqual(out, [{ Minute: 30, Hour: 14 }]);
  });

  it("translates '* * * * *' to 60 Minute-only dicts (no empty dict)", () => {
    const out = cronToLaunchdIntervals("* * * * *");
    assert.equal(out.length, 60);
    // Every interval should have exactly one key (Minute), no empty dicts
    for (const i of out) {
      assert.deepEqual(Object.keys(i), ["Minute"]);
    }
    assert.equal(out[0].Minute, 0);
    assert.equal(out[59].Minute, 59);
  });

  it("rejects fewer than 5 fields", () => {
    assert.throws(() => cronToLaunchdIntervals("0 9 * *"));
  });

  it("rejects more than 5 fields", () => {
    assert.throws(() => cronToLaunchdIntervals("0 0 9 * * 5"));
  });
});

describe("dateToLaunchdInterval", () => {
  it("extracts minute/hour/day/month from a Date", () => {
    const d = new Date(2026, 4, 8, 9, 30, 0); // May 8, 2026, 9:30am local
    assert.deepEqual(dateToLaunchdInterval(d), {
      Minute: 30,
      Hour: 9,
      Day: 8,
      Month: 5,
    });
  });
});

describe("buildPlistXml", () => {
  it("generates a single-dict plist for one interval", () => {
    const xml = buildPlistXml({
      name: "weekly-check",
      intervals: [{ Minute: 0, Hour: 9, Weekday: 5 }],
      wrapperPath: "/Users/test/scripts/dispatch-cron-wrapper.sh",
      logDir: "/Users/test/.dispatch/scheduled-logs",
    });
    assert.ok(xml.includes("<key>Label</key>"));
    assert.ok(xml.includes("<string>com.dispatch.weekly-check</string>"));
    assert.ok(xml.includes("<string>/Users/test/scripts/dispatch-cron-wrapper.sh</string>"));
    assert.ok(xml.includes("<string>weekly-check</string>"));
    assert.ok(xml.includes("<key>StartCalendarInterval</key>"));
    assert.ok(xml.includes("<key>Minute</key>"));
    assert.ok(xml.includes("<integer>0</integer>"));
    assert.ok(xml.includes("<key>Hour</key>"));
    assert.ok(xml.includes("<integer>9</integer>"));
    assert.ok(xml.includes("<key>Weekday</key>"));
    assert.ok(xml.includes("<integer>5</integer>"));
    assert.ok(xml.includes("<string>/Users/test/.dispatch/scheduled-logs/weekly-check.stdout.log</string>"));
    // Should be single dict, not array (one interval)
    assert.ok(!xml.includes("<array>\n            <dict>"));
  });

  it("generates an array-of-dicts plist for multiple intervals", () => {
    const xml = buildPlistXml({
      name: "twice-daily",
      intervals: [
        { Minute: 0, Hour: 9 },
        { Minute: 0, Hour: 17 },
      ],
      wrapperPath: "/usr/local/wrapper.sh",
    });
    assert.ok(xml.includes("<array>"));
    assert.ok(xml.includes("</array>"));
    // Should have two <dict> blocks under StartCalendarInterval
    const dictMatches = xml.match(/<dict>/g) || [];
    // 1 outer plist dict + 2 interval dicts = 3
    assert.equal(dictMatches.length, 3);
  });

  it("snapshot: weekly Friday 9am check", () => {
    const xml = buildPlistXml({
      name: "snapshot-test",
      intervals: [{ Minute: 0, Hour: 9, Weekday: 5 }],
      wrapperPath: "/wrap.sh",
      logDir: "/tmp/logs",
    });
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dispatch.snapshot-test</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/wrap.sh</string>
        <string>snapshot-test</string>
    </array>
    <key>StartCalendarInterval</key>
        <dict>
            <key>Minute</key>
            <integer>0</integer>
            <key>Hour</key>
            <integer>9</integer>
            <key>Weekday</key>
            <integer>5</integer>
        </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/logs/snapshot-test.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/logs/snapshot-test.stderr.log</string>
</dict>
</plist>
`;
    assert.equal(xml, expected);
  });

  it("escapes XML special chars in the name", () => {
    const xml = buildPlistXml({
      name: "evil&name",
      intervals: [{ Minute: 0 }],
      wrapperPath: "/wrap.sh",
    });
    assert.ok(xml.includes("com.dispatch.evil&amp;name"));
  });

  it("rejects empty interval list", () => {
    assert.throws(() =>
      buildPlistXml({ name: "x", intervals: [], wrapperPath: "/x" }),
    );
  });
});

describe("ScheduleMeta YAML roundtrip", () => {
  it("serializes and parses back identically", () => {
    const meta: ScheduleMeta = {
      name: "voice-reliability-check",
      cron: "0 16 * * 5",
      prompt_file: "/Users/test/prompts/voice.md",
      branch_prefix: "reliability",
      model: "opus",
      repo: "/Users/test/git/repo",
      max_turns: "30",
      notify: "slack",
      created_at: "2026-05-01T19:30:00Z",
    };
    const yaml = serializeScheduleMeta(meta);
    const parsed = parseScheduleMeta(yaml);
    assert.deepEqual(parsed, meta);
  });

  it("roundtrips one-off schedules with run_once: true", () => {
    const meta: ScheduleMeta = {
      name: "one-off",
      run_once: true,
      run_at: "2026-05-08T16:00:00.000Z",
      prompt_file: "/x.md",
      created_at: "2026-05-01T19:30:00.000Z",
    };
    const parsed = parseScheduleMeta(serializeScheduleMeta(meta));
    assert.equal(parsed.run_once, true);
    assert.equal(parsed.run_at, "2026-05-08T16:00:00.000Z");
    assert.equal(parsed.prompt_file, "/x.md");
  });

  it("preserves command field with embedded quotes", () => {
    const meta: ScheduleMeta = {
      name: "echo-test",
      cron: "* * * * *",
      command: 'echo "hello world"',
      created_at: "2026-05-01T00:00:00Z",
    };
    const parsed = parseScheduleMeta(serializeScheduleMeta(meta));
    assert.equal(parsed.command, 'echo "hello world"');
  });

  it("writes and reads from a temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-sched-"));
    const meta: ScheduleMeta = {
      name: "temp-test",
      cron: "0 9 * * 1",
      prompt_file: "/p.md",
      created_at: "2026-05-01T00:00:00Z",
    };
    writeScheduleMeta(meta, dir);
    const back = readScheduleMeta("temp-test", dir);
    assert.deepEqual(back, meta);

    const all = listSchedules(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, "temp-test");

    deleteScheduleMeta("temp-test", dir);
    assert.equal(listSchedules(dir).length, 0);
  });

  it("rejects metadata without required fields", () => {
    assert.throws(() => parseScheduleMeta("cron: 0 9 * * 5"));
  });
});

describe("prevCronFire", () => {
  it("finds the slot at exactly `from` if it matches", () => {
    // Friday, May 1, 2026 at 16:00 — matches "0 16 * * 5"
    const friday4pm = new Date(2026, 4, 1, 16, 0, 0);
    const got = prevCronFire("0 16 * * 5", friday4pm);
    assert.ok(got);
    assert.equal(got!.getTime(), friday4pm.getTime());
  });

  it("walks back to last Friday from a Monday", () => {
    // Monday, May 4, 2026 at 10:00. The most recent matching slot is the
    // immediately-preceding Friday at 16:00 (May 1, 2026 — three days back).
    const monday = new Date(2026, 4, 4, 10, 0, 0);
    const got = prevCronFire("0 16 * * 5", monday);
    assert.ok(got);
    const expected = new Date(2026, 4, 1, 16, 0, 0);
    assert.equal(got!.getTime(), expected.getTime());
  });

  it("walks back across week boundary when before Friday's slot", () => {
    // Friday, May 1, 2026 at 09:00 — Friday 4pm hasn't happened yet today,
    // so prev fire is the previous Friday (April 24) at 16:00.
    const fridayMorning = new Date(2026, 4, 1, 9, 0, 0);
    const got = prevCronFire("0 16 * * 5", fridayMorning);
    assert.ok(got);
    const expected = new Date(2026, 3, 24, 16, 0, 0);
    assert.equal(got!.getTime(), expected.getTime());
  });

  it("walks back to previous matching slot for hourly cron", () => {
    const t = new Date(2026, 4, 1, 13, 35, 0);
    const got = prevCronFire("0 * * * *", t);
    assert.ok(got);
    // 13:00 on the same day
    const expected = new Date(2026, 4, 1, 13, 0, 0);
    assert.equal(got!.getTime(), expected.getTime());
  });

  it("nextCronFire and prevCronFire bracket `from`", () => {
    const t = new Date(2026, 4, 1, 12, 30, 0);
    const next = nextCronFire("0 * * * *", t);
    const prev = prevCronFire("0 * * * *", t);
    assert.ok(next && prev);
    assert.ok(prev!.getTime() < t.getTime());
    assert.ok(next!.getTime() > t.getTime());
  });
});

describe("last_success state file", () => {
  it("round-trips a timestamp through write/read/delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-state-"));
    const when = new Date("2026-05-01T20:00:00.000Z");

    assert.equal(readLastSuccess("foo", dir), null);

    writeLastSuccess("foo", when, dir);
    const got = readLastSuccess("foo", dir);
    assert.ok(got);
    assert.equal(got!.toISOString(), when.toISOString());

    const path = lastSuccessPath("foo", dir);
    assert.ok(path.endsWith("foo.last_success"));

    deleteLastSuccess("foo", dir);
    assert.equal(readLastSuccess("foo", dir), null);
  });

  it("readLastSuccess returns null for unparseable contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-state-"));
    writeFileSync(join(dir, "bad.last_success"), "not-a-date\n");
    assert.equal(readLastSuccess("bad", dir), null);
  });
});

describe("launchctl wrappers (mocked)", () => {
  it("launchctlLoad invokes 'launchctl load -w <plist>'", () => {
    const calls: string[][] = [];
    const runner: LaunchctlRunner = (args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    launchctlLoad("/tmp/x.plist", runner);
    assert.deepEqual(calls, [["load", "-w", "/tmp/x.plist"]]);
  });

  it("launchctlLoad throws on failure", () => {
    const runner: LaunchctlRunner = () => ({ status: 1, stdout: "", stderr: "boom" });
    assert.throws(() => launchctlLoad("/tmp/x.plist", runner), /boom/);
  });

  it("launchctlLoad tolerates 'already loaded'", () => {
    const runner: LaunchctlRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "service already loaded",
    });
    // Should not throw
    launchctlLoad("/tmp/x.plist", runner);
  });

  it("launchctlUnload swallows 'Could not find' (idempotent)", () => {
    const runner: LaunchctlRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "Could not find specified service",
    });
    launchctlUnload("/tmp/x.plist", runner);
  });

  it("launchctlIsLoaded returns true when label is present", () => {
    const runner: LaunchctlRunner = () => ({
      status: 0,
      stdout: "PID\tStatus\tLabel\n1234\t0\tcom.dispatch.weekly-check\n5678\t0\tcom.apple.foo\n",
      stderr: "",
    });
    assert.equal(launchctlIsLoaded("com.dispatch.weekly-check", runner), true);
    assert.equal(launchctlIsLoaded("com.dispatch.missing", runner), false);
  });
});
