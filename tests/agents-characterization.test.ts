import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter, type AgentLogSummary } from "../src/agents.js";
import type { Config } from "../src/config.js";

const tempDirs: string[] = [];

function tempWorktree(): string {
  const path = mkdtempSync(join(tmpdir(), "dispatch-adapter-characterization-"));
  tempDirs.push(path);
  return path;
}

after(() => {
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
});

function config(overrides: Partial<Config> = {}): Config {
  return {
    baseBranch: "main",
    agent: "claude",
    model: "opus[1m]",
    codexModel: "gpt-5[x]",
    reasoningEffort: "xhigh",
    maxTurns: "7",
    maxBudget: "12.50",
    allowedTools: "Bash,Read,Edit,WebSearch",
    permissionMode: "dontAsk",
    threadDelivery: "ask",
    worktreeDir: ".worktrees",
    claudeTimeout: 30,
    ...overrides,
  };
}

const CODEX_HOOK_SCRIPT = "/tmp/dispatch-characterization-hook.sh";
const CODEX_HOOK_ARGS =
  `--enable hooks --dangerously-bypass-hook-trust ` +
  `-c 'hooks.Stop=[{hooks=[{type="command",command="${CODEX_HOOK_SCRIPT}",timeout=15000}]}]'`;

describe("Claude launch surface as shipped in v0.15.2", () => {
  const claude = getAdapter("claude");

  it("renders the exact headless runCmd without resume", () => {
    const wtPath = tempWorktree();
    const promptPath = join(wtPath, ".dispatch-prompt.txt");

    assert.equal(
      claude.runCmd("characterize Claude", "headless", wtPath, config(), "", false),
      `claude -p --model 'opus[1m]' --permission-mode dontAsk ` +
        `--allowedTools "Bash,Read,Edit,WebSearch" --max-turns 7 ` +
        `--max-budget-usd 12.50 --output-format stream-json --verbose < '${promptPath}'`,
    );
    assert.equal(readFileSync(promptPath, "utf8"), "characterize Claude");
  });

  it("renders the exact headless runCmd with resume", () => {
    const wtPath = tempWorktree();
    const promptPath = join(wtPath, ".dispatch-prompt.txt");

    assert.equal(
      claude.runCmd("resume Claude", "headless", wtPath, config(), "", true),
      `claude -p --continue --model 'opus[1m]' --permission-mode dontAsk ` +
        `--allowedTools "Bash,Read,Edit,WebSearch" --max-turns 7 ` +
        `--max-budget-usd 12.50 --output-format stream-json --verbose < '${promptPath}'`,
    );
    assert.equal(readFileSync(promptPath, "utf8"), "resume Claude");
  });

  it("renders the exact interactive runCmd without resume", () => {
    assert.equal(
      claude.runCmd("unused prompt", "interactive", tempWorktree(), config(), "", false),
      "claude --model 'opus[1m]' --permission-mode dontAsk",
    );
  });

  it("renders the exact interactive runCmd with resume", () => {
    assert.equal(
      claude.runCmd("unused prompt", "interactive", tempWorktree(), config(), "", true),
      "claude --continue --model 'opus[1m]' --permission-mode dontAsk",
    );
  });

  it("renders paneCmd exactly and appends supplied launch args", () => {
    // Claude's real hook is file-backed and supplies no args. The adapter still
    // appends any supplied args; this is current interface behavior, not a
    // claim that --characterization-hook is a valid Claude CLI option.
    assert.equal(
      claude.paneCmd(config(), false, "--characterization-hook stop"),
      `claude --model 'opus[1m]' --permission-mode dontAsk ` +
        `--allowedTools "WebSearch,WebFetch" --characterization-hook stop`,
    );
  });

  it("renders resumed paneCmd exactly and appends supplied launch args", () => {
    assert.equal(
      claude.paneCmd(config(), true, "--characterization-hook stop"),
      `claude --continue --model 'opus[1m]' --permission-mode dontAsk ` +
        `--allowedTools "WebSearch,WebFetch" --characterization-hook stop`,
    );
  });
});

