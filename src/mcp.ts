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
        "Pass the full task prompt inline. Returns agent ID and branch name.",
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
          headless: {
            type: "boolean",
            description:
              "Run in background (fire-and-forget). Default: false (interactive).",
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
            description: "Max agentic turns (headless only)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "dispatch_list",
      description:
        "List all running dispatch agents with their status (running/idle/exited).",
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
          headless: {
            type: "boolean",
            description: "Resume in headless mode",
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
        "Get recent output from a dispatch agent (log file or tmux capture).",
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
        headless,
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
        if (headless) parts.push("--headless");
        if (model) parts.push(`--model ${model}`);
        if (base_branch) parts.push(`--base ${base_branch}`);
        if (max_turns) parts.push(`--max-turns ${max_turns}`);
        if (headless) parts.push("--no-attach");

        const output = dispatch(parts.join(" "));
        return { content: [{ type: "text", text: output }] };
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }
    }

    case "dispatch_list": {
      const output = dispatch("list");
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
      const { agent_id, headless } = args as Record<string, any>;
      const flags = headless ? "--headless" : "";
      const output = dispatch(
        `resume ${agent_id} ${flags} --no-attach`.trim(),
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
          `tmux capture-pane -t "dispatch:${agent_id}" -p -S -${lines}`,
          { encoding: "utf-8", timeout: 5000 },
        );
        return {
          content: [{ type: "text", text: stripAnsi(output).trim() }],
        };
      } catch {
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
