import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getAdapter, isAgentKind, AGENT_KINDS } from "../src/agents.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    baseBranch: "dev",
    agent: "claude",
    model: "",
    codexModel: "",
    reasoningEffort: "",
    maxTurns: "",
    maxBudget: "",
    allowedTools: "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch,WebFetch",
    permissionMode: "",
    worktreeDir: ".worktrees",
    claudeTimeout: 30,
    ...overrides,
  };
}

const wt = () => mkdtempSync(join(tmpdir(), "dispatch-agents-"));

describe("getAdapter", () => {
  it("resolves both runtimes", () => {
    assert.equal(getAdapter("claude").kind, "claude");
    assert.equal(getAdapter("codex").kind, "codex");
  });

  it("treats an unset runtime as claude", () => {
    // Configs written before codex support have no `agent` field.
    assert.equal(getAdapter(undefined).kind, "claude");
    assert.equal(getAdapter("").kind, "claude");
  });

  it("throws on an unknown runtime", () => {
    assert.throws(() => getAdapter("gemini"), /Unknown agent runtime: gemini/);
  });

  it("isAgentKind guards the CLI flag", () => {
    assert.ok(AGENT_KINDS.every(isAgentKind));
    assert.ok(!isAgentKind("gemini"));
  });
});

// ---------------------------------------------------------------------------
// Claude adapter: locks in the pre-refactor launch lines byte for byte.
// ---------------------------------------------------------------------------
describe("claude adapter launch lines", () => {
  const claude = getAdapter("claude");

  it("pane command matches the historical form", () => {
    const cmd = claude.paneCmd(
      makeConfig({ model: "opus[1m]", permissionMode: "dontAsk" }),
      false,
    );
    assert.equal(
      cmd,
      `claude --model 'opus[1m]' --permission-mode dontAsk --allowedTools "WebSearch,WebFetch"`,
    );
  });

  it("puts --continue first when resuming", () => {
    const cmd = claude.paneCmd(makeConfig({ permissionMode: "dontAsk" }), true);
    assert.equal(
      cmd,
      `claude --continue --permission-mode dontAsk --allowedTools "WebSearch,WebFetch"`,
    );
  });

  it("headless carries the stream-json flags and reads the prompt file", () => {
    const path = wt();
    const cmd = claude.runCmd("do stuff", "headless", path, makeConfig(), "", false);
    assert.ok(cmd.startsWith("claude -p"));
    assert.ok(cmd.includes("--output-format stream-json --verbose"));
    assert.ok(cmd.endsWith(`< '${join(path, ".dispatch-prompt.txt")}'`));
    assert.equal(
      readFileSync(join(path, ".dispatch-prompt.txt"), "utf-8"),
      "do stuff",
    );
  });

  it("headless resume uses --continue", () => {
    const cmd = claude.runCmd("go on", "headless", wt(), makeConfig(), "", true);
    assert.ok(cmd.startsWith("claude -p --continue"));
  });

  it("unsets CLAUDECODE so it can run inside a Claude session", () => {
    assert.equal(claude.shellPrefix, "unset CLAUDECODE && ");
  });
});

