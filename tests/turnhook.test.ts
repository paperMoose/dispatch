// Installing "check your mail when you finish a turn" on a launched agent.
//
// The live proof that a hook fires and its output reaches the model is in the
// walkthrough in docs/SPEC-hook-delivery.md, run against real agents of both
// runtimes. What is here is the wiring around it: the script that gets written,
// the JSON merge that must not clobber a repository's own settings, and the
// flags Codex is launched with.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getAdapter } from "../src/agents.js";
import type { Config } from "../src/config.js";
import {
  CLAUDE_LOCAL_SETTINGS,
  HOOK_SCRIPT,
  codexHookArgs,
  hookScriptBody,
  installClaudeHook,
  mergeClaudeHookSettings,
  writeHookScript,
} from "../src/turnhook.js";

const wt = () => mkdtempSync(join(tmpdir(), "dispatch-hook-"));

describe("the script both runtimes run", () => {
  it("cds to the worktree rather than trusting the runtime's cwd", () => {
    // `thread inbox` works out which agent it is from cwd, and a hook runs
    // with a cwd we do not control. Get this wrong and an agent either has no
    // identity or, worse, adopts another agent's.
    const body = hookScriptBody("/repo/.worktrees/hey-837", "/usr/bin/node", "/cli.js");
    assert.ok(body.includes("cd '/repo/.worktrees/hey-837'"));
  });

  it("runs the dispatch that launched the agent, not one from PATH", () => {
    // A global install a version behind answers with a different schema, and
    // the symptom is an agent that silently ignores its mail.
    const body = hookScriptBody("/wt", "/opt/node", "/some/where/dist/cli.js");
    assert.ok(body.includes("'/opt/node' '/some/where/dist/cli.js' thread inbox --hook"));
  });

  it("asks for the hook envelope, not the human-readable form", () => {
    assert.ok(hookScriptBody("/wt", "node", "cli").includes("--hook"));
  });

  it("survives a path with a quote in it", () => {
    // A worktree path comes from a branch name, which comes from a ticket
    // title. That is untrusted text reaching a shell script.
    const body = hookScriptBody("/tmp/it's here", "/bin/node", "/cli.js");
    assert.ok(body.includes(`'/tmp/it'\\''s here'`), body);
  });

  it("exits quietly if the worktree is gone, rather than erroring every turn", () => {
    assert.ok(hookScriptBody("/wt", "n", "c").includes("|| exit 0"));
  });

  it("bails when a stop hook already made this turn continue", () => {
    // The loop brake of last resort. Normally an empty inbox stops the cycle,
    // because delivery is recorded after emission. If that record ever fails
    // to write, the same message would be handed over forever; both runtimes
    // report stop_hook_active on a hook-induced continuation, so one
    // injection per real turn end is the ceiling regardless.
    const body = hookScriptBody("/wt", "n", "c");
    assert.ok(body.includes("stop_hook_active"), "guard missing");
    assert.ok(/case .\$IN. in/.test(body), "guard should test the stdin payload");
    const guardLine = body.split("\n").findIndex((l) => l.includes("stop_hook_active\":true"));
    const execLine = body.split("\n").findIndex((l) => l.includes("thread inbox"));
    assert.ok(guardLine !== -1 && guardLine < execLine, "guard must come before the fetch");
  });

  it("tolerates a runtime that pipes it nothing", () => {
    // Run by hand, or by a runtime that sends no payload, `cat` would
    // otherwise hang the hook and stall every turn.
    assert.ok(hookScriptBody("/wt", "n", "c").includes("cat 2>/dev/null || true"));
  });

  it("is written executable, or the runtime cannot run it", () => {
    const dir = wt();
    const path = writeHookScript(dir, "/bin/node", "/cli.js");
    assert.equal(path, join(dir, HOOK_SCRIPT));
    assert.ok(existsSync(path));
    assert.ok(statSync(path).mode & 0o100, "owner execute bit should be set");
  });
});

