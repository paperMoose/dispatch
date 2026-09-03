// ---------------------------------------------------------------------------
// Agent runtimes
//
// Everything required to launch a coding-agent CLI lives behind AgentAdapter.
// Pane and transcript inspection are a separate, optional capability: a
// harness can participate in dispatch without knowing how to read a TUI or a
// vendor-specific session format.
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
import { codexHookArgs, installClaudeHook } from "./turnhook.js";
import { modelFlag, permissionModeFlag, type Config } from "./config.js";

export type BuiltInAgentKind = "claude" | "codex";
export type AgentKind = string;

export const AGENT_KINDS: AgentKind[] = ["claude", "codex"];

/** Reasoning depths codex accepts. An unrecognised value is not rejected at
 *  launch, only when the prompt reaches the provider, so it has to be caught
 *  here or it presents as an agent that never started. */
export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

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
const MODEL_OWNERS: { pattern: RegExp; runtime: BuiltInAgentKind }[] = [
  { pattern: /^(opus|sonnet|haiku)\b|^claude[-.]/i, runtime: "claude" },
  { pattern: /^(gpt|o[0-9]|codex)[-.]?/i, runtime: "codex" },
];

/** The runtime a model name belongs to, or null when it is not recognisable. */
export function modelRuntime(model: string): BuiltInAgentKind | null {
  for (const { pattern, runtime } of MODEL_OWNERS) {
    if (pattern.test(model.trim())) return runtime;
  }
  return null;
}

/** Outcome of reconciling a requested model with the selected runtime. */
export interface RuntimeChoice {
  /** Runtime to launch. Unchanged unless the model selected a different one. */
  agent: string;
  /** Set when the model changed the runtime, for reporting to the operator. */
  switchedTo?: BuiltInAgentKind;
  /** Set when the request cannot be satisfied; the caller should not launch. */
  error?: string;
}

/** Decide which runtime runs a request.
 *
 *  A model name is a clearer statement of intent than a config default, so a
 *  recognisable model selects its own runtime. Pairing them blindly produced
 *  `codex -m opus`, which is rejected with a 400 as the prompt lands and leaves
 *  an agent that reads as one that never started.
 *
 *  A typed `--agent` still wins, and a typed `--agent` that contradicts the
 *  model is refused: resolving it either way would override something the
 *  operator actually wrote. */
export function resolveRuntime(
  agent: string,
  modelOverride: string,
  agentExplicit: boolean,
): RuntimeChoice {
  if (!modelOverride) return { agent };

  const owner = modelRuntime(modelOverride);
  // An unrecognised name (local or fine-tuned) belongs to whatever is selected.
  if (!owner || owner === agent) return { agent };

  if (agentExplicit) {
    return {
      agent,
      error: `--agent ${agent} cannot run ${modelOverride}, which is a ${owner} model.`,
    };
  }
  return { agent: owner, switchedTo: owner };
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
  kind: string;

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
   *  once the TUI reports ready.
   *
   *  `extraArgs` carries anything the launch itself must configure, currently
   *  the turn-end hook. It matters here and not only in `runCmd` because a
   *  runtime configured by flags rather than by file gets no hook at all
   *  otherwise, and interactive is the common case. */
  paneCmd(config: Config, resume: boolean, extraArgs?: string): string;

  /** Make this runtime run `hookScript` when the agent finishes a turn, so it
   *  fetches its own thread messages instead of being typed at.
   *
   *  Returns launch args to append. Claude is configured by a settings file in
   *  the worktree and returns nothing; Codex takes its hook config as flags
   *  and persists none of it. Both were proven end to end before this existed.
   */
  installTurnEndHook(
    wtPath: string,
    hookScript: string,
    env?: { hookTrustAlreadyBypassed?: boolean },
  ): string;

  /** Prepended to both launch lines (e.g. `unset CLAUDECODE && `). */
  shellPrefix: string;
}

/** Optional support for inspecting a visible pane and vendor transcripts.
 *  Harnesses that only launch and resume agents do not need this capability. */
