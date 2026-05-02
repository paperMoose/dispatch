import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir, platform } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Filesystem layout
// ---------------------------------------------------------------------------
export const SCHEDULE_META_DIR = join(homedir(), ".dispatch", "schedules");
export const SCHEDULE_LOG_DIR = join(homedir(), ".dispatch", "scheduled-logs");
export const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");

export function plistPath(name: string, baseDir: string = LAUNCH_AGENTS_DIR): string {
  return join(baseDir, `com.dispatch.${name}.plist`);
}

export function metaPath(name: string, baseDir: string = SCHEDULE_META_DIR): string {
  return join(baseDir, `${name}.yml`);
}

export function lastSuccessPath(name: string, baseDir: string = SCHEDULE_META_DIR): string {
  return join(baseDir, `${name}.last_success`);
}

export function readLastSuccess(name: string, baseDir: string = SCHEDULE_META_DIR): Date | null {
  const path = lastSuccessPath(name, baseDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return null;
    return new Date(t);
  } catch {
    return null;
  }
}

export function writeLastSuccess(name: string, when: Date = new Date(), baseDir: string = SCHEDULE_META_DIR): void {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  writeFileSync(lastSuccessPath(name, baseDir), when.toISOString() + "\n");
}

export function deleteLastSuccess(name: string, baseDir: string = SCHEDULE_META_DIR): void {
  const path = lastSuccessPath(name, baseDir);
  if (existsSync(path)) unlinkSync(path);
}

export function plistLabel(name: string): string {
  return `com.dispatch.${name}`;
}

export function ensureMacOS(): void {
  if (platform() !== "darwin") {
    throw new Error(
      "dispatch schedule is macOS-only (uses launchd). Detected: " + platform(),
    );
  }
}

// ---------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------
export interface LaunchdInterval {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
}

type Range = readonly [number, number];

const MIN_RANGE: Range = [0, 59];
const HOUR_RANGE: Range = [0, 23];
const DOM_RANGE: Range = [1, 31];
const MONTH_RANGE: Range = [1, 12];
// cron supports 0 or 7 for Sunday; launchd uses 0 = Sunday. Normalize 7 → 0.
const DOW_RANGE: Range = [0, 7];

