// ---------------------------------------------------------------------------
// Agent runtimes
//
// dispatch drives a coding-agent CLI inside a tmux/cmux pane. Everything that
// differs between those CLIs lives behind AgentAdapter: launch lines, TUI
// readiness markers, and log parsing. The rest of the codebase should never
// name a specific CLI.
// ---------------------------------------------------------------------------
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { modelFlag, permissionModeFlag, type Config } from "./config.js";

export type AgentKind = "claude" | "codex";

export const AGENT_KINDS: AgentKind[] = ["claude", "codex"];

/** Single-quote a value so shell metacharacters cannot escape the command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Model names that clearly belong to one runtime.
 *
 *  `--model` applies to whichever runtime is selected, so with `agent: codex`
 *  in the config, `-m opus` silently becomes `codex -m opus`. Codex answers
 *  that with a 400 the instant the prompt arrives, and the agent looks like it
 *  simply never started. Catch the mismatch before launching. */
const MODEL_OWNERS: { pattern: RegExp; runtime: AgentKind }[] = [
  { pattern: /^(opus|sonnet|haiku)\b|^claude[-.]/i, runtime: "claude" },
  { pattern: /^(gpt|o[0-9]|codex)[-.]?/i, runtime: "codex" },
];

/** The runtime a model name belongs to, or null when it is not recognisable. */
export function modelRuntime(model: string): AgentKind | null {
  for (const { pattern, runtime } of MODEL_OWNERS) {
    if (pattern.test(model.trim())) return runtime;
  }
  return null;
}

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

  /** Path to the CLI's own session transcript for a worktree, or null.
   *  Interactive agents write no .dispatch.log, so this is the only way an
   *  orchestrator can see what an interactive agent is doing. */
  findSessionFile(wtPath: string, since?: number): string | null;

  /** Parse that session transcript. Its shape differs from the headless
   *  stream, so it gets its own parser. */
  parseSession(content: string): AgentLogSummary;
}

/** Newest-first files under `dir`, recursing at most `depth` levels. Used to
 *  locate session transcripts without walking an unbounded history. */