export interface ScreenReadingAdapter {
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

export type ScreenReadingAgentAdapter = AgentAdapter & ScreenReadingAdapter;

/** Whether an adapter supplies the complete optional screen-reading half. */
export function hasScreenReader(
  adapter: AgentAdapter,
): adapter is ScreenReadingAgentAdapter {
  const candidate = adapter as AgentAdapter & Partial<ScreenReadingAdapter>;
  return (
    typeof candidate.isReady === "function" &&
    typeof candidate.isBusy === "function" &&
    typeof candidate.dismissStartupDialog === "function" &&
    typeof candidate.findSessionFile === "function" &&
    typeof candidate.parseSession === "function" &&
    typeof candidate.parseLog === "function"
  );
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
  lastText = "";
  /** Authoritative count when the runtime reports one. */
  reportedTurns: number | null = null;
  private messageIds = new Set<string>();
  private anonymousTurns = 0;
  private files = new Set<string>();
  private tools = new Map<string, number>();
  private commits: string[] = [];
  private actions: string[] = [];

  /** Count a turn. Claude emits one `assistant` record per content block, all
   *  sharing a message id, so counting records reported 2-5x the real number
   *  against the CLI's own `result.num_turns`. */
  turn(messageId?: string): void {
    if (messageId) this.messageIds.add(messageId);
    else this.anonymousTurns++;
  }

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
      // `git commit -m "$(cat <<'EOF' … EOF)"` is the form Claude Code is told
      // to use; a naive quoted match returns the literal `$(cat <<`.
      const heredoc = command.match(/<<\s*'?(\w+)'?\n([\s\S]*?)\n\s*\1/);
      const quoted = heredoc
        ? ([null, heredoc[2].split("\n")[0]] as unknown as RegExpMatchArray)
        : command.match(/-m\s+["']([^"']*[^"'$(\s][^"']*)["']/);

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
      turns:
        this.reportedTurns ??
        (this.messageIds.size || this.anonymousTurns),
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
const claudeAdapter: ScreenReadingAgentAdapter = {
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

  paneCmd(config, resume, extraArgs) {
    const parts = ["claude"];
    if (resume) parts.push("--continue");
    if (config.model) parts.push(modelFlag(config.model));
    if (config.permissionMode) parts.push(permissionModeFlag(config.permissionMode));
    parts.push(`--allowedTools "WebSearch,WebFetch"`);
    // Claude's hook is a settings file, so extraArgs is normally empty here.
    if (extraArgs) parts.push(extraArgs);
    return parts.join(" ");
  },

  installTurnEndHook(wtPath, hookScript) {
    installClaudeHook(wtPath, hookScript);
    return "";
  },

  // Claude Code refuses to start inside another Claude Code session.
  shellPrefix: "unset CLAUDECODE && ",

  // Markers chosen so they cannot match the typed launch command
  // (`unset CLAUDECODE && claude --model …`) — bare "claude" is NOT a marker.
  // Only markers the TUI itself paints. A bare prompt character is not one:
  // `❯` is the default prompt char for pure, starship and powerlevel10k, so
  // matching it reported "ready" for a pane sitting at a dead shell, and the
  // prompt was then pasted there and executed line by line.
  isReady(content) {
    // The composer box, which is on screen for as long as the TUI is.
    //
    // Everything below it matches the *startup banner*, and a banner scrolls
    // away. An agent that had worked for a couple of hours therefore stopped
    // reading as ready and could never be reached again — the failure got
    // worse the more an agent had done, which is the opposite of what anyone
    // would guess. Seen 2026-08-31 on an agent sitting idle at an empty prompt
    // having just printed "Both jobs are done and pushed".
    //
    // Requiring a rule *both* above and below the prompt is what keeps this
    // off a shell: powerlevel10k draws a rule above its prompt too, and the
    // bare `❯` was the original false positive that let prompts be pasted into
    // dead shells.
    if (/─{10,}[^\n]*\n\s*❯[^\n]*\n\s*─{10,}/.test(content)) return true;
    return /Claude Code v\d|\? for shortcuts|▐▛|Welcome to Claude/.test(content);
  },

  isBusy(content) {
    return /esc to interrupt/i.test(content);
  },

  dismissStartupDialog(content) {
    const asking =
      /Do you trust the files in this folder\?|trust the files in this folder|Is this a project you created or one you trust/i.test(
        content,
      );
    if (!asking) return null;

    // Older builds numbered the options, so typing the digit answered it.
    if (/1\.\s*Yes/i.test(content)) return "1";

    // Current builds render an arrow-key menu and default to the destructive
    // option, which is why this matters:
    //
    //     ❯ No, exit
    //       Yes, I trust this folder
    //
    // There is no digit to type. Matching only the numbered form meant every
    // claude agent launched into a fresh worktree sat on this dialog forever
    // with "No, exit" selected — it looked alive to every process check and
    // never received its prompt. Observed 2026-08-31 across a whole evening of
    // agents that appeared to be running and were not.
    //
    // Move the selection off the default and confirm. The keys are sent as
    // keys rather than typed, hence the prefix.
    if (/Yes, I trust this folder/i.test(content)) return "key:down enter";
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
      if (obj.type === "result" && typeof obj.num_turns === "number") {
        b.reportedTurns = obj.num_turns;
        return;
      }
      if (obj.type !== "assistant") return;
      b.turn(obj.message?.id);

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

/** The startup banner, painted once at the top of the session.
 *
 *  Readiness has to survive scrollback: `send` inspects only the last 40 lines
 *  of the pane, so a marker painted once at startup vanishes as soon as the
 *  agent does enough work to scroll it away. That alone left every later
 *  `send` refused with "no codex prompt is visible" against a perfectly
 *  healthy composer, so the banner is now only half the check. */
const CODEX_BANNER = />_ OpenAI Codex \(v/;

/** The composer's own status line — `<model> <effort> · <cwd>` — repainted
 *  directly beneath the input on every frame, idle or mid-turn.
 *
 *  The cwd runs to the end of the line, and that is what separates it from
 *  codex's mid-turn status, whose segments are dot-separated too
 *  (`… · 1 background terminal running · /ps to view · /stop to close`).
 *
 *  This replaces a `Use /skills to list` marker that was worse than it looked:
 *  that string is one of a dozen placeholder suggestions the composer rotates
 *  through, so it made readiness pass at random rather than reliably. */
const CODEX_COMPOSER = /^\s*\S.*\s·\s+~?\/\S*\s*$/m;

/** Reasoning depth. Codex takes this as a config override rather than a flag.
 *  Claude has no CLI equivalent, so the setting is codex-only. */
function codexEffortFlag(config: Config): string {
  if (!config.reasoningEffort) return "";
  // This is typed into a pane shell, so an unquoted value would break out of
  // the codex command entirely.
  return `-c ${shellQuote(`model_reasoning_effort=${config.reasoningEffort}`)}`;
}

const codexAdapter: ScreenReadingAgentAdapter = {
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

  paneCmd(config, resume, extraArgs) {
    const parts = ["codex"];
    if (resume) parts.push("resume", "--last");
    if (config.codexModel) parts.push(modelFlag(config.codexModel, "-m"));
    const effort = codexEffortFlag(config);
    if (effort) parts.push(effort);
    parts.push(codexSandboxFlags(config, "tui"));
    parts.push("--search");
    parts.push(CODEX_NO_UPDATE_CHECK);
    // Codex configures hooks by flag and persists nothing, so without this an
    // interactive Codex agent never fetches its mail. It is the default agent.
    if (extraArgs) parts.push(extraArgs);
    return parts.join(" ");
  },

  installTurnEndHook(_wtPath, hookScript, env) {
    return codexHookArgs(hookScript, env?.hookTrustAlreadyBypassed ?? false);
  },

  shellPrefix: "",

  isReady(content) {
    return CODEX_BANNER.test(content) || CODEX_COMPOSER.test(content);
  },

  isBusy(content) {
    return /Working \(\d|esc to interrupt/i.test(content);
  },

  dismissStartupDialog(content) {
    // Never while the composer is painted: the dialog text lingers in
    // scrollback, and an agent displaying dispatch's own docs quotes it.
    if (codexAdapter.isReady(content)) return null;
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
    // Codex pools every session, including sub-agent rollouts, under one date
    // tree. A 60-file window covered barely a day and left most worktrees
    // permanently unfindable.
    for (const file of recentFiles(root, /^rollout-.*\.jsonl$/, 4, 400, since)) {
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
          case "mcp_tool_call_end":
            b.tool(payload.server ? `${payload.server}:${payload.tool}` : "mcp");
            break;
          case "web_search_end":
            b.tool("WebSearch");
            if (payload.query) b.action(`Searched for "${String(payload.query).slice(0, 30)}"`);
            break;
          case "turn_aborted":
            b.action(`Turn aborted (${payload.reason || "unknown"})`);
            break;
          case "agent_message":
            b.turn();
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

      // Some codex builds report shell work as function_call with the args in
      // `arguments` rather than custom_tool_call with `input`. Across the real
      // rollouts on this machine that accounted for 330 dropped commands.
      if (obj.type === "response_item" && payload.type === "function_call") {
        const raw = String(payload.arguments || "");
        b.tool(payload.name === "exec_command" ? "Bash" : payload.name || "tool");
        let cmd = "";
        try {
          cmd = JSON.parse(raw).cmd || JSON.parse(raw).command || "";
        } catch {
          const m = raw.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) cmd = m[1].replace(/\\(.)/g, "$1");
        }
        if (cmd) b.shellCommand(cmd);
        else if (payload.name) b.action(`Ran ${payload.name}`);
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
          b.turn();
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

const ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export const DEFAULT_AGENT: BuiltInAgentKind = "claude";

/** Register a harness adapter. The required floor is sufficient; adapters
 *  that also implement ScreenReadingAdapter automatically take the richer
 *  pane and transcript paths at their call sites. */
export function registerAdapter(adapter: AgentAdapter): void {
  if (!adapter.kind.trim()) throw new Error("Agent runtime kind cannot be empty");
  if (ADAPTERS[adapter.kind]) {
    throw new Error(`Agent runtime already registered: ${adapter.kind}`);
  }
  ADAPTERS[adapter.kind] = adapter;
  if (!AGENT_KINDS.includes(adapter.kind)) AGENT_KINDS.push(adapter.kind);
}

export function getAdapter(): ScreenReadingAgentAdapter;
export function getAdapter(kind: BuiltInAgentKind): ScreenReadingAgentAdapter;
export function getAdapter(kind?: string): AgentAdapter;
export function getAdapter(kind?: string): AgentAdapter {
  // Unset means "not configured" rather than "misconfigured": configs written
  // before codex support, and worktrees with no runtime marker, land here.
  if (!kind) return ADAPTERS[DEFAULT_AGENT];

  const adapter = ADAPTERS[kind];
  if (!adapter) {
    throw new Error(
      `Unknown agent runtime: ${kind}. Expected one of: ${AGENT_KINDS.join(", ")}`,
    );
  }
  return adapter;
}