describe("Codex launch surface as shipped in v0.15.2", () => {
  const codex = getAdapter("codex");
  const codexConfig = config({ agent: "codex" });

  it("renders the exact headless runCmd without resume", () => {
    const wtPath = tempWorktree();
    const promptPath = join(wtPath, ".dispatch-prompt.txt");

    assert.equal(
      codex.runCmd(
        "characterize Codex",
        "headless",
        wtPath,
        codexConfig,
        CODEX_HOOK_ARGS,
        false,
      ),
      `codex exec --json -m 'gpt-5[x]' -c 'model_reasoning_effort=xhigh' ` +
        `--dangerously-bypass-approvals-and-sandbox ${CODEX_HOOK_ARGS} < '${promptPath}'`,
    );
    assert.equal(readFileSync(promptPath, "utf8"), "characterize Codex");
  });

  it("renders the exact headless runCmd with resume", () => {
    const wtPath = tempWorktree();
    const promptPath = join(wtPath, ".dispatch-prompt.txt");

    assert.equal(
      codex.runCmd(
        "resume Codex",
        "headless",
        wtPath,
        codexConfig,
        CODEX_HOOK_ARGS,
        true,
      ),
      `codex exec resume --last --json -m 'gpt-5[x]' ` +
        `-c 'model_reasoning_effort=xhigh' --dangerously-bypass-approvals-and-sandbox ` +
        `${CODEX_HOOK_ARGS} < '${promptPath}'`,
    );
    assert.equal(readFileSync(promptPath, "utf8"), "resume Codex");
  });

  it("renders the exact interactive runCmd without resume", () => {
    assert.equal(
      codex.runCmd(
        "unused prompt",
        "interactive",
        tempWorktree(),
        codexConfig,
        CODEX_HOOK_ARGS,
        false,
      ),
      `codex -m 'gpt-5[x]' -c 'model_reasoning_effort=xhigh' ` +
        `--dangerously-bypass-approvals-and-sandbox --search ` +
        `-c check_for_update_on_startup=false ${CODEX_HOOK_ARGS}`,
    );
  });

  it("renders the exact interactive runCmd with resume", () => {
    assert.equal(
      codex.runCmd(
        "unused prompt",
        "interactive",
        tempWorktree(),
        codexConfig,
        CODEX_HOOK_ARGS,
        true,
      ),
      `codex resume --last -m 'gpt-5[x]' -c 'model_reasoning_effort=xhigh' ` +
        `--dangerously-bypass-approvals-and-sandbox --search ` +
        `-c check_for_update_on_startup=false ${CODEX_HOOK_ARGS}`,
    );
  });

  it("renders paneCmd exactly with the turn-end hook last", () => {
    assert.equal(
      codex.paneCmd(codexConfig, false, CODEX_HOOK_ARGS),
      `codex -m 'gpt-5[x]' -c 'model_reasoning_effort=xhigh' ` +
        `--dangerously-bypass-approvals-and-sandbox --search ` +
        `-c check_for_update_on_startup=false ${CODEX_HOOK_ARGS}`,
    );
  });

  it("renders resumed paneCmd exactly with the turn-end hook last", () => {
    assert.equal(
      codex.paneCmd(codexConfig, true, CODEX_HOOK_ARGS),
      `codex resume --last -m 'gpt-5[x]' -c 'model_reasoning_effort=xhigh' ` +
        `--dangerously-bypass-approvals-and-sandbox --search ` +
        `-c check_for_update_on_startup=false ${CODEX_HOOK_ARGS}`,
    );
  });
});

describe("turn-end hook installation as shipped in v0.15.2", () => {
  it("writes Claude's exact local settings and leaves settings.json untouched", () => {
    const wtPath = tempWorktree();
    const claudeDir = join(wtPath, ".claude");
    const trackedSettings = join(claudeDir, "settings.json");
    const localSettings = join(claudeDir, "settings.local.json");
    const hookScript = join(wtPath, ".dispatch-inbox-hook.sh");
    const original = "{\n  \"permissions\": { \"allow\": [\"Read\"] }\n}\n";
    mkdirSync(claudeDir);
    writeFileSync(trackedSettings, original);

    assert.equal(getAdapter("claude").installTurnEndHook(wtPath, hookScript), "");
    assert.equal(readFileSync(trackedSettings, "utf8"), original);
    assert.equal(
      readFileSync(localSettings, "utf8"),
      `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${hookScript}",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
`,
    );
  });

  it("returns Codex's exact hook flags and writes nothing", () => {
    const wtPath = tempWorktree();
    assert.equal(
      getAdapter("codex").installTurnEndHook(wtPath, CODEX_HOOK_SCRIPT),
      CODEX_HOOK_ARGS,
    );
    assert.deepEqual(readdirSync(wtPath), []);
  });

  it("omits Codex's duplicate-sensitive trust flag when already bypassed", () => {
    assert.equal(
      getAdapter("codex").installTurnEndHook("/unused", CODEX_HOOK_SCRIPT, {
        hookTrustAlreadyBypassed: true,
      }),
      `--enable hooks ` +
        `-c 'hooks.Stop=[{hooks=[{type="command",command="${CODEX_HOOK_SCRIPT}",timeout=15000}]}]'`,
    );
  });
});

describe("adapter identity fields as shipped in v0.15.2", () => {
  it("pins bin, modelKey, and shellPrefix for both runtimes", () => {
    const claude = getAdapter("claude");
    const codex = getAdapter("codex");

    assert.deepEqual(
      {
        claude: {
          bin: claude.bin,
          modelKey: claude.modelKey,
          shellPrefix: claude.shellPrefix,
        },
        codex: {
          bin: codex.bin,
          modelKey: codex.modelKey,
          shellPrefix: codex.shellPrefix,
        },
      },
      {
        claude: {
          bin: "claude",
          modelKey: "model",
          shellPrefix: "unset CLAUDECODE && ",
        },
        codex: { bin: "codex", modelKey: "codexModel", shellPrefix: "" },
      },
    );
  });
});