// ---------------------------------------------------------------------------
// Codex adapter
// ---------------------------------------------------------------------------
describe("codex adapter launch lines", () => {
  const codex = getAdapter("codex");

  it("pane command drives the TUI with -m and suppresses the update check", () => {
    const cmd = codex.paneCmd(
      makeConfig({ agent: "codex", codexModel: "gpt-5.6-sol", permissionMode: "dontAsk" }),
      false,
    );
    assert.equal(
      cmd,
      "codex -m 'gpt-5.6-sol' --dangerously-bypass-approvals-and-sandbox --search " +
        "-c check_for_update_on_startup=false",
    );
  });

  it("resumes the most recent session for this worktree", () => {
    const cmd = codex.paneCmd(makeConfig({ agent: "codex" }), true);
    assert.ok(cmd.startsWith("codex resume --last"));
  });

  it("headless uses exec --json and reads the prompt from stdin", () => {
    const path = wt();
    const cmd = codex.runCmd(
      "do stuff",
      "headless",
      path,
      makeConfig({ agent: "codex" }),
      "",
      false,
    );
    assert.ok(cmd.startsWith("codex exec --json"));
    assert.ok(cmd.endsWith(`< '${join(path, ".dispatch-prompt.txt")}'`));
    assert.equal(
      readFileSync(join(path, ".dispatch-prompt.txt"), "utf-8"),
      "do stuff",
    );
  });

  // codex exec rejects --search and -c check_for_update_on_startup outright.
  it("omits TUI-only flags from exec", () => {
    const cmd = codex.runCmd("p", "headless", wt(), makeConfig({ agent: "codex" }), "", false);
    assert.ok(!cmd.includes("--search"));
    assert.ok(!cmd.includes("check_for_update_on_startup"));
  });

  it("headless resume uses exec resume --last", () => {
    const cmd = codex.runCmd(
      "go on",
      "headless",
      wt(),
      makeConfig({ agent: "codex" }),
      "",
      true,
    );
    assert.ok(cmd.startsWith("codex exec resume --last --json"));
  });

  // Codex will not run in an untrusted directory without an explicit sandbox
  // policy, and every dispatch worktree is a brand new path. A launch line
  // missing this stalls on a trust dialog before the prompt is ever sent.
  it("always carries an explicit sandbox flag", () => {
    const configs = [
      makeConfig({ agent: "codex", permissionMode: "dontAsk" }),
      makeConfig({ agent: "codex", permissionMode: "" }),
      makeConfig({ agent: "codex", codexModel: "gpt-5.6-sol" }),
    ];
    for (const config of configs) {
      for (const cmd of [
        codex.paneCmd(config, false),
        codex.paneCmd(config, true),
        codex.runCmd("p", "headless", wt(), config, "", false),
      ]) {
        assert.ok(
          /--dangerously-bypass-approvals-and-sandbox|\s-s\s/.test(cmd),
          `missing sandbox flag: ${cmd}`,
        );
      }
    }
  });

  it("--ask swaps the bypass for a sandbox plus approvals", () => {
    const cmd = codex.paneCmd(makeConfig({ agent: "codex", permissionMode: "" }), false);
    assert.ok(cmd.includes("-s workspace-write -a on-request"));
    assert.ok(!cmd.includes("--dangerously-bypass"));
  });

  it("quotes bracketed model names so zsh does not glob them", () => {
    const cmd = codex.paneCmd(makeConfig({ agent: "codex", codexModel: "gpt-5[x]" }), false);
    assert.ok(cmd.includes("-m 'gpt-5[x]'"));
  });

  it("omits claude-only flags", () => {
    const cmd = codex.runCmd(
      "p",
      "headless",
      wt(),
      makeConfig({ agent: "codex", maxTurns: "10", maxBudget: "5" }),
      "",
      false,
    );
    assert.ok(!cmd.includes("--allowedTools"));
    assert.ok(!cmd.includes("--max-turns"));
    assert.ok(!cmd.includes("--max-budget"));
    assert.ok(!cmd.includes("--permission-mode"));
  });

  it("needs no shell prefix", () => {
    assert.equal(codex.shellPrefix, "");
  });

  // Regression: dispatch used to hand codex the claude default model
  // (`opus[1m]`), which codex does not know, so it exited at startup.
  it("never inherits the claude model", () => {
    const config = makeConfig({ agent: "codex", model: "opus[1m]", codexModel: "" });
    for (const cmd of [
      codex.paneCmd(config, false),
      codex.runCmd("p", "headless", wt(), config, "", false),
    ]) {
      assert.ok(!cmd.includes("opus"), `leaked claude model: ${cmd}`);
      assert.ok(!/\s-m\s/.test(cmd), `should defer to codex's own default: ${cmd}`);
    }
  });

  it("omits -m entirely when no codex model is set", () => {
    // Lets codex fall back to whatever ~/.codex/config.toml specifies.
    assert.ok(!codex.paneCmd(makeConfig({ agent: "codex" }), false).includes("-m"));
  });
});

