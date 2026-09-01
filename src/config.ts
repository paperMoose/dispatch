import { readFileSync } from "fs";
import { AGENT_KINDS, REASONING_EFFORTS } from "./agents.js";
import { join } from "path";
import { homedir } from "os";

export interface Config {
  baseBranch: string;
  /** Which agent CLI to drive: "claude" or "codex". See src/agents.ts. */
  agent: string;
  /** Model for the claude runtime. */
  model: string;
  /** Model for the codex runtime. Empty means "use codex's own default",
   *  since model names are not portable between runtimes. */
  codexModel: string;
  /** Codex reasoning effort: low | medium | high | xhigh | max | ultra.
   *  Empty means "use codex's own default". Claude has no CLI equivalent. */
  reasoningEffort: string;
  maxTurns: string;
  maxBudget: string;
  allowedTools: string;
  permissionMode: string;
  /** Whether one agent's thread post may be typed into another agent's pane
   *  without a person releasing it: "ask" (default) or "auto".
   *
   *  A pane write interrupts whatever that agent was mid-way through, so an
   *  agent authorising its own interrupts is the wrong default. Under "ask"
   *  the post still lands in the buffer — nothing said is lost — and waits for
   *  `dispatch thread approve`. "auto" is for deliberately measuring whether
   *  unsupervised agent chatter helps or hurts; a single thread can opt in
   *  with `thread new --auto` without loosening the default. */
  threadDelivery: string;
  worktreeDir: string;
  claudeTimeout: number;
}

const DEFAULTS: Config = {
  baseBranch: "dev",
  agent: "claude",
  model: "opus[1m]",
  codexModel: "",
  reasoningEffort: "",
  maxTurns: "",
  maxBudget: "",
  allowedTools:
    "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch,WebFetch",
  // Dispatched agents work unattended in a throwaway worktree; a permission
  // prompt there stalls the run until someone notices. `--ask` restores prompts.
  permissionMode: "dontAsk",
  threadDelivery: "ask",
  worktreeDir: ".worktrees",
  claudeTimeout: 30,
};

const KEY_MAP: Record<string, keyof Config> = {
  base_branch: "baseBranch",
  agent: "agent",
  model: "model",
  codex_model: "codexModel",
  reasoning_effort: "reasoningEffort",
  max_turns: "maxTurns",
  max_budget: "maxBudget",
  allowed_tools: "allowedTools",
  permission_mode: "permissionMode",
  thread_delivery: "threadDelivery",
  worktree_dir: "worktreeDir",
  claude_timeout: "claudeTimeout",
  // Runtime-neutral alias for claude_timeout, which predates codex support.
  agent_timeout: "claudeTimeout",
};

export function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function loadConfig(cliOverrides?: Partial<Config>): Config {
  const config: Config = { ...DEFAULTS };

  // 1. Load config file
  const configPath =
    process.env.DISPATCH_CONFIG || join(homedir(), ".dispatch.yml");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseSimpleYaml(raw);
    for (const [yamlKey, value] of Object.entries(parsed)) {
      const configKey = KEY_MAP[yamlKey];
      if (configKey) {
        (config as any)[configKey] =
          configKey === "claudeTimeout" ? Number(value) : value;
      }
    }
  } catch {
    // No config file — that's fine
  }

  // 2. Env vars override config file
  const envMap: [string, keyof Config][] = [
    ["DISPATCH_BASE_BRANCH", "baseBranch"],
    ["DISPATCH_AGENT", "agent"],
    ["DISPATCH_MODEL", "model"],
    ["DISPATCH_CODEX_MODEL", "codexModel"],
    ["DISPATCH_REASONING_EFFORT", "reasoningEffort"],
    ["DISPATCH_MAX_TURNS", "maxTurns"],
    ["DISPATCH_MAX_BUDGET", "maxBudget"],
    ["DISPATCH_ALLOWED_TOOLS", "allowedTools"],
    ["DISPATCH_PERMISSION_MODE", "permissionMode"],
    ["DISPATCH_THREAD_DELIVERY", "threadDelivery"],
    ["DISPATCH_CLAUDE_TIMEOUT", "claudeTimeout"],
  ];
  for (const [envVar, key] of envMap) {
    const val = process.env[envVar];
    if (val) {
      (config as any)[key] =
        key === "claudeTimeout" ? Number(val) : val;
    }
  }

  // Validate before anything is created. An unknown runtime used to surface
  // from getAdapter partway through launch, after the worktree, branch and
  // terminal window already existed, leaving all three behind on every run.
  if (config.agent && !AGENT_KINDS.includes(config.agent as any)) {
    throw new Error(
      `Unknown agent runtime '${config.agent}'. Expected one of: ${AGENT_KINDS.join(", ")}` +
        `\n  Set 'agent:' in ${configPath} or pass --agent.`,
    );
  }

  if (
    config.reasoningEffort &&
    !REASONING_EFFORTS.includes(config.reasoningEffort as any)
  ) {
    throw new Error(
      `Unknown reasoning effort '${config.reasoningEffort}'. Expected one of: ${REASONING_EFFORTS.join(", ")}` +
        `\n  An unrecognised value is rejected by the model provider only once the prompt arrives,` +
        `\n  which looks like an agent that never started.`,
    );
  }

  // 3. CLI flags override everything
  if (cliOverrides) {
    for (const [key, value] of Object.entries(cliOverrides)) {
      if (value !== undefined && value !== "") {
        (config as any)[key] = value;
      }
    }
  }

  return config;
}

/** Shell-safe model flag, or "" when no model is set. `flag` varies by runtime
 *  (claude takes `--model`, codex takes `-m`).
 *  Model names can contain glob metacharacters (`opus[1m]`); zsh aborts the
 *  command with "no matches found" if they reach the shell unquoted. */
export function modelFlag(model: string, flag = "--model"): string {
  if (!model) return "";
  return `${flag} '${model.replace(/'/g, `'\\''`)}'`;
}

/** `--permission-mode` flag, or "" when prompts are wanted (`--ask`). */
export function permissionModeFlag(mode: string): string {
  if (!mode) return "";
  return `--permission-mode ${mode}`;
}
