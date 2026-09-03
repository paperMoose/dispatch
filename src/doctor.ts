import { spawnSync } from "child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import { getAdapter } from "./agents.js";
import { isCmuxAvailable } from "./cmux.js";
import type { Config } from "./config.js";

export type DoctorStatus = "ok" | "warning" | "error";

export interface DoctorFinding {
  check: string;
  status: DoctorStatus;
  message: string;
  fix?: string;
}

export interface MultiplexerFacts {
  tmux: boolean;
  cmux: boolean;
}

export interface AgentFact {
  kind: "claude" | "codex";
  onPath: boolean;
  auth: "authenticated" | "unauthenticated" | "unknown";
  authCommand: string;
  detail?: string;
}

export interface GitRepositoryFact {
  inside: boolean;
  root?: string;
}

export interface BaseBranchFact {
  name: string;
  exists: boolean;
  repositoryAvailable: boolean;
  suggested?: string;
}

export interface WorktreeDirectoryFact {
  path: string;
  writable: boolean;
  reason?: string;
}

export interface TurnEndHookFact {
  agent: string;
  installable: boolean;
  reason?: string;
}

export interface NodeVersionFact {
  version: string;
  minimumMajor: number;
}

export interface DoctorFacts {
  multiplexers: MultiplexerFacts;
  agents: AgentFact[];
  repository: GitRepositoryFact;
  baseBranch: BaseBranchFact;
  worktreeDirectory: WorktreeDirectoryFact;
  turnEndHook: TurnEndHookFact;
  node: NodeVersionFact;
}

const finding = (
  check: string,
  status: DoctorStatus,
  message: string,
  fix?: string,
): DoctorFinding => ({ check, status, message, fix });

/** Every check below is pure: callers supply facts, so tests can cover broken
 * machines without mutating the machine running the suite. */
export function checkMultiplexer(facts: MultiplexerFacts): DoctorFinding {
  const available = [facts.cmux && "cmux", facts.tmux && "tmux"].filter(Boolean);
  if (available.length > 0) {
    return finding("multiplexer", "ok", `${available.join(" and ")} available`);
  }
  return finding(
    "multiplexer",
    "error",
    "no usable multiplexer found (checked cmux and tmux)",
    "Install tmux (`brew install tmux`) or run dispatch inside cmux.",
  );
}

export function checkAgent(fact: AgentFact, configuredAgent: string): DoctorFinding {
  const required = fact.kind === configuredAgent;
  const brokenStatus: DoctorStatus = required ? "error" : "warning";
  const role = required ? "configured agent" : "optional agent";

  if (!fact.onPath) {
    return finding(
      `agent ${fact.kind}`,
      brokenStatus,
      `not found on PATH; authentication not checked (${role})`,
      `Install ${fact.kind} and make sure the \`${fact.kind}\` executable is on PATH.`,
    );
  }
  if (fact.auth === "unauthenticated") {
    const login = fact.kind === "claude" ? "claude auth login" : "codex login";
    return finding(
      `agent ${fact.kind}`,
      brokenStatus,
      `on PATH but not authenticated (${role})`,
      `Run \`${login}\`, then verify with \`${fact.authCommand}\`.`,
    );
  }
  if (fact.auth === "unknown") {
    return finding(
      `agent ${fact.kind}`,
      brokenStatus,
      `on PATH but authentication could not be determined${fact.detail ? `: ${fact.detail}` : ""}`,
      `Run \`${fact.authCommand}\` and resolve the reported error.`,
    );
  }
  return finding(
    `agent ${fact.kind}`,
    "ok",
    `on PATH and authenticated${fact.detail ? ` (${fact.detail})` : ""}`,
  );
}

export function checkGitRepository(fact: GitRepositoryFact): DoctorFinding {
  if (fact.inside) {
    return finding("git repository", "ok", `inside ${fact.root || "a git repository"}`);
  }
  return finding(
    "git repository",
    "error",
    "current directory is not inside a git repository",
    "cd into a git repository before running dispatch.",
  );
}

export function checkBaseBranch(fact: BaseBranchFact): DoctorFinding {
  if (!fact.repositoryAvailable) {
    return finding(
      "base branch",
      "error",
      `cannot verify configured base branch '${fact.name}' without a git repository`,
      "Run dispatch from the target repository.",
    );
  }
  if (fact.exists) {
    return finding("base branch", "ok", `'${fact.name}' exists in this repository`);
  }
  const replacement = fact.suggested || "<existing-branch>";
  return finding(
    "base branch",
    "error",
    `configured base branch '${fact.name}' does not exist in this repository`,
    `Set \`base_branch: ${replacement}\` in this repository's .dispatch.yml, or create '${fact.name}'.`,
  );
}

