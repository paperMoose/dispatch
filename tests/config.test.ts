import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSimpleYaml, loadConfig, modelFlag, permissionModeFlag } from "../src/config.js";

describe("parseSimpleYaml", () => {
  it("parses basic key:value pairs", () => {
    const result = parseSimpleYaml("model: sonnet\nbase_branch: main");
    assert.deepEqual(result, { model: "sonnet", base_branch: "main" });
  });

  it("ignores comments and blank lines", () => {
    const result = parseSimpleYaml("# comment\n\nmodel: sonnet\n  # indented comment");
    assert.deepEqual(result, { model: "sonnet" });
  });

  it("strips double quotes", () => {
    const result = parseSimpleYaml('model: "sonnet"');
    assert.deepEqual(result, { model: "sonnet" });
  });

  it("strips single quotes", () => {
    const result = parseSimpleYaml("model: 'sonnet'");
    assert.deepEqual(result, { model: "sonnet" });
  });

  it("handles values with colons", () => {
    const result = parseSimpleYaml("url: https://example.com:8080/path");
    assert.deepEqual(result, { url: "https://example.com:8080/path" });
  });

  it("trims whitespace around keys and values", () => {
    const result = parseSimpleYaml("  model  :  sonnet  ");
    assert.deepEqual(result, { model: "sonnet" });
  });

  it("returns empty object for empty input", () => {
    assert.deepEqual(parseSimpleYaml(""), {});
  });

  it("skips lines without colons", () => {
    const result = parseSimpleYaml("no-colon-here\nmodel: sonnet");
    assert.deepEqual(result, { model: "sonnet" });
  });
});

describe("modelFlag", () => {
  it("quotes the model so glob characters survive the shell", () => {
    assert.equal(modelFlag("opus[1m]"), "--model 'opus[1m]'");
  });

  it("returns empty string when no model is set", () => {
    assert.equal(modelFlag(""), "");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(modelFlag("o'us"), `--model 'o'\\''us'`);
  });
});

describe("permissionModeFlag", () => {
  it("renders the flag when a mode is set", () => {
    assert.equal(permissionModeFlag("dontAsk"), "--permission-mode dontAsk");
  });

  it("returns empty string when prompts are wanted", () => {
    assert.equal(permissionModeFlag(""), "");
  });
});

describe("agent runtime config", () => {
  const withCleanEnv = (fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ["DISPATCH_CONFIG", "DISPATCH_AGENT"]) {
      saved[k] = process.env[k];
    }
    process.env.DISPATCH_CONFIG = "/nonexistent/.dispatch.yml";
    delete process.env.DISPATCH_AGENT;
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  };

  it("defaults to claude", () => {
    withCleanEnv(() => assert.equal(loadConfig().agent, "claude"));
  });

  it("reads DISPATCH_AGENT from the environment", () => {
    withCleanEnv(() => {
      process.env.DISPATCH_AGENT = "codex";
      assert.equal(loadConfig().agent, "codex");
    });
  });

  it("lets a CLI override beat the environment", () => {
    withCleanEnv(() => {
      process.env.DISPATCH_AGENT = "codex";
      assert.equal(loadConfig({ agent: "claude" }).agent, "claude");
    });
  });

  it("reads agent and the agent_timeout alias from a config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cfg-"));
    const file = join(dir, ".dispatch.yml");
    writeFileSync(file, "agent: codex\nagent_timeout: 45\n");
    const saved = process.env.DISPATCH_CONFIG;
    process.env.DISPATCH_CONFIG = file;
    try {
      const config = loadConfig();
      assert.equal(config.agent, "codex");
      // agent_timeout is the runtime-neutral spelling of claude_timeout.
      assert.equal(config.claudeTimeout, 45);
    } finally {
      if (saved !== undefined) process.env.DISPATCH_CONFIG = saved;
      else delete process.env.DISPATCH_CONFIG;
    }
  });
});

describe("modelFlag runtime differences", () => {
  it("uses -m for codex and --model by default", () => {
    assert.equal(modelFlag("gpt-5.6-sol", "-m"), "-m 'gpt-5.6-sol'");
    assert.equal(modelFlag("opus[1m]"), "--model 'opus[1m]'");
  });
});

