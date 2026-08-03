// ---------------------------------------------------------------------------
// Agent runtimes
//
// dispatch drives a coding-agent CLI inside a tmux/cmux pane. Everything that
// differs between those CLIs lives behind AgentAdapter: launch lines, TUI
// readiness markers, and log parsing. The rest of the codebase should never
// name a specific CLI.
// ---------------------------------------------------------------------------
import { writeFileSync } from "fs";
import { basename, join } from "path";
import { modelFlag, permissionModeFlag, type Config } from "./config.js";

export type AgentKind = "claude" | "codex";

export const AGENT_KINDS: AgentKind[] = ["claude", "codex"];

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as string[]).includes(value);
}

/** Normalized view of an agent's log stream. Both runtimes produce this shape
 *  so status/list/notify rendering stays runtime-agnostic. */
export interface AgentLogSummary {
  turns: number;
  filesModified: string[];
  toolsUsed: Map<string, number>;
  commits: string[];
  lastActions: string[];
  lastText: string;
}

export type RunMode = "interactive" | "headless";

export interface AgentAdapter {
  kind: AgentKind;

  /** Executable name, as it appears in a pane's echoed launch command. */
  bin: string;

  /** Config field holding this runtime's model. Model names are not portable
   *  between runtimes, so each reads its own. */
  modelKey: "model" | "codexModel";

  /** Launch line used for headless runs. `mode: "interactive"` returns the
   *  bare launch line without a prompt attached. */
  runCmd(
    prompt: string,
    mode: RunMode,
    wtPath: string,
    config: Config,
    extraArgs: string,
    resume: boolean,
  ): string;

  /** Launch line for an interactive pane. The prompt is pasted in afterwards,
   *  once the TUI reports ready. */
  paneCmd(config: Config, resume: boolean): string;

  /** Prepended to both launch lines (e.g. `unset CLAUDECODE && `). */
  shellPrefix: string;

  /** Pane content shows the TUI is rendered and accepting input. */
  isReady(content: string): boolean;

  /** Pane content shows the agent is mid-turn. */
  isBusy(content: string): boolean;

  /** Pane content shows a blocking startup dialog. Returns the keys that
   *  dismiss it, or null when there is nothing to dismiss. */
  dismissStartupDialog(content: string): string | null;

  /** Parse this runtime's log stream into the shared summary shape. */
  parseLog(content: string): AgentLogSummary;
}

const MAX_ACTIONS = 8;

/** Accumulates the shared summary while each runtime's parser walks its own
 *  event shape. Keeps the ring-buffer and de-duplication rules in one place. */
class SummaryBuilder {
  turns = 0;
  lastText = "";
  private files = new Set<string>();
  private tools = new Map<string, number>();
  private commits: string[] = [];
  private actions: string[] = [];

  tool(name: string): void {
    this.tools.set(name, (this.tools.get(name) || 0) + 1);
  }

  file(path: string): void {
    this.files.add(path);
  }

  action(text: string): void {
    if (this.actions.length >= MAX_ACTIONS) this.actions.shift();
    this.actions.push(text);
  }

  /** Shared shell-command analysis. Both runtimes report the command verbatim,
   *  so commit/push/PR detection is identical either side. */
  shellCommand(command: string): void {
    if (command.includes("git commit") || command.includes("git push")) {
      const msg = command.match(/-m\s+["']([^"']+)["']/);
      if (msg) {
        this.commits.push(msg[1].slice(0, 100));
      } else if (command.includes("git push")) {
        this.action("Pushed to remote");
      }
    }
    if (command.includes("gh pr create")) this.action("Created PR");
    this.action(`Ran: ${command.slice(0, 50)}`);
  }

  build(): AgentLogSummary {
    return {
      turns: this.turns,
      filesModified: Array.from(this.files),
      toolsUsed: this.tools,
      commits: this.commits,
      lastActions: this.actions,
      lastText: this.lastText,
    };
  }
}

/** Walk a JSONL stream, skipping blank and malformed lines. The log is tailed
 *  live, so a truncated final line is routine rather than exceptional. */
function eachJsonLine(content: string, fn: (obj: any) => void): void {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    fn(obj);
  }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
