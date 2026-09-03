import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** Installing "check your mail at the end of every turn" on a launched agent.
 *
 *  Both runtimes support it and both were proven end to end, but they are
 *  configured differently: Claude reads a settings file out of the worktree,
 *  Codex takes its hook config as launch flags and persists nothing. What is
 *  shared is the script they both run, so that lives here and the per-runtime
 *  wiring is one method on AgentAdapter.
 *
 *  Everything in this file that decides something is a pure function taking
 *  and returning values, because the alternative is a test that has to launch
 *  a real agent to find out whether a JSON merge was right. */

/** The script both runtimes execute at the end of a turn. Lives in the agent's
 *  own worktree, and is listed in DISPATCH_ARTIFACTS so git never sees it. */
export const HOOK_SCRIPT = ".dispatch-inbox-hook.sh";

/** A hook runs with a cwd we do not control, and `thread inbox` works out who
 *  it is from that cwd. So the script cds to the worktree explicitly rather
 *  than trusting the runtime, and runs the same dispatch that launched the
 *  agent rather than whatever `dispatch` happens to be on PATH — a global
 *  install one version behind would answer with a different schema. */
export function hookScriptBody(wtPath: string, nodeBin: string, cliPath: string): string {
  return [
    "#!/bin/sh",
    "# Written by dispatch. Runs when the agent finishes a turn: prints what",
    "# the agent is owed from its threads, and nothing at all when it is owed",
    "# nothing. Silence is what lets the agent stop.",
    "# Both runtimes hand the hook a JSON payload on stdin carrying",
    "# stop_hook_active: true once a stop hook has already made this turn",
    "# continue. Bailing there bounds us to one injection per real turn end,",
    "# whatever goes wrong. Normally the brake is that delivery gets recorded",
    "# and the next inbox is empty; if that record ever fails to write, this is",
    "# what stops an agent being handed the same message forever.",
    "IN=$(cat 2>/dev/null || true)",
    'case "$IN" in *\'"stop_hook_active":true\'*|*\'"stop_hook_active": true\'*) exit 0 ;; esac',
    `cd ${shq(wtPath)} || exit 0`,
    `exec ${shq(nodeBin)} ${shq(cliPath)} thread inbox --hook`,
    "",
  ].join("\n");
}

/** Single-quote for /bin/sh. Worktree paths come from a branch name, which is
 *  attacker-adjacent: a ticket title becomes a branch becomes this path. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function writeHookScript(wtPath: string, nodeBin: string, cliPath: string): string {
  const path = join(wtPath, HOOK_SCRIPT);
  writeFileSync(path, hookScriptBody(wtPath, nodeBin, cliPath), { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** Claude's settings with our Stop hook added, leaving everything else alone.
 *
 *  Merged rather than written fresh: the file may already carry permissions,
 *  MCP servers or other hooks that the repository depends on, and clobbering
 *  those to deliver a message would be a poor trade. Existing Stop entries are
 *  kept; ours is appended, and appending twice is avoided by matching on the
 *  command, so relaunching an agent does not stack duplicates. */
export function mergeClaudeHookSettings(
  existing: Record<string, unknown> | null,
  scriptPath: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing || {}) };
  const hooks: Record<string, unknown> = { ...((out.hooks as Record<string, unknown>) || {}) };
  const stop = Array.isArray(hooks.Stop) ? [...(hooks.Stop as unknown[])] : [];

  const already = stop.some((entry) =>
    JSON.stringify(entry).includes(scriptPath),
  );
  if (!already) {
    stop.push({ hooks: [{ type: "command", command: scriptPath, timeout: 15 }] });
  }
  hooks.Stop = stop;
  out.hooks = hooks;
  return out;
}

/** Written to settings.local.json, not settings.json.
 *
 *  settings.json is a tracked file in most repositories; editing it dirties
 *  the agent's own diff and shows up in its PR. The .local variant is the
 *  conventional per-checkout overlay, and it is excluded from git alongside
 *  dispatch's other artifacts. */
export const CLAUDE_LOCAL_SETTINGS = join(".claude", "settings.local.json");

export function installClaudeHook(wtPath: string, scriptPath: string): void {
  const path = join(wtPath, CLAUDE_LOCAL_SETTINGS);
  mkdirSync(dirname(path), { recursive: true });
  let existing: Record<string, unknown> | null = null;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      // A corrupt overlay is not worth failing a launch over, and it is ours
      // to own: start clean rather than refusing to deliver messages forever.
      existing = null;
    }
  }
  writeFileSync(path, JSON.stringify(mergeClaudeHookSettings(existing, scriptPath), null, 2) + "\n");
}

/** Codex takes hook config as launch flags and writes nothing to disk.
 *
 *  `--dangerously-bypass-hook-trust` is required because Codex otherwise wants
 *  a human to review a hook before it runs, and a headless agent has nobody to
 *  ask. The flag is narrow in scope here: the hook it authorises is a script
 *  dispatch just wrote, in a worktree dispatch just created, running the same
 *  dispatch binary. cmux's own Codex integration does the same thing. */
export function codexHookArgs(scriptPath: string): string {
  const entry = `[{hooks=[{type="command",command="${scriptPath}",timeout=15000}]}]`;
  return `--enable hooks --dangerously-bypass-hook-trust -c 'hooks.Stop=${entry}'`;
}