export function checkWorktreeDirectory(fact: WorktreeDirectoryFact): DoctorFinding {
  if (fact.writable) {
    return finding("worktree directory", "ok", `${fact.path} is writable`);
  }
  return finding(
    "worktree directory",
    "error",
    `${fact.path} is not writable${fact.reason ? `: ${fact.reason}` : ""}`,
    "Choose a writable `worktree_dir` in .dispatch.yml or fix the directory permissions.",
  );
}

export function checkTurnEndHook(fact: TurnEndHookFact): DoctorFinding {
  if (fact.installable) {
    return finding("turn-end hook", "ok", `${fact.agent} hook can be installed`);
  }
  return finding(
    "turn-end hook",
    "error",
    `${fact.agent} hook cannot be installed${fact.reason ? `: ${fact.reason}` : ""}`,
    `Update ${fact.agent} and make sure its local configuration directory is writable.`,
  );
}

export function checkNodeVersion(fact: NodeVersionFact): DoctorFinding {
  const major = Number(fact.version.replace(/^v/, "").split(".")[0]);
  if (Number.isInteger(major) && major >= fact.minimumMajor) {
    return finding(
      "node version",
      "ok",
      `Node ${fact.version} meets the >=${fact.minimumMajor} requirement`,
    );
  }
  return finding(
    "node version",
    "error",
    `Node ${fact.version || "unknown"} does not meet the >=${fact.minimumMajor} requirement`,
    `Install Node ${fact.minimumMajor} or newer and ensure it is first on PATH.`,
  );
}

export function diagnoseDoctor(facts: DoctorFacts, configuredAgent: string): DoctorFinding[] {
  return [
    checkMultiplexer(facts.multiplexers),
    ...facts.agents.map((agent) => checkAgent(agent, configuredAgent)),
    checkGitRepository(facts.repository),
    checkBaseBranch(facts.baseBranch),
    checkWorktreeDirectory(facts.worktreeDirectory),
    checkTurnEndHook(facts.turnEndHook),
    checkNodeVersion(facts.node),
  ];
}

export function doctorExitCode(findings: DoctorFinding[]): number {
  return findings.some((item) => item.status === "error") ? 1 : 0;
}

function commandOnPath(command: string): boolean {
  return spawnSync("which", [command], { stdio: "pipe" }).status === 0;
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] || "";
}

function collectAgentFact(kind: "claude" | "codex"): AgentFact {
  const authCommand = kind === "claude" ? "claude auth status" : "codex login status";
  if (!commandOnPath(kind)) {
    return { kind, onPath: false, auth: "unknown", authCommand };
  }

  const args = kind === "claude" ? ["auth", "status"] : ["login", "status"];
  const result = spawnSync(kind, args, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 10_000,
  });
  if (result.error || result.status === null) {
    return {
      kind,
      onPath: true,
      auth: "unknown",
      authCommand,
      detail: result.error?.message || "status command did not finish",
    };
  }

  if (kind === "codex") {
    return {
      kind,
      onPath: true,
      auth: result.status === 0 ? "authenticated" : "unauthenticated",
      authCommand,
      detail: result.status === 0 ? firstLine(result.stderr || result.stdout) : undefined,
    };
  }

  try {
    const status = JSON.parse(result.stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
    };
    if (typeof status.loggedIn !== "boolean") throw new Error("missing loggedIn field");
    return {
      kind,
      onPath: true,
      auth: status.loggedIn ? "authenticated" : "unauthenticated",
      authCommand,
      detail: status.authMethod,
    };
  } catch (error) {
    return {
      kind,
      onPath: true,
      auth: "unknown",
      authCommand,
      detail: `invalid JSON from auth status (${(error as Error).message})`,
    };
  }
}