describe("merging into Claude's settings", () => {
  it("adds a Stop hook when there is nothing there", () => {
    const out = mergeClaudeHookSettings(null, "/wt/.dispatch-inbox-hook.sh") as any;
    assert.equal(out.hooks.Stop.length, 1);
    assert.equal(out.hooks.Stop[0].hooks[0].command, "/wt/.dispatch-inbox-hook.sh");
  });

  it("leaves every other setting alone", () => {
    // The file may carry permissions or MCP servers the repository depends on.
    // Clobbering those to deliver a message would be a poor trade.
    const out = mergeClaudeHookSettings(
      { permissions: { allow: ["Bash(ls:*)"] }, model: "opus" },
      "/wt/h.sh",
    ) as any;
    assert.deepEqual(out.permissions, { allow: ["Bash(ls:*)"] });
    assert.equal(out.model, "opus");
  });

  it("keeps Stop hooks that were already there", () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "theirs.sh" }] }] } };
    const out = mergeClaudeHookSettings(existing, "/wt/ours.sh") as any;
    assert.equal(out.hooks.Stop.length, 2);
    assert.ok(JSON.stringify(out).includes("theirs.sh"));
  });

  it("keeps other hook events intact", () => {
    const existing = { hooks: { UserPromptSubmit: [{ hooks: [{ command: "x.sh" }] }] } };
    const out = mergeClaudeHookSettings(existing, "/wt/ours.sh") as any;
    assert.ok(out.hooks.UserPromptSubmit);
    assert.equal(out.hooks.Stop.length, 1);
  });

  it("does not stack duplicates when an agent is relaunched", () => {
    // `dispatch resume` re-runs launch. Without this, an agent resumed five
    // times fetches its mail five times per turn.
    let out = mergeClaudeHookSettings(null, "/wt/h.sh");
    out = mergeClaudeHookSettings(out, "/wt/h.sh");
    out = mergeClaudeHookSettings(out, "/wt/h.sh");
    assert.equal((out as any).hooks.Stop.length, 1);
  });

  it("writes to settings.local.json, not the tracked settings.json", () => {
    // Editing the tracked file dirties the agent's own diff and shows up in
    // its pull request.
    const dir = wt();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), '{"model":"tracked"}');
    installClaudeHook(dir, "/wt/h.sh");
    assert.ok(existsSync(join(dir, CLAUDE_LOCAL_SETTINGS)));
    assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"), '{"model":"tracked"}');
  });

  it("starts clean on a corrupt overlay instead of never delivering again", () => {
    const dir = wt();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, CLAUDE_LOCAL_SETTINGS), "{not json");
    installClaudeHook(dir, "/wt/h.sh");
    const parsed = JSON.parse(readFileSync(join(dir, CLAUDE_LOCAL_SETTINGS), "utf-8"));
    assert.equal(parsed.hooks.Stop.length, 1);
  });
});

describe("Codex launch flags", () => {
  it("enables hooks and points Stop at the script", () => {
    const args = codexHookArgs("/wt/h.sh");
    assert.ok(args.includes("--enable hooks"));
    assert.ok(args.includes("hooks.Stop="));
    assert.ok(args.includes("/wt/h.sh"));
  });

  it("bypasses hook trust, because a headless agent has nobody to ask", () => {
    assert.ok(codexHookArgs("/wt/h.sh").includes("--dangerously-bypass-hook-trust"));
  });

  it("does not repeat the trust flag when a wrapper already passed it", () => {
    // Codex rejects a repeated --dangerously-bypass-hook-trust and refuses to
    // start. Under cmux the codex on PATH is a wrapper that already passes it,
    // so supplying our own killed every interactive Codex launch:
    //   error: the argument '--dangerously-bypass-hook-trust' cannot be used
    //   multiple times
    // Found by dispatching an agent to work on dispatch, not by any test.
    const args = codexHookArgs("/wt/h.sh", true);
    assert.ok(!args.includes("--dangerously-bypass-hook-trust"), args);
    assert.ok(args.includes("--enable hooks"), "hooks must still be enabled");
    assert.ok(args.includes("hooks.Stop="), "our hook must still be installed");
  });

  it("never emits the trust flag twice in one launch line", () => {
    for (const bypassed of [true, false]) {
      const n = codexHookArgs("/wt/h.sh", bypassed).split("--dangerously-bypass-hook-trust").length - 1;
      assert.ok(n <= 1, `emitted the flag ${n} times`);
    }
  });

  it("gives the hook a timeout in the milliseconds Codex expects", () => {
    // Codex takes milliseconds here and Claude takes seconds. A 15 that meant
    // 15ms would kill the hook on a cold start every time.
    assert.ok(codexHookArgs("/wt/h.sh").includes("timeout=15000"));
  });
});

describe("the interactive launch line carries the hook", () => {
  // Found by review, not by a test, and it would have shipped silently:
  // interactiveAgentCmd took no extra args, so an interactive Codex agent
  // never got its hook. Codex configures hooks by flag and persists nothing,
  // and codex is the default agent, so that is the common case broken.
  // Claude was unaffected because its hook is a settings file, which is
  // exactly why testing only Claude would have missed it.
  const cfg = (agent: string): Config =>
    ({ agent, model: "", codexModel: "", reasoningEffort: "", permissionMode: "" }) as Config;

  it("passes hook flags into a Codex pane launch", () => {
    const line = getAdapter("codex").paneCmd(cfg("codex"), false, "--enable hooks -c 'hooks.Stop=X'");
    assert.ok(line.includes("--enable hooks"), line);
    assert.ok(line.includes("hooks.Stop=X"), line);
  });

  it("passes them on resume too, since Codex persists nothing between runs", () => {
    const line = getAdapter("codex").paneCmd(cfg("codex"), true, "--enable hooks -c 'hooks.Stop=X'");
    assert.ok(line.includes("hooks.Stop=X"), line);
  });

  it("leaves the Claude pane launch unchanged when there is nothing to add", () => {
    const line = getAdapter("claude").paneCmd(cfg("claude"), false, "");
    assert.ok(!line.includes("hooks.Stop"), line);
    assert.ok(line.startsWith("claude"), line);
  });
});
