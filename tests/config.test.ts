import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSimpleYaml, loadConfig } from "../src/config.js";

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
      assert.equal(config.model, "");
      assert.equal(config.maxTurns, "");
      assert.equal(config.maxBudget, "");
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
});