function recentFiles(
  dir: string,
  match: RegExp,
  depth = 4,
  limit = 60,
  since?: number,
): string[] {
  const found: { path: string; mtime: number }[] = [];

  const walk = (current: string, left: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (left > 0) walk(full, left - 1);
      } else if (match.test(entry)) {
        // A transcript last written before the agent launched belongs to an
        // earlier run in the same worktree path, not to this one.
        if (since !== undefined && st.mtimeMs < since) continue;
        found.push({ path: full, mtime: st.mtimeMs });
      }
    }
  };

  walk(dir, depth);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.path);
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

  /** Shared shell-command analysis. Both runtimes report the command text, but
   *  codex rollouts report argv arrays, where the commit message is a discrete
   *  element and so carries no quotes once joined. Prefer argv when present. */
  shellCommand(command: string, argv?: string[] | null): void {
    if (command.includes("git commit") || command.includes("git push")) {
      // Only trust a -m that follows `git commit` in the same argv, otherwise
      // an unrelated flag (`grep -m 5 … git commit`) is read as the message.
      const gitIdx = argv ? argv.indexOf("git") : -1;
      const mIdx = argv ? argv.indexOf("-m", gitIdx) : -1;
      const argvMsg =
        argv && gitIdx !== -1 && mIdx > gitIdx ? argv[mIdx + 1] : undefined;
      const quoted = command.match(/-m\s+["']([^"']+)["']/);

      if (argvMsg) {
        this.commits.push(argvMsg.slice(0, 100));
      } else if (quoted) {
        this.commits.push(quoted[1].slice(0, 100));
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

/** First `bytes` of a file, or null if unreadable. Transcripts reach tens of
 *  megabytes, so this reads a bounded chunk rather than loading the file. */
function readHead(file: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** True when a transcript belongs to `wtPath`. Only the head of the file is
 *  inspected: both runtimes record cwd early, and transcripts get large. */
function sessionCwdMatches(
  file: string,
  wtPath: string,
  extract: (obj: any) => string | undefined,
): boolean {
  const head = readHead(file, 64_000);
  if (head === null) return false;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd = extract(obj);
    if (cwd) return cwd === wtPath;
  }
  return false;
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

  // Claude Code writes one transcript per session under a directory derived
  // from the cwd. Every line carries `cwd`, so match on that rather than
  // trusting the directory-name escaping, which is undocumented.
  findSessionFile(wtPath, since) {
    const root = join(homedir(), ".claude", "projects");
    if (!existsSync(root)) return null;

    // Claude derives the project directory from the cwd, so every transcript
    // inside it already belongs to this worktree. Matching on the `cwd` field
    // as well would reject a just-started session, whose opening records carry
    // no cwd yet, and hand back a previous run's transcript instead.
    const dir = join(root, wtPath.replace(/[^a-zA-Z0-9]/g, "-"));
    if (!existsSync(dir)) return null;

    const candidates = recentFiles(dir, /\.jsonl$/, 1, 10, since);
    return candidates[0] || null;
  },

  // Session transcripts carry the same assistant/message shape as the
  // headless stream, so the log parser handles them unchanged.
  parseSession(content) {
    return claudeAdapter.parseLog(content);
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
function codexSandboxFlags(
  config: Config,
  form: "tui" | "exec" | "exec-resume",
): string {
  // permissionMode is cleared by `--ask`, which is dispatch's "let a human
  // approve" switch. Everything else runs unattended.
  if (config.permissionMode) {
    // Accepted on all three forms.
    return "--dangerously-bypass-approvals-and-sandbox";
  }

  // The approval/sandbox flags are not available on every subcommand:
  // `codex exec` takes -s but rejects -a, and `codex exec resume` rejects
  // both, so the equivalent has to go through -c config overrides.
  switch (form) {
    case "tui":
      return "-s workspace-write -a on-request";
    case "exec":
      // Nothing can answer an approval prompt in a headless run anyway.
      return "-s workspace-write";
    case "exec-resume":
      return "-c sandbox_mode=workspace-write";
  }
}

/** The update banner renders a blocking menu that swallows the keystrokes
 *  meant for the composer, so suppress the check at the source. */
const CODEX_NO_UPDATE_CHECK = "-c check_for_update_on_startup=false";

/** Reasoning depth. Codex takes this as a config override rather than a flag.
 *  Claude has no CLI equivalent, so the setting is codex-only. */
function codexEffortFlag(config: Config): string {
  if (!config.reasoningEffort) return "";
  // This is typed into a pane shell, so an unquoted value would break out of
  // the codex command entirely.
  return `-c ${shellQuote(`model_reasoning_effort=${config.reasoningEffort}`)}`;
}

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
    const effort = codexEffortFlag(config);
    if (effort) parts.push(effort);

    const form =
      mode === "headless" ? (resume ? "exec-resume" : "exec") : "tui";
    parts.push(codexSandboxFlags(config, form));

    // --search is TUI-only; `codex exec` rejects it outright.
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
    const effort = codexEffortFlag(config);
    if (effort) parts.push(effort);
    parts.push(codexSandboxFlags(config, "tui"));
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

  // Codex writes a rollout transcript per session, tagged with the cwd it ran
  // in, so an interactive agent's activity is recoverable even though it
  // produces no .dispatch.log.
  findSessionFile(wtPath, since) {
    const root = join(homedir(), ".codex", "sessions");
    if (!existsSync(root)) return null;

    // Codex pools every session under one date tree rather than per-cwd, so
    // the cwd in session_meta is the only way to tell them apart.
    for (const file of recentFiles(root, /^rollout-.*\.jsonl$/, 4, 60, since)) {
      const matches = sessionCwdMatches(file, wtPath, (obj) =>
        obj.type === "session_meta" ? obj.payload?.cwd : undefined,
      );
      if (matches) return file;
    }
    return null;
  },

  // The rollout format is not the `exec --json` format: activity arrives as
  // event_msg/response_item envelopes rather than item.completed.
  parseSession(content) {
    const b = new SummaryBuilder();

    eachJsonLine(content, (obj) => {
      const payload = obj.payload;
      if (!payload) return;

      if (obj.type === "event_msg") {
        switch (payload.type) {
          // A run that dies on a rejected model or an API error otherwise
          // parses to all zeros, which reads exactly like an agent that has
          // not started yet.
          case "stream_error":
          case "error": {
            const msg = payload.message || payload.error?.message;
            if (msg) {
              b.lastText = `Error: ${msg}`;
              b.action("Run failed");
            }
            break;
          }
          case "turn_aborted":
            b.action(`Turn aborted (${payload.reason || "unknown"})`);
            break;
          case "agent_message":
            b.turns++;
            if (payload.message) b.lastText = payload.message;
            break;
          case "task_complete":
            // Authoritative final answer for the turn.
            if (payload.last_agent_message) b.lastText = payload.last_agent_message;
            break;
          case "patch_apply_end":
            if (payload.success === false) break;
            for (const path of Object.keys(payload.changes || {})) {
              b.file(path);
              b.tool("Edit");
              b.action(`Edited ${basename(path)}`);
            }
            break;
          case "exec_command_end": {
            const argv = Array.isArray(payload.command) ? payload.command : null;
            const cmd = argv ? argv.join(" ") : payload.command;
            if (typeof cmd === "string") {
              b.tool("Bash");
              b.shellCommand(cmd, argv);
            }
            break;
          }
        }
        return;
      }

      if (obj.type === "response_item" && payload.type === "custom_tool_call") {
        // Newer codex builds route shell work through a code-mode `exec` tool
        // whose input is JS, not a command string. Recover the command when
        // it is a plain literal, and fall back to naming the tool when it is
        // not — better a coarse action than a wrong one.
        b.tool(payload.name === "exec" ? "Bash" : payload.name || "tool");
        // Code-mode input is JS: tools.exec_command({"cmd":"git commit …"}).
        // The key is `cmd`, and it is normally JSON-quoted.
        const literal = String(payload.input || "").match(
          /exec_command\(\s*\{[^}]*?["']?cmd["']?\s*:\s*"((?:[^"\\]|\\.)*)"/,
        );
        if (literal) b.shellCommand(literal[1].replace(/\\(.)/g, "$1"));
        else if (payload.name) b.action(`Ran ${payload.name}`);
      }
    });

    return b.build();
  },

  parseLog(content) {
    const b = new SummaryBuilder();

    eachJsonLine(content, (obj) => {
      // A run that died on a bad model or an API error otherwise parses to all
      // zeros, which is indistinguishable from an agent that just started.
      if (obj.type === "error" && obj.message) {
        b.lastText = `Error: ${obj.message}`;
        b.action("Run failed");
        return;
      }
      if (obj.type === "turn.failed") {
        const msg = obj.error?.message || obj.message;
        b.lastText = msg ? `Turn failed: ${msg}` : "Turn failed";
        b.action("Turn failed");
        return;
      }
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