function gitOutput(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sharedRepositoryRoot(cwd: string, checkoutRoot: string): string {
  const common = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common ? dirname(common) : checkoutRoot;
}

function branchExists(cwd: string, branch: string): boolean {
  return gitOutput(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${branch}^{commit}`,
  ]) !== null;
}

function suggestedBranch(cwd: string, configured: string): string | undefined {
  for (const candidate of ["main", "master"]) {
    if (candidate !== configured && branchExists(cwd, candidate)) return candidate;
  }
  const current = gitOutput(cwd, ["branch", "--show-current"]);
  return current && current !== configured ? current : undefined;
}

function writableDirectory(path: string): { writable: boolean; reason?: string } {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    if (!statSync(existing).isDirectory()) {
      return { writable: false, reason: `${existing} is not a directory` };
    }
    accessSync(existing, constants.W_OK);
    return { writable: true };
  } catch (error) {
    return { writable: false, reason: (error as Error).message };
  }
}

function hookSupportFromCli(agent: string): { supported: boolean; reason?: string } {
  if (!commandOnPath(agent)) {
    return { supported: false, reason: `${agent} is not on PATH` };
  }
  const result = agent === "codex"
    ? spawnSync("codex", ["features", "list"], { encoding: "utf-8", stdio: "pipe" })
    : spawnSync("claude", ["--help"], { encoding: "utf-8", stdio: "pipe" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const supported = result.status === 0 && (
    // A disabled Codex feature is still installable: the adapter explicitly
    // passes `--enable hooks`. Presence in the feature list is the capability.
    agent === "codex" ? /^hooks\s+\S+\s+(?:true|false)\s*$/m.test(output) : /\bhooks\b/i.test(output)
  );
  return supported
    ? { supported: true }
    : { supported: false, reason: `${agent} does not advertise turn-end hook support` };
}

function collectTurnEndHookFact(agent: string): TurnEndHookFact {
  const cliSupport = hookSupportFromCli(agent);
  if (!cliSupport.supported) {
    return { agent, installable: false, reason: cliSupport.reason };
  }

  let temp: string | null = null;
  try {
    temp = mkdtempSync(join(tmpdir(), "dispatch-doctor-hook-"));
    const script = join(temp, "hook.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const args = getAdapter(agent).installTurnEndHook(temp, script);
    if (agent === "codex" && !args.includes("hooks.Stop=")) {
      throw new Error("adapter did not produce a Stop hook setting");
    }
    if (agent === "claude" && !existsSync(join(temp, ".claude", "settings.local.json"))) {
      throw new Error("adapter did not write Claude hook settings");
    }
    return { agent, installable: true };
  } catch (error) {
    return { agent, installable: false, reason: (error as Error).message };
  } finally {
    if (temp) {
      try {
        rmSync(temp, { recursive: true, force: true });
      } catch {
        // The probe already finished; stale temp files do not change whether
        // the runtime accepted the hook configuration.
      }
    }
  }
}

/** Collect impure environment facts once, then hand them to the pure checks. */
export function collectDoctorFacts(config: Config, cwd = process.cwd()): DoctorFacts {
  const checkoutRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  const inside = checkoutRoot !== null;
  const repositoryRoot = checkoutRoot
    ? sharedRepositoryRoot(cwd, checkoutRoot)
    : null;
  const worktreePath = repositoryRoot
    ? join(repositoryRoot, config.worktreeDir)
    : resolve(cwd, config.worktreeDir);
  const worktree = writableDirectory(worktreePath);

  return {
    multiplexers: {
      tmux: commandOnPath("tmux"),
      cmux: isCmuxAvailable(),
    },
    agents: [collectAgentFact("claude"), collectAgentFact("codex")],
    repository: { inside, root: checkoutRoot || undefined },
    baseBranch: {
      name: config.baseBranch,
      exists: inside && branchExists(cwd, config.baseBranch),
      repositoryAvailable: inside,
      suggested: inside ? suggestedBranch(cwd, config.baseBranch) : undefined,
    },
    worktreeDirectory: {
      path: worktreePath,
      writable: inside && worktree.writable,
      reason: inside ? worktree.reason : "cannot resolve it outside a git repository",
    },
    turnEndHook: collectTurnEndHookFact(config.agent),
    // The distributed CLI is compiled with tsup's node20 target.
    node: { version: process.versions.node, minimumMajor: 20 },
  };
}

export function renderDoctor(findings: DoctorFinding[]): void {
  console.log("dispatch doctor");
  for (const item of findings) {
    const marker = item.status === "ok" ? "ok" : item.status === "warning" ? "warn" : "error";
    console.log(`[${marker}] ${item.check}: ${item.message}${item.fix ? ` — Fix: ${item.fix}` : ""}`);
  }
  const errors = findings.filter((item) => item.status === "error").length;
  const warnings = findings.filter((item) => item.status === "warning").length;
  console.log(`${errors} error(s), ${warnings} warning(s)`);
}

export function cmdDoctor(config: Config): number {
  const findings = diagnoseDoctor(collectDoctorFacts(config), config.agent);
  renderDoctor(findings);
  return doctorExitCode(findings);
}