function transcript(name: string): string {
  return readFileSync(new URL(`./fixtures/transcripts/${name}`, import.meta.url), "utf8");
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function plainSummary(summary: AgentLogSummary) {
  return {
    ...summary,
    toolsUsed: [...summary.toolsUsed],
    lastText: {
      length: summary.lastText.length,
      sha256: digest(summary.lastText),
    },
  };
}

describe("parsers against the captured transcripts", () => {
  const claude = getAdapter("claude");
  const codex = getAdapter("codex");

  it("pins Claude parseLog output for the working transcript", () => {
    assert.deepEqual(plainSummary(claude.parseLog(transcript("claude-working.jsonl"))), {
      turns: 2,
      filesModified: [],
      toolsUsed: [["Bash", 2]],
      commits: [
        "Upgrade LLM and TTS to verified LiveKit Inference ids; correct the latency plan",
      ],
      lastActions: [
        "Ran: git add src/agent.py tests/test_voice_pipeline.py ",
        "Pushed to remote",
        "Ran: git push -u origin voice-transcript-models 2>&1 | ",
      ],
      lastText: {
        length: 37,
        sha256: "ea22f950897d81176743a2a8777fcf61bb9c22d842edd1a54dafbf8936345edd",
      },
    });
  });

  it("pins Claude parseSession output for the waiting transcript", () => {
    assert.deepEqual(plainSummary(claude.parseSession(transcript("claude-waiting.jsonl"))), {
      turns: 2,
      filesModified: [],
      toolsUsed: [["Bash", 1]],
      commits: [],
      lastActions: [
        "Pushed to remote",
        "Ran: git push -u origin voice-transcript-models 2>&1 | ",
      ],
      lastText: {
        length: 3496,
        sha256: "67911d5414d875a07290054562697b215ec6fee68fd867f52165052c12229b2a",
      },
    });
  });

  it("pins Codex parseLog's empty result for an interactive rollout", () => {
    // This is defined by the split parser contract, not a claim that parsing
    // nothing is useful: codex-working.jsonl is an interactive rollout and
    // parseLog only understands the different `codex exec --json` format.
    assert.deepEqual(plainSummary(codex.parseLog(transcript("codex-working.jsonl"))), {
      turns: 0,
      filesModified: [],
      toolsUsed: [],
      commits: [],
      lastActions: [],
      lastText: {
        length: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    });
  });

  it("pins Codex parseSession output for the interactive rollout", () => {
    assert.deepEqual(plainSummary(codex.parseSession(transcript("codex-working.jsonl"))), {
      turns: 0,
      filesModified: [],
      toolsUsed: [["Bash", 2]],
      commits: [],
      lastActions: [
        "Ran: rg -n 'LISTENER_EXTRACTOR|LISTENING_ROLLOUT' docs/",
        "Ran: sed -n '1,125p' docs/feature-flags.mdnsed -n '330,",
      ],
      lastText: {
        length: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    });
  });
});

function screen(name: string): string {
  return readFileSync(new URL(`./fixtures/screens/${name}`, import.meta.url), "utf8");
}

describe("screen reading against every captured screen", () => {
  const expectations = {
    claude: {
      "claude-fresh-ready.txt": [true, false, null],
      "claude-idle-after-hours.txt": [true, false, null],
      "claude-trust-dialog.txt": [false, false, "key:down enter"],
      "codex-mid-turn.txt": [true, true, null],
      "shell-bare.txt": [false, false, null],
      "shell-p10k.txt": [false, false, null],
    },
    codex: {
      "claude-fresh-ready.txt": [false, false, null],
      "claude-idle-after-hours.txt": [false, false, null],
      "claude-trust-dialog.txt": [false, false, null],
      "codex-mid-turn.txt": [false, true, null],
      "shell-bare.txt": [false, false, null],
      "shell-p10k.txt": [false, false, null],
    },
  } as const;

  for (const kind of ["claude", "codex"] as const) {
    for (const [name, expected] of Object.entries(expectations[kind])) {
      it(`pins ${kind} detection for ${name}`, () => {
        const adapter = getAdapter(kind);
        const content = screen(name);
        assert.deepEqual(
          [
            adapter.isReady(content),
            adapter.isBusy(content),
            adapter.dismissStartupDialog(content),
          ],
          expected,
        );
      });
    }
  }

  // Latent fixture bug: despite its name, codex-mid-turn.txt begins with
  // "Claude Code v2.1.252" and contains no OpenAI Codex marker. Current Codex
  // behavior on it is therefore not-ready but busy (both runtimes recognize
  // "esc to interrupt"). There is no captured Codex screen in this fixture
  // directory that can positively bind Codex isReady; keep this visible until
  // a genuine Codex capture is added.
});