describe("codex reasoning effort", () => {
  const codex = getAdapter("codex");

  it("passes effort as a config override on both modes", () => {
    const config = makeConfig({ agent: "codex", reasoningEffort: "xhigh" });
    assert.ok(
      codex.paneCmd(config, false).includes("-c 'model_reasoning_effort=xhigh'"),
    );
    assert.ok(
      codex
        .runCmd("p", "headless", wt(), config, "", false)
        .includes("-c 'model_reasoning_effort=xhigh'"),
    );
  });

  // The value is typed into a pane shell, so it must not be able to escape it.
  it("quotes the effort so it cannot break out of the command", () => {
    const cmd = codex.paneCmd(
      makeConfig({ agent: "codex", reasoningEffort: "high; touch /tmp/PWNED" }),
      false,
    );
    // The payload must sit inside one quoted argument, so the shell sees a
    // single -c value rather than a second command after the semicolon.
    assert.ok(cmd.includes(`-c 'model_reasoning_effort=high; touch /tmp/PWNED'`));
    const afterQuoted = cmd.split(`/tmp/PWNED'`)[1] || "";
    assert.ok(!afterQuoted.includes("touch"), `escaped the quotes: ${cmd}`);
  });

  it("omits it when unset so codex uses its own default", () => {
    assert.ok(
      !codex.paneCmd(makeConfig({ agent: "codex" }), false).includes("model_reasoning_effort"),
    );
  });

  it("claude ignores it — there is no CLI equivalent", () => {
    const cmd = getAdapter("claude").paneCmd(
      makeConfig({ reasoningEffort: "xhigh" }),
      false,
    );
    assert.ok(!cmd.includes("reasoning"));
    assert.ok(!cmd.includes("xhigh"));
  });
});

// ---------------------------------------------------------------------------
// TUI detection. Fixtures are real pane captures from codex-cli 0.144.3.
// ---------------------------------------------------------------------------
const CODEX_READY = `
╭─────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.144.3)                              │
│                                                         │
│ model:     gpt-5.6-sol high   /model to change          │
│ directory: /private/tmp/scratchpad/cxprobe              │
╰─────────────────────────────────────────────────────────╯
  Tip: Join the OpenAI community Discord
› Use /skills to list available skills
`;

const CODEX_WORKING = `${CODEX_READY}
◦ Working (11s • esc to interrupt)
`;

const CODEX_UPDATE_PROMPT = `
  ✨ Update available! 0.144.3 -> 0.145.0
  Release notes: https://github.com/openai/codex/releases/latest
› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version
  Press enter to continue
`;

describe("codex TUI detection", () => {
  const codex = getAdapter("codex");

  it("recognizes the rendered TUI", () => {
    assert.ok(codex.isReady(CODEX_READY));
  });

  it("does not mistake the echoed launch command for a ready TUI", () => {
    const echoed =
      "➜  cxprobe codex -m 'gpt-5.6-sol' --dangerously-bypass-approvals-and-sandbox";
    assert.ok(!codex.isReady(echoed));
  });

  it("detects a working turn", () => {
    assert.ok(codex.isBusy(CODEX_WORKING));
    assert.ok(!codex.isBusy(CODEX_READY));
  });

  // The update menu swallows the keystrokes meant for the composer, so the
  // prompt would land in the wrong widget if we treated the pane as ready.
  it("dismisses the update menu instead of pasting into it", () => {
    assert.equal(codex.dismissStartupDialog(CODEX_UPDATE_PROMPT), "2");
    assert.equal(codex.dismissStartupDialog(CODEX_READY), null);
  });
});