const claudeAdapter: AgentAdapter = {
  kind: "claude",
  bin: "claude",
  modelKey: "model",

  runCmd(prompt, mode, wtPath, config, extraArgs, resume) {
    let cmd = "claude";

    if (mode === "headless") cmd += " -p";
    if (resume) cmd += " --continue";

    if (config.model) cmd += ` ${modelFlag(config.model)}`;
    if (config.permissionMode)
      cmd += ` ${permissionModeFlag(config.permissionMode)}`;

    if (mode === "headless") {
      cmd += ` --allowedTools "${config.allowedTools}"`;
      if (config.maxTurns) cmd += ` --max-turns ${config.maxTurns}`;
      if (config.maxBudget) cmd += ` --max-budget-usd ${config.maxBudget}`;
      cmd += " --output-format stream-json --verbose";
    }

    if (extraArgs) cmd += ` ${extraArgs}`;

    if (mode === "headless") {
      const promptFile = join(wtPath, ".dispatch-prompt.txt");
      writeFileSync(promptFile, prompt);
      // stdin redirection — command substitution gets mangled by tmux send-keys
      cmd += ` < '${promptFile}'`;
    }

    return cmd;
  },

  paneCmd(config, resume) {
    const parts = ["claude"];
    if (resume) parts.push("--continue");
    if (config.model) parts.push(modelFlag(config.model));
    if (config.permissionMode) parts.push(permissionModeFlag(config.permissionMode));
    parts.push(`--allowedTools "WebSearch,WebFetch"`);
    return parts.join(" ");
  },

  // Claude Code refuses to start inside another Claude Code session.
  shellPrefix: "unset CLAUDECODE && ",

  // Markers chosen so they cannot match the typed launch command
  // (`unset CLAUDECODE && claude --model …`) — bare "claude" is NOT a marker.
  isReady(content) {
    // Empty prompt indicators on their own line — old (`>`/`?`) and new (`❯`).
    if (/^\s*[>?❯]\s*$/m.test(content)) return true;
    return /❯|Claude Code v\d|\? for shortcuts|╭─|▐▛|Welcome to Claude/.test(content);
  },

  isBusy(content) {
    return /esc to interrupt/i.test(content);
  },

  dismissStartupDialog() {
    return null;
  },

  parseLog(content) {
    const b = new SummaryBuilder();

    eachJsonLine(content, (obj) => {
      if (obj.type !== "assistant") return;
      b.turns++;

      const blocks = obj.message?.content;
      if (!Array.isArray(blocks)) return;

      for (const block of blocks) {
        if (block.type === "text" && block.text) b.lastText = block.text;
        if (block.type !== "tool_use") continue;

        const name = block.name || "unknown";
        const input = block.input || {};
        b.tool(name);

        if (
          (name === "Edit" || name === "Write" || name === "NotebookEdit") &&
          input.file_path
        ) {
          b.file(input.file_path);
        }

        if (name === "Bash" && typeof input.command === "string") {
          b.shellCommand(input.command);
        } else if (name === "Edit" && input.file_path) {
          b.action(`Edited ${basename(input.file_path)}`);
        } else if (name === "Write" && input.file_path) {
          b.action(`Created ${basename(input.file_path)}`);
        } else if (name === "Read" && input.file_path) {
          b.action(`Read ${basename(input.file_path)}`);
        } else if (name === "Grep") {
          b.action(`Searched for "${(input.pattern || "").slice(0, 30)}"`);
        }
      }
    });

    return b.build();
  },
};

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Sandbox/approval flags. Codex refuses to run in an untrusted directory
 *  unless a sandbox policy is given explicitly, and every dispatch worktree is
 *  a brand new path — so one of these must be present on every launch or the
 *  agent stalls on a trust dialog before the prompt is ever sent. */
function codexSandboxFlags(config: Config): string {
  // permissionMode is cleared by `--ask`, which is dispatch's "let a human
  // approve" switch. Everything else runs unattended.
  return config.permissionMode
    ? "--dangerously-bypass-approvals-and-sandbox"
    : "-s workspace-write -a on-request";
}

/** The update banner renders a blocking menu that swallows the keystrokes
 *  meant for the composer, so suppress the check at the source. */
const CODEX_NO_UPDATE_CHECK = "-c check_for_update_on_startup=false";