describe("loadConfig", () => {
  it("returns defaults when no file or env", () => {
    const orig = process.env.DISPATCH_CONFIG;
    process.env.DISPATCH_CONFIG = "/nonexistent/.dispatch.yml";

    // Clear env vars that would override
    const envKeys = [
      "DISPATCH_BASE_BRANCH",
      "DISPATCH_MODEL",
      "DISPATCH_MAX_TURNS",
      "DISPATCH_MAX_BUDGET",
      "DISPATCH_ALLOWED_TOOLS",
      "DISPATCH_PERMISSION_MODE",
      "DISPATCH_CLAUDE_TIMEOUT",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    try {
      const config = loadConfig();
      assert.equal(config.baseBranch, "dev");
      assert.equal(config.model, "opus[1m]");
      assert.equal(config.maxTurns, "");
      assert.equal(config.maxBudget, "");
      assert.equal(config.permissionMode, "dontAsk");
      assert.equal(config.worktreeDir, ".worktrees");
      assert.equal(config.claudeTimeout, 30);
    } finally {
      if (orig !== undefined) process.env.DISPATCH_CONFIG = orig;
      else delete process.env.DISPATCH_CONFIG;
      for (const k of envKeys) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
  });

  it("CLI overrides take precedence", () => {
    const orig = process.env.DISPATCH_CONFIG;
    process.env.DISPATCH_CONFIG = "/nonexistent/.dispatch.yml";

    try {
      const config = loadConfig({ model: "opus", baseBranch: "main" });
      assert.equal(config.model, "opus");
      assert.equal(config.baseBranch, "main");
    } finally {
      if (orig !== undefined) process.env.DISPATCH_CONFIG = orig;
      else delete process.env.DISPATCH_CONFIG;
    }
  });

  it("coerces claudeTimeout to number from CLI override", () => {
    const orig = process.env.DISPATCH_CONFIG;
    process.env.DISPATCH_CONFIG = "/nonexistent/.dispatch.yml";

    try {
      const config = loadConfig({ claudeTimeout: 60 });
      assert.equal(config.claudeTimeout, 60);
      assert.equal(typeof config.claudeTimeout, "number");
    } finally {
      if (orig !== undefined) process.env.DISPATCH_CONFIG = orig;
      else delete process.env.DISPATCH_CONFIG;
    }
  });

  it("lets a repository config override the global config key by key", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-repo-cfg-"));
    const global = join(dir, "global.yml");
    const repo = join(dir, "repo");
    const repoConfig = join(repo, ".dispatch.yml");
    mkdirSync(repo);
    writeFileSync(global, "base_branch: dev\nmodel: global-model\n");
    writeFileSync(repoConfig, "base_branch: main\n");

    const saved = process.env.DISPATCH_CONFIG;
    process.env.DISPATCH_CONFIG = global;
    try {
      const config = loadConfig(undefined, { repoRoot: repo });
      assert.equal(config.baseBranch, "main", "repository value should win");
      assert.equal(config.model, "global-model", "missing repository key should fall through");
    } finally {
      if (saved !== undefined) process.env.DISPATCH_CONFIG = saved;
      else delete process.env.DISPATCH_CONFIG;
    }
  });

  it("warns and ignores a malformed repository config", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-bad-repo-cfg-"));
    const global = join(dir, "global.yml");
    const repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(global, "base_branch: main\n");
    writeFileSync(join(repo, ".dispatch.yml"), "base_branch: [unterminated\n");
    const warnings: string[] = [];

    const saved = process.env.DISPATCH_CONFIG;
    process.env.DISPATCH_CONFIG = global;
    try {
      const config = loadConfig(undefined, {
        repoRoot: repo,
        warn: (message) => warnings.push(message),
      });
      assert.equal(config.baseBranch, "main");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /malformed repository config/i);
      assert.match(warnings[0], /\.dispatch\.yml/);
    } finally {
      if (saved !== undefined) process.env.DISPATCH_CONFIG = saved;
      else delete process.env.DISPATCH_CONFIG;
    }
  });
});

describe("config validation", () => {
  const withConfig = (body: string, fn: () => void) => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-val-"));
    const file = join(dir, ".dispatch.yml");
    writeFileSync(file, body);
    const saved = process.env.DISPATCH_CONFIG;
    process.env.DISPATCH_CONFIG = file;
    try {
      fn();
    } finally {
      if (saved !== undefined) process.env.DISPATCH_CONFIG = saved;
      else delete process.env.DISPATCH_CONFIG;
    }
  };

  // An unknown runtime used to surface from getAdapter partway through launch,
  // after the worktree, branch and terminal window already existed.
  it("rejects an unknown runtime at load, before anything is created", () => {
    withConfig("agent: gemini\n", () => {
      assert.throws(() => loadConfig(), /Unknown agent runtime 'gemini'/);
    });
  });

  // A bad effort is only rejected once the prompt reaches the provider, which
  // presents as an agent that never started.
  it("rejects an unknown reasoning effort", () => {
    withConfig("agent: codex\nreasoning_effort: hgih\n", () => {
      assert.throws(() => loadConfig(), /Unknown reasoning effort 'hgih'/);
    });
  });

  it("accepts every advertised effort level", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      withConfig(`reasoning_effort: ${level}\n`, () => {
        assert.equal(loadConfig().reasoningEffort, level, level);
      });
    }
  });

  it("accepts a config with neither key set", () => {
    withConfig("base_branch: dev\n", () => {
      assert.equal(loadConfig().agent, "claude");
      assert.equal(loadConfig().reasoningEffort, "");
    });
  });
});