// ---------------------------------------------------------------------------
// Log parsing. Fixtures captured verbatim from `codex exec --json`.
// ---------------------------------------------------------------------------
const CODEX_LOG = [
  `{"type":"thread.started","thread_id":"019fc939-47f8-7ee2-b823-67d895bd85c2"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll run the command, then create probe.txt."}}`,
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo probe'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo probe'","aggregated_output":"probe\\n","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/wt/probe.txt","kind":"add"}],"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"git commit -m \\"add probe\\"","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Created probe.txt containing probe."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":42002,"output_tokens":217}}`,
].join("\n");

const CLAUDE_LOG = [
  `{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it."}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/wt/probe.txt"}}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git commit -m \\"add probe\\""}}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"Created probe.txt containing probe."}]}}`,
].join("\n");

describe("codex log parsing", () => {
  const parsed = getAdapter("codex").parseLog(CODEX_LOG);

  it("counts agent messages as turns", () => {
    // codex emits one turn.completed per prompt, so agent messages are the
    // closer analogue to a Claude assistant turn.
    assert.equal(parsed.turns, 2);
  });

  it("collects changed files", () => {
    assert.deepEqual(parsed.filesModified, ["/wt/probe.txt"]);
  });

  it("extracts commit messages from shell commands", () => {
    assert.deepEqual(parsed.commits, ["add probe"]);
  });

  it("keeps the last agent message", () => {
    assert.equal(parsed.lastText, "Created probe.txt containing probe.");
  });

  it("records tool usage under runtime-neutral names", () => {
    assert.equal(parsed.toolsUsed.get("Bash"), 2);
    assert.equal(parsed.toolsUsed.get("Write"), 1);
  });

  it("ignores item.started so in-progress work is not double counted", () => {
    const started = parsed.lastActions.filter((a) => a === "Ran: /bin/zsh -lc 'echo probe'");
    assert.equal(started.length, 1);
  });

  it("skips malformed and truncated lines", () => {
    // The log is tailed live, so a half-written final line is routine.
    const messy = `not json\n\n${CODEX_LOG}\n{"type":"item.compl`;
    assert.equal(getAdapter("codex").parseLog(messy).turns, 2);
  });
});

describe("both runtimes produce the same summary shape", () => {
  it("agrees on files, commits and last text for equivalent work", () => {
    const fromCodex = getAdapter("codex").parseLog(CODEX_LOG);
    const fromClaude = getAdapter("claude").parseLog(CLAUDE_LOG);

    assert.deepEqual(fromCodex.filesModified, fromClaude.filesModified);
    assert.deepEqual(fromCodex.commits, fromClaude.commits);
    assert.equal(fromCodex.lastText, fromClaude.lastText);
    assert.deepEqual(Object.keys(fromCodex), Object.keys(fromClaude));
  });
});

// ---------------------------------------------------------------------------
// Session transcripts. Interactive agents write no .dispatch.log, so these are
// the only trace an orchestrator can read. Fixtures are real rollout/session
// lines from codex-cli 0.144.3 and Claude Code.
// ---------------------------------------------------------------------------
const CODEX_ROLLOUT = [
  `{"type":"session_meta","payload":{"session_id":"019f","cwd":"/wt/agent-a","originator":"codex-tui"}}`,
  `{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}`,
  `{"type":"event_msg","payload":{"type":"user_message","message":"do the thing"}}`,
  `{"type":"event_msg","payload":{"type":"agent_message","message":"Starting on it."}}`,
  `{"type":"event_msg","payload":{"type":"exec_command_end","command":["git","commit","-m","add probe"],"cwd":"/wt/agent-a"}}`,
  `{"type":"event_msg","payload":{"type":"patch_apply_end","success":true,"changes":{"/wt/agent-a/hello.txt":{"type":"add"}}}}`,
  `{"type":"event_msg","payload":{"type":"agent_message","message":"Committed."}}`,
  `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"Current branch: codex-smoke"}}`,
].join("\n");