const codexAdapter: AgentAdapter = {
  kind: "codex",
  bin: "codex",
  modelKey: "codexModel",

  runCmd(prompt, mode, wtPath, config, extraArgs, resume) {
    const parts = ["codex"];

    if (mode === "headless") {
      parts.push("exec");
      if (resume) parts.push("resume", "--last");
      parts.push("--json");
    } else if (resume) {
      parts.push("resume", "--last");
    }

    if (config.codexModel) parts.push(modelFlag(config.codexModel, "-m"));
    parts.push(codexSandboxFlags(config));
    // --search and the update-check override are TUI-only; `codex exec`
    // rejects them outright.
    if (mode === "interactive") {
      parts.push("--search", CODEX_NO_UPDATE_CHECK);
    }

    if (extraArgs) parts.push(extraArgs);

    let cmd = parts.join(" ");

    if (mode === "headless") {
      const promptFile = join(wtPath, ".dispatch-prompt.txt");
      writeFileSync(promptFile, prompt);
      // codex exec reads the prompt from stdin when stdin is piped.
      cmd += ` < '${promptFile}'`;
    }

    return cmd;
  },

  paneCmd(config, resume) {
    const parts = ["codex"];
    if (resume) parts.push("resume", "--last");
    if (config.codexModel) parts.push(modelFlag(config.codexModel, "-m"));
    parts.push(codexSandboxFlags(config));
    parts.push("--search");
    parts.push(CODEX_NO_UPDATE_CHECK);
    return parts.join(" ");
  },

  shellPrefix: "",

  // The header box and footer hint are only present once the TUI has painted;
  // neither can appear in the echoed launch command.
  isReady(content) {
    return />_ OpenAI Codex \(v|Use \/skills to list/.test(content);
  },

  isBusy(content) {
    return /Working \(\d|esc to interrupt/i.test(content);
  },

  dismissStartupDialog(content) {
    // A fresh worktree is an unseen path, so codex asks whether to trust it
    // before it will render the composer. The user dispatched an agent into
    // their own repo, so answer yes rather than stalling the run.
    if (
      /Do you trust the contents of this directory\?/.test(content) &&
      /1\.\s*Yes, continue/.test(content)
    ) {
      return "1";
    }
    // Fallback for codex builds that show the update menu anyway (a cached
    // notice, or a version predating check_for_update_on_startup).
    if (/Update available!/.test(content) && /2\.\s*Skip/.test(content)) {
      return "2";
    }
    return null;
  },

  parseLog(content) {
    const b = new SummaryBuilder();

    eachJsonLine(content, (obj) => {
      if (obj.type !== "item.completed") return;
      const item = obj.item;
      if (!item) return;

      switch (item.type) {
        // Codex reports one `turn.completed` per prompt, not per model
        // response, so agent messages are the closer analogue to a Claude turn.
        case "agent_message":
          b.turns++;
          if (item.text) b.lastText = item.text;
          break;

        case "command_execution":
          b.tool("Bash");
          if (typeof item.command === "string") b.shellCommand(item.command);
          break;

        case "file_change":
          for (const change of item.changes || []) {
            if (!change.path) continue;
            b.file(change.path);
            const verb =
              change.kind === "add"
                ? "Created"
                : change.kind === "delete"
                  ? "Deleted"
                  : "Edited";
            b.tool(verb === "Created" ? "Write" : "Edit");
            b.action(`${verb} ${basename(change.path)}`);
          }
          break;

        case "mcp_tool_call":
          b.tool(item.server ? `${item.server}:${item.tool}` : "mcp");
          break;

        case "web_search":
          b.tool("WebSearch");
          if (item.query) b.action(`Searched for "${String(item.query).slice(0, 30)}"`);
          break;
      }
    });

    return b.build();
  },
};

// ---------------------------------------------------------------------------

const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export const DEFAULT_AGENT: AgentKind = "claude";

export function getAdapter(kind?: AgentKind | string): AgentAdapter {
  // Unset means "not configured" rather than "misconfigured": configs written
  // before codex support, and worktrees with no runtime marker, land here.
  if (!kind) return ADAPTERS[DEFAULT_AGENT];

  const adapter = ADAPTERS[kind as AgentKind];
  if (!adapter) {
    throw new Error(
      `Unknown agent runtime: ${kind}. Expected one of: ${AGENT_KINDS.join(", ")}`,
    );
  }
  return adapter;
}
