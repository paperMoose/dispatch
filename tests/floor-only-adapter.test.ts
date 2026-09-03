import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAdapter,
  registerAdapter,
  type AgentAdapter,
  type RunMode,
} from "../src/agents.js";
import { buildAgentCmd } from "../src/commands.js";
import type { Config } from "../src/config.js";

class FloorOnlyAdapter implements AgentAdapter {
  readonly kind = "floor-only";
  readonly bin = "floor-agent";
  readonly modelKey = "model";
  readonly shellPrefix = "FLOOR_ONLY=1 ";

  runCmd(
    prompt: string,
    mode: RunMode,
    wtPath: string,
    _config: Config,
    extraArgs: string,
    resume: boolean,
  ): string {
    return [
      this.bin,
      mode,
      resume ? "--resume" : "",
      extraArgs,
      `--worktree=${wtPath}`,
      `--prompt=${prompt}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  paneCmd(_config: Config, resume: boolean, extraArgs = ""): string {
    return [this.bin, resume ? "--resume" : "", extraArgs]
      .filter(Boolean)
      .join(" ");
  }

  installTurnEndHook(_wtPath: string, hookScript: string): string {
    return `--turn-end-hook=${hookScript}`;
  }
}

function config(): Config {
  return {
    baseBranch: "main",
    agent: "floor-only",
    model: "",
    codexModel: "",
    reasoningEffort: "",
    maxTurns: "",
    maxBudget: "",
    allowedTools: "",
    permissionMode: "",
    threadDelivery: "ask",
    worktreeDir: ".worktrees",
    claudeTimeout: 30,
  };
}

describe("floor-only agent adapter", () => {
  it("registers and builds a launch line without screen-reading methods", () => {
    const floorOnly = new FloorOnlyAdapter();
    registerAdapter(floorOnly);

    assert.equal(getAdapter("floor-only"), floorOnly);
    assert.equal(
      buildAgentCmd(
        "do the work",
        "headless",
        "/tmp/floor-only-worktree",
        config(),
        "--from-dispatch",
      ),
      "floor-agent headless --from-dispatch --worktree=/tmp/floor-only-worktree --prompt=do the work",
    );

    for (const method of [
      "isReady",
      "isBusy",
      "dismissStartupDialog",
      "findSessionFile",
      "parseSession",
      "parseLog",
    ]) {
      assert.equal(method in floorOnly, false, `${method} must remain optional`);
    }
  });
});