describe("codex session transcript parsing", () => {
  const parsed = getAdapter("codex").parseSession(CODEX_ROLLOUT);

  it("counts agent messages as turns", () => {
    assert.equal(parsed.turns, 2);
  });

  it("prefers task_complete's final message as the last output", () => {
    assert.equal(parsed.lastText, "Current branch: codex-smoke");
  });

  it("extracts commits from exec_command_end argv arrays", () => {
    assert.deepEqual(parsed.commits, ["add probe"]);
  });

  it("extracts changed files from patch_apply_end", () => {
    assert.deepEqual(parsed.filesModified, ["/wt/agent-a/hello.txt"]);
  });

  it("is a different shape from the exec --json stream", () => {
    // Guards against someone pointing parseLog at a rollout file.
    assert.equal(getAdapter("codex").parseLog(CODEX_ROLLOUT).turns, 0);
  });
});

describe("claude session transcript parsing", () => {
  it("reuses the headless parser, since the shape matches", () => {
    const session = [
      `{"type":"assistant","cwd":"/wt/agent-b","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}`,
      `{"type":"assistant","cwd":"/wt/agent-b","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/wt/agent-b/x.ts"}}]}}`,
      `{"type":"assistant","cwd":"/wt/agent-b","message":{"content":[{"type":"text","text":"Done."}]}}`,
    ].join("\n");
    const parsed = getAdapter("claude").parseSession(session);
    assert.equal(parsed.turns, 3);
    assert.equal(parsed.lastText, "Done.");
    assert.deepEqual(parsed.filesModified, ["/wt/agent-b/x.ts"]);
  });
});

describe("session file discovery", () => {
  it("returns null rather than guessing when nothing matches the worktree", () => {
    for (const kind of AGENT_KINDS) {
      assert.equal(getAdapter(kind).findSessionFile("/nonexistent/worktree-xyz"), null);
    }
  });
});

describe("codex rollout parsing matches what codex actually emits", () => {
  const codex = getAdapter("codex");

  // Regression: the parser originally handled exec_command_begin and
  // patch_apply_begin, which codex never emits. Across 33 real rollout files
  // there were 279 exec_command_end and 32 patch_apply_end, and zero of the
  // _begin variants, so every interactive codex trace reported no files and
  // no commits.
  it("ignores the _begin names that codex does not emit", () => {
    const begins = [
      `{"type":"event_msg","payload":{"type":"exec_command_begin","command":["git","commit","-m","x"]}}`,
      `{"type":"event_msg","payload":{"type":"patch_apply_begin","changes":{"/a.txt":{"type":"add"}}}}`,
    ].join("\n");
    const parsed = codex.parseSession(begins);
    assert.deepEqual(parsed.commits, []);
    assert.deepEqual(parsed.filesModified, []);
  });

  it("skips a failed patch rather than claiming the file changed", () => {
    const failed = `{"type":"event_msg","payload":{"type":"patch_apply_end","success":false,"changes":{"/a.txt":{"type":"add"}}}}`;
    assert.deepEqual(codex.parseSession(failed).filesModified, []);
  });

  it("only reads -m that belongs to the git command", () => {
    // `grep -m 5 ... git commit` must not be recorded as a commit message.
    const decoys = [
      `{"type":"event_msg","payload":{"type":"exec_command_end","command":["grep","-m","5","git","commit","x"]}}`,
      `{"type":"event_msg","payload":{"type":"exec_command_end","command":["ssh","-m","hmac-sha2-256","h","git","push"]}}`,
    ].join("\n");
    assert.deepEqual(codex.parseSession(decoys).commits, []);
  });

  it("does not crash when -m is the final argument", () => {
    const truncated = `{"type":"event_msg","payload":{"type":"exec_command_end","command":["git","commit","--amend","-m"]}}`;
    assert.deepEqual(codex.parseSession(truncated).commits, []);
  });

  it("recovers a command from code-mode exec input", () => {
    // Real shape: tools.exec_command({"cmd":"...","workdir":"..."})
    const codeMode = `{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const r = await tools.exec_command({\\"cmd\\":\\"git commit -m 'add hello'\\",\\"workdir\\":\\"/wt\\"})"}}`;
    assert.deepEqual(codex.parseSession(codeMode).commits, ["add hello"]);
  });
});
