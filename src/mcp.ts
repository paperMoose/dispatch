import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import {
  writeFileSync,
  unlinkSync,
  readFileSync,
  existsSync,
} from "fs";
import { getAgentSummaries } from "./history.js";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

function dispatch(args: string): string {
  const cwd = process.env.DISPATCH_CWD || process.cwd();
  try {
    const output = execSync(`dispatch ${args}`, {
      encoding: "utf-8",
      cwd,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stripAnsi(output).trim();
  } catch (e: any) {
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    return stripAnsi(out).trim();
  }
}

function makeTempPrompt(prompt: string): string {
  const name = `dispatch-mcp-${randomBytes(4).toString("hex")}.md`;
  const path = join(tmpdir(), name);
  writeFileSync(path, prompt);
  return path;
}

const server = new Server(
  { name: "dispatch", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "dispatch_run",
      description:
        "Launch a Claude Code agent in an isolated git worktree. " +
        "Pass the full task prompt inline. Returns agent ID and branch name. " +
        "Agents run headless by default (set max_turns to limit). " +
        "After launching, use dispatch_status to check progress.",
      inputSchema: {
        type: "object" as const,
        properties: {
          prompt: {
            type: "string",
            description: "Full task description/prompt for the agent",
          },
          ticket: {
            type: "string",
            description:
              "Linear ticket ID (e.g. HEY-907). Fetches title + description if LINEAR_API_KEY is set.",
          },
          name: {
            type: "string",
            description:
              "Agent name and branch name (kebab-case). Defaults to ticket ID or derived from prompt.",
          },
          model: {
            type: "string",
            description: "Claude model: sonnet, opus, haiku",
          },
          base_branch: {
            type: "string",
            description: "Branch to create worktree from. Default: dev.",
          },
          max_turns: {
            type: "number",
            description: "Max agentic turns",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "dispatch_list",
      description:
        "List all dispatch agents: active (running/idle/exited) and recently completed (last 24h) with outcomes and PR links. " +
        "Start here to see what agents exist, then use dispatch_status on individual agents for details. " +
        "Returns agent IDs you can pass to dispatch_status, dispatch_logs, dispatch_stop, etc.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "dispatch_stop",
      description:
        "Stop a running dispatch agent. Worktree and branch are preserved.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "Agent ID to stop" },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "dispatch_resume",
      description:
        "Resume a previously stopped agent. Picks up where it left off.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: {
            type: "string",
            description: "Agent ID to resume",
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "dispatch_cleanup",
      description:
        "Remove an agent's worktree and optionally its branch.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: {
            type: "string",
            description:
              "Agent ID to clean up. Omit and set all=true for all agents.",
          },
          all: {
            type: "boolean",
            description: "Clean up all worktrees",
          },
          delete_branch: {
            type: "boolean",
            description: "Also delete the git branch",
          },
        },
      },
    },
    {
      name: "dispatch_logs",
      description:
        "Get raw output lines from a dispatch agent's log file or tmux capture. " +
        "Falls back to history summary if the agent has been cleaned up. " +
        "For a structured digest, use dispatch_status instead — it's faster and more useful.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "Agent ID" },
          lines: {
            type: "number",
            description: "Number of lines to return. Default: 50.",
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "dispatch_status",
      description:
        "Get a structured status summary of a dispatch agent: turns completed, files modified, commits made, recent actions, and last output. " +
        "Works for active agents, completed agents, and even cleaned-up agents (via persistent history). " +
        "PREFERRED over dispatch_logs — use this first to understand what an agent did. " +
        "Use dispatch_logs only if you need raw output or more detail.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "Agent ID" },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "dispatch_prune",
      description:
        "Remove stale worktrees. Use merged=true to prune agents whose PRs have been merged " +
        "(stops sessions, removes worktrees and branches). Use dry_run=true to preview.",
      inputSchema: {
        type: "object" as const,
        properties: {
          merged: {
            type: "boolean",
            description: "Only prune agents whose branches/PRs have been merged. Default: true.",
          },
          delete_branch: {
            type: "boolean",
            description: "Also delete the git branch. Default: true.",
          },
          dry_run: {
            type: "boolean",
            description: "Preview what would be pruned without removing anything.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "dispatch_run": {
      const {
        prompt,
        ticket,
        name: agentName,
        model,
        base_branch,
        max_turns,
      } = args as Record<string, any>;

      const tmpFile = makeTempPrompt(prompt);

      try {
        const parts: string[] = ["run"];
        parts.push(ticket || "prompt-file");
        parts.push(`--prompt-file "${tmpFile}"`);
        if (agentName) parts.push(`--name "${agentName}"`);
        if (model) parts.push(`--model ${model}`);
        if (base_branch) parts.push(`--base ${base_branch}`);
        if (max_turns) parts.push(`--max-turns ${max_turns}`);

        const output = dispatch(parts.join(" "));
        return { content: [{ type: "text", text: output }] };
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }
    }

    case "dispatch_list": {
      const output = dispatch("list --brief");
      return {
        content: [{ type: "text", text: output || "No agents running." }],
      };
    }

    case "dispatch_stop": {
      const { agent_id } = args as Record<string, any>;
      const output = dispatch(`stop ${agent_id}`);
      return { content: [{ type: "text", text: output }] };
    }

    case "dispatch_resume": {
      const { agent_id } = args as Record<string, any>;
      const output = dispatch(
        `resume ${agent_id} --no-attach`,
      );
      return { content: [{ type: "text", text: output }] };
    }

    case "dispatch_cleanup": {
      const { agent_id, all, delete_branch } = args as Record<string, any>;
      const parts = ["cleanup"];
      if (all) parts.push("--all");
      else if (agent_id) parts.push(agent_id);
      if (delete_branch) parts.push("--delete-branch");
      const output = dispatch(parts.join(" "));
      return { content: [{ type: "text", text: output }] };
    }

    case "dispatch_logs": {
      const { agent_id, lines = 50 } = args as Record<string, any>;
      const cwd = process.env.DISPATCH_CWD || process.cwd();
      const logPath = join(cwd, ".worktrees", agent_id, ".dispatch.log");

      if (existsSync(logPath)) {
        const content = readFileSync(logPath, "utf-8");
        const logLines = content.split("\n");
        const lastLines = logLines.slice(-lines).join("\n");
        return {
          content: [{ type: "text", text: stripAnsi(lastLines) }],
        };
      }

      // Fallback: capture tmux pane
      try {
        const output = execSync(
          `tmux capture-pane -t "dispatch-${agent_id}" -p -S -${lines}`,
          { encoding: "utf-8", timeout: 5000 },
        );
        return {
          content: [{ type: "text", text: stripAnsi(output).trim() }],
        };
      } catch {
        // Final fallback: check persistent history for summary
        const summaries = getAgentSummaries();
        const agent = summaries.find((a) => a.id === agent_id);
        if (agent) {
          const parts: string[] = [`Agent '${agent_id}' — ${agent.status}`];
          if (agent.launchedAt) parts.push(`Launched: ${new Date(agent.launchedAt).toLocaleString()}`);
          if (agent.completedAt) parts.push(`Completed: ${new Date(agent.completedAt).toLocaleString()}`);
          if (agent.pr) parts.push(`PR: ${agent.pr}`);
          if (agent.summary) parts.push(`\nLast output:\n${agent.summary}`);
          if (agent.prompt) parts.push(`\nOriginal prompt:\n${agent.prompt}`);
          return {
            content: [{ type: "text", text: parts.join("\n") }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Agent '${agent_id}' not found or no output available.`,
            },
          ],
        };
      }
    }

    case "dispatch_status": {
      const { agent_id } = args as Record<string, any>;
      const output = dispatch(`status ${agent_id}`);
      return { content: [{ type: "text", text: output }] };
    }

    case "dispatch_prune": {
      const { merged = true, delete_branch = true, dry_run } = args as Record<string, any>;
      const parts = ["prune"];
      if (merged) parts.push("--merged");
      if (delete_branch) parts.push("--delete-branch");
      if (dry_run) parts.push("--dry-run");
      const output = dispatch(parts.join(" "));
      return { content: [{ type: "text", text: output }] };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