const UNSUPPORTED_CRON_RE = /[LW#?]/;

/** Parse a single cron field into a sorted, deduped list of integer values. */
export function parseCronField(spec: string, range: Range): number[] {
  if (UNSUPPORTED_CRON_RE.test(spec)) {
    throw new Error(`Unsupported cron syntax in "${spec}" (L, W, #, ? are not supported)`);
  }
  const [min, max] = range;
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Empty cron component in "${spec}"`);

    let step = 1;
    let body = trimmed;
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      body = trimmed.slice(0, slashIdx);
      const stepStr = trimmed.slice(slashIdx + 1);
      const parsedStep = Number(stepStr);
      if (!Number.isInteger(parsedStep) || parsedStep <= 0) {
        throw new Error(`Invalid step "${stepStr}" in "${spec}"`);
      }
      step = parsedStep;
    }

    let from: number;
    let to: number;
    if (body === "*" || body === "") {
      from = min;
      to = max;
    } else if (body.includes("-")) {
      const [aStr, bStr] = body.split("-");
      const a = Number(aStr);
      const b = Number(bStr);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`Invalid range "${body}" in "${spec}"`);
      }
      from = a;
      to = b;
    } else {
      const v = Number(body);
      if (!Number.isInteger(v)) throw new Error(`Invalid value "${body}" in "${spec}"`);
      from = v;
      to = v;
    }

    if (from < min || to > max || from > to) {
      throw new Error(`Value ${from}-${to} out of range [${min}-${max}] in "${spec}"`);
    }

    for (let i = from; i <= to; i += step) values.add(i);
  }
  // Normalize Sunday (cron allows 7, launchd wants 0). Day-of-week is the
  // only field whose max is 7, so identify by range value rather than by
  // object identity (callers may pass freshly-built tuples).
  if (range[0] === DOW_RANGE[0] && range[1] === DOW_RANGE[1] && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return [...values].sort((a, b) => a - b);
}

/** Translate a 5-field cron expression to launchd StartCalendarInterval entries. */
export function cronToLaunchdIntervals(cron: string): LaunchdInterval[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${cron}"`,
    );
  }
  const [minSpec, hourSpec, domSpec, monSpec, dowSpec] = fields;
  const minutes = parseCronField(minSpec, MIN_RANGE);
  const hours = parseCronField(hourSpec, HOUR_RANGE);
  const days = parseCronField(domSpec, DOM_RANGE);
  const months = parseCronField(monSpec, MONTH_RANGE);
  const weekdays = parseCronField(dowSpec, DOW_RANGE);

  // For each field, "*" means "every value" and we should OMIT it from the
  // launchd dict (omitted keys = wildcard). For step expressions like "*/2",
  // the field is NOT a wildcard — we must enumerate the matching values.
  const isWild = (spec: string): boolean => spec === "*";
  let wildMin = isWild(minSpec);
  const wildHour = isWild(hourSpec);
  const wildDay = isWild(domSpec);
  const wildMonth = isWild(monSpec);
  const wildDow = isWild(dowSpec);

  // Guard against shipping a launchd dict with zero keys. If every field is
  // wildcard ("* * * * *" — every minute), enumerate Minute explicitly so the
  // plist contains real constraints. Empty <dict/> is undocumented territory
  // in launchd; relying on it is fragile across macOS versions.
  if (wildMin && wildHour && wildDay && wildMonth && wildDow) {
    wildMin = false;
  }

  const intervals: LaunchdInterval[] = [];
  const minSet: (number | undefined)[] = wildMin ? [undefined] : minutes;
  const hourSet: (number | undefined)[] = wildHour ? [undefined] : hours;
  const daySet: (number | undefined)[] = wildDay ? [undefined] : days;
  const monthSet: (number | undefined)[] = wildMonth ? [undefined] : months;
  const dowSet: (number | undefined)[] = wildDow ? [undefined] : weekdays;

  for (const m of minSet) {
    for (const h of hourSet) {
      for (const d of daySet) {
        for (const mo of monthSet) {
          for (const w of dowSet) {
            const interval: LaunchdInterval = {};
            if (m !== undefined) interval.Minute = m;
            if (h !== undefined) interval.Hour = h;
            if (d !== undefined) interval.Day = d;
            if (mo !== undefined) interval.Month = mo;
            if (w !== undefined) interval.Weekday = w;
            intervals.push(interval);
          }
        }
      }
    }
  }

  return intervals;
}

interface CronSets {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
}

function buildCronSets(cron: string): CronSets | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  try {
    return {
      minutes: new Set(parseCronField(fields[0], MIN_RANGE)),
      hours: new Set(parseCronField(fields[1], HOUR_RANGE)),
      days: new Set(parseCronField(fields[2], DOM_RANGE)),
      months: new Set(parseCronField(fields[3], MONTH_RANGE)),
      weekdays: new Set(parseCronField(fields[4], DOW_RANGE)),
    };
  } catch {
    return null;
  }
}

function cronMatches(s: CronSets, t: Date): boolean {
  return (
    s.minutes.has(t.getMinutes()) &&
    s.hours.has(t.getHours()) &&
    s.days.has(t.getDate()) &&
    s.months.has(t.getMonth() + 1) &&
    s.weekdays.has(t.getDay())
  );
}

