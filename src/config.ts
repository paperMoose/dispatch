import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface Config {
  baseBranch: string;
  model: string;
  maxTurns: string;
  maxBudget: string;
  allowedTools: string;
  permissionMode: string;
  worktreeDir: string;
  claudeTimeout: number;
}

const DEFAULTS: Config = {
  baseBranch: "dev",
  model: "opus[1m]",
  maxTurns: "",
  maxBudget: "",
  allowedTools:
    "Bash,Read,Write,Edit,Glob,Grep,Task,WebSearch,WebFetch",
  // Dispatched agents work unattended in a throwaway worktree; a permission
  // prompt there stalls the run until someone notices. `--ask` restores prompts.
  permissionMode: "dontAsk",
  worktreeDir: ".worktrees",
  claudeTimeout: 30,
};

const KEY_MAP: Record<string, keyof Config> = {
  base_branch: "baseBranch",
  model: "model",
  max_turns: "maxTurns",
  max_budget: "maxBudget",
  allowed_tools: "allowedTools",
  permission_mode: "permissionMode",
  worktree_dir: "worktreeDir",
  claude_timeout: "claudeTimeout",
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
    ["DISPATCH_MODEL", "model"],
    ["DISPATCH_MAX_TURNS", "maxTurns"],
    ["DISPATCH_MAX_BUDGET", "maxBudget"],
    ["DISPATCH_ALLOWED_TOOLS", "allowedTools"],
    ["DISPATCH_PERMISSION_MODE", "permissionMode"],
    ["DISPATCH_CLAUDE_TIMEOUT", "claudeTimeout"],
  ];
  for (const [envVar, key] of envMap) {
    const val = process.env[envVar];
    if (val) {
      (config as any)[key] =
        key === "claudeTimeout" ? Number(val) : val;
    }
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

/** Shell-safe `--model` flag, or "" when no model is set.
 *  Model names can contain glob metacharacters (`opus[1m]`); zsh aborts the
 *  command with "no matches found" if they reach the shell unquoted. */
export function modelFlag(model: string): string {
  if (!model) return "";
  return `--model '${model.replace(/'/g, `'\\''`)}'`;
}

/** `--permission-mode` flag, or "" when prompts are wanted (`--ask`). */
export function permissionModeFlag(mode: string): string {
  if (!mode) return "";
  return `--permission-mode ${mode}`;
}