/** Compute the next time a cron expression will fire after `from`. Returns null if none within a year. */
export function nextCronFire(cron: string, from: Date = new Date()): Date | null {
  const sets = buildCronSets(cron);
  if (!sets) return null;

  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);

  const maxIter = 60 * 24 * 366;
  for (let i = 0; i < maxIter; i++) {
    if (cronMatches(sets, t)) return new Date(t);
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

/** Compute the most recent time a cron expression should have fired at or before `from`.
 *  Returns null if there's no match within the last year (unsatisfiable expression). */
export function prevCronFire(cron: string, from: Date = new Date()): Date | null {
  const sets = buildCronSets(cron);
  if (!sets) return null;

  const t = new Date(from);
  t.setSeconds(0, 0);
  // "at or before from" — start at the current minute and walk backward.

  const maxIter = 60 * 24 * 366;
  for (let i = 0; i < maxIter; i++) {
    if (cronMatches(sets, t)) return new Date(t);
    t.setMinutes(t.getMinutes() - 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plist generation
// ---------------------------------------------------------------------------
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function intervalDictXml(interval: LaunchdInterval, indent: string): string {
  const keys: [keyof LaunchdInterval, string][] = [
    ["Minute", "Minute"],
    ["Hour", "Hour"],
    ["Day", "Day"],
    ["Month", "Month"],
    ["Weekday", "Weekday"],
  ];
  const lines: string[] = [`${indent}<dict>`];
  for (const [k, name] of keys) {
    const v = interval[k];
    if (v === undefined) continue;
    lines.push(`${indent}    <key>${name}</key>`);
    lines.push(`${indent}    <integer>${v}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines.join("\n");
}

export interface PlistOptions {
  name: string;
  intervals: LaunchdInterval[];
  wrapperPath: string;
  logDir?: string;
  /** Absolute path to the dispatch CLI binary. Baked into the plist's
   *  EnvironmentVariables so the wrapper can find dispatch even when launchd
   *  spawns it without nvm/node-version-manager paths in PATH. */
  dispatchBin?: string;
}

export function buildPlistXml(opts: PlistOptions): string {
  const { name, intervals, wrapperPath, dispatchBin } = opts;
  const logDir = opts.logDir ?? SCHEDULE_LOG_DIR;
  if (intervals.length === 0) {
    throw new Error("Cannot build plist: no calendar intervals");
  }

  const intervalsBlock =
    intervals.length === 1
      ? intervalDictXml(intervals[0], "        ")
      : `        <array>\n${intervals.map((i) => intervalDictXml(i, "            ")).join("\n")}\n        </array>`;

  const envBlock = dispatchBin
    ? `    <key>EnvironmentVariables</key>
    <dict>
        <key>DISPATCH_BIN</key>
        <string>${escapeXml(dispatchBin)}</string>
    </dict>
`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(plistLabel(name))}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${escapeXml(wrapperPath)}</string>
        <string>${escapeXml(name)}</string>
    </array>
${envBlock}    <key>StartCalendarInterval</key>
${intervalsBlock}
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(logDir, `${name}.stdout.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(logDir, `${name}.stderr.log`))}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Schedule metadata (YAML serialization)
// ---------------------------------------------------------------------------
export interface ScheduleMeta {
  name: string;
  cron?: string;
  run_once?: boolean;
  run_at?: string;
  /** @deprecated Path-based prompts depend on a file that may not exist when
   *  the schedule fires (e.g. user installed via `npm i -g dispatch` and the
   *  source file was removed). Kept for backward compat with old schedules;
   *  new ones inline the prompt as `prompt_b64`. */
  prompt_file?: string;
  /** Base64-encoded prompt content. Inlined at schedule-add time so the
   *  schedule is self-contained and survives without the originating file. */
  prompt_b64?: string;
  command?: string;
  branch_prefix?: string;
  model?: string;
  repo?: string;
  max_turns?: string;
  notify?: string;
  created_at: string;
}

const META_FIELDS: (keyof ScheduleMeta)[] = [
  "name",
  "cron",
  "run_once",
  "run_at",
  "prompt_file",
  "prompt_b64",
  "command",
  "branch_prefix",
  "model",
  "repo",
  "max_turns",
  "notify",
  "created_at",
];

export function serializeScheduleMeta(meta: ScheduleMeta): string {
  const lines: string[] = [];
  for (const field of META_FIELDS) {
    const v = meta[field];
    if (v === undefined || v === "") continue;
    if (typeof v === "boolean") {
      lines.push(`${field}: ${v ? "true" : "false"}`);
    } else {
      // Always quote string values to keep them robust for shell parsing.
      // Escape any embedded double-quotes.
      const safe = String(v).replace(/"/g, '\\"');
      lines.push(`${field}: "${safe}"`);
    }
  }
  return lines.join("\n") + "\n";
}

export function parseScheduleMeta(content: string): ScheduleMeta {
  const out: Record<string, string | boolean> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else out[key] = value;
  }
  if (!out.name || !out.created_at) {
    throw new Error("Schedule metadata missing required fields (name, created_at)");
  }
  return out as unknown as ScheduleMeta;
}

export function readScheduleMeta(name: string, baseDir = SCHEDULE_META_DIR): ScheduleMeta {
  const path = metaPath(name, baseDir);
  if (!existsSync(path)) {
    throw new Error(`No schedule metadata for "${name}" at ${path}`);
  }
  return parseScheduleMeta(readFileSync(path, "utf-8"));
}

export function writeScheduleMeta(meta: ScheduleMeta, baseDir = SCHEDULE_META_DIR): string {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const path = metaPath(meta.name, baseDir);
  writeFileSync(path, serializeScheduleMeta(meta));
  return path;
}

/** Encode prompt text for inline storage. Base64 keeps it on a single YAML
 *  line so the wrapper's grep-based parser works without a real YAML lib. */
export function encodePromptText(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

export function decodePromptText(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf-8");
}

export function listSchedules(baseDir = SCHEDULE_META_DIR): ScheduleMeta[] {
  if (!existsSync(baseDir)) return [];
  const files = readdirSync(baseDir).filter((f) => f.endsWith(".yml"));
  const out: ScheduleMeta[] = [];
  for (const f of files) {
    try {
      out.push(parseScheduleMeta(readFileSync(join(baseDir, f), "utf-8")));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function deleteScheduleMeta(name: string, baseDir = SCHEDULE_META_DIR): void {
  const path = metaPath(name, baseDir);
  if (existsSync(path)) unlinkSync(path);
}

// ---------------------------------------------------------------------------
// Wrapper script discovery
// ---------------------------------------------------------------------------
/** Locate the bundled wrapper script. We look up from the running CLI's location. */
export function findWrapperScript(): string {
  // dist/cli.js → ../scripts/dispatch-cron-wrapper.sh (when packaged)
  // src/schedule.ts → ../scripts/dispatch-cron-wrapper.sh (when running from source via tsx)
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "scripts", "dispatch-cron-wrapper.sh"),
    resolve(here, "..", "..", "scripts", "dispatch-cron-wrapper.sh"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate dispatch-cron-wrapper.sh. Searched: ${candidates.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// One-off (--at) translation
// ---------------------------------------------------------------------------
/** Convert a single moment in time to a one-element StartCalendarInterval list. */
export function dateToLaunchdInterval(d: Date): LaunchdInterval {
  return {
    Minute: d.getMinutes(),
    Hour: d.getHours(),
    Day: d.getDate(),
    Month: d.getMonth() + 1,
  };
}

// ---------------------------------------------------------------------------
// launchctl wrappers (thin — easy to mock by overriding `runner`)
// ---------------------------------------------------------------------------
export type LaunchctlRunner = (args: string[]) => { status: number; stdout: string; stderr: string };

export const realLaunchctl: LaunchctlRunner = (args) => {
  const r = spawnSync("launchctl", args, { encoding: "utf-8" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

export function launchctlLoad(plist: string, runner: LaunchctlRunner = realLaunchctl): void {
  const r = runner(["load", "-w", plist]);
  if (r.status !== 0 && !/already loaded/i.test(r.stderr)) {
    throw new Error(`launchctl load failed: ${r.stderr || r.stdout}`);
  }
}

export function launchctlUnload(plist: string, runner: LaunchctlRunner = realLaunchctl): void {
  const r = runner(["unload", "-w", plist]);
  if (r.status !== 0 && !/Could not find/i.test(r.stderr)) {
    // Don't hard-fail — caller is usually deleting anyway — but surface the
    // error so the user has a chance to spot misconfiguration.
    const msg = (r.stderr || r.stdout || "").trim();
    if (msg) console.error(`\x1b[0;33m⚠\x1b[0m launchctl unload reported: ${msg}`);
  }
}

export function launchctlIsLoaded(label: string, runner: LaunchctlRunner = realLaunchctl): boolean {
  const r = runner(["list"]);
  if (r.status !== 0) return false;
  for (const line of r.stdout.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts[parts.length - 1] === label) return true;
  }
  return false;
}
