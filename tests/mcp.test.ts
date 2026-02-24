import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import { join } from "path";

const MCP_BIN = join(import.meta.dirname, "..", "dist", "mcp.js");

/** Send JSON-RPC messages to the MCP server and return parsed responses. */
function mcpCall(messages: object[]): any[] {
  const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const raw = execSync(`node "${MCP_BIN}"`, {
    input,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const INIT_MSG = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
};

describe("MCP server", () => {
  it("initializes with correct server info", () => {
    const responses = mcpCall([INIT_MSG]);
    const init = responses.find((r) => r.id === 1);
    assert.ok(init);
    assert.equal(init.result.serverInfo.name, "dispatch");
    assert.equal(init.result.serverInfo.version, "0.1.0");
    assert.ok(init.result.capabilities.tools);
  });

  it("lists all 6 tools", () => {
    const responses = mcpCall([
      INIT_MSG,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const list = responses.find((r) => r.id === 2);
    assert.ok(list);
    const names = list.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, [
      "dispatch_cleanup",
      "dispatch_list",
      "dispatch_logs",
      "dispatch_resume",
      "dispatch_run",
      "dispatch_stop",
    ]);
  });

  it("dispatch_run tool has required prompt parameter", () => {
    const responses = mcpCall([
      INIT_MSG,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const list = responses.find((r) => r.id === 2);
    const runTool = list.result.tools.find((t: any) => t.name === "dispatch_run");
    assert.ok(runTool);
    assert.deepEqual(runTool.inputSchema.required, ["prompt"]);
    assert.ok(runTool.inputSchema.properties.prompt);
    assert.ok(runTool.inputSchema.properties.ticket);
    assert.ok(runTool.inputSchema.properties.name);
    assert.ok(runTool.inputSchema.properties.headless);
    assert.ok(runTool.inputSchema.properties.model);
  });

  it("dispatch_list returns content", () => {
    const responses = mcpCall([
      INIT_MSG,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "dispatch_list", arguments: {} },
      },
    ]);
    const result = responses.find((r) => r.id === 2);
    assert.ok(result);
    assert.ok(result.result.content);
    assert.equal(result.result.content[0].type, "text");
    // Should return something (either agent list or "No agents running" or tmux output)
    assert.ok(typeof result.result.content[0].text === "string");
  });

  it("dispatch_logs returns error for nonexistent agent", () => {
    const responses = mcpCall([
      INIT_MSG,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "dispatch_logs",
          arguments: { agent_id: "nonexistent-agent-xyz" },
        },
      },
    ]);
    const result = responses.find((r) => r.id === 2);
    assert.ok(result);
    assert.ok(result.result.content[0].text.includes("not found"));
  });

  it("dispatch_stop handles nonexistent agent gracefully", () => {
    const responses = mcpCall([
      INIT_MSG,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "dispatch_stop",
          arguments: { agent_id: "nonexistent-agent-xyz" },
        },
      },
    ]);
    const result = responses.find((r) => r.id === 2);
    assert.ok(result);
    assert.ok(typeof result.result.content[0].text === "string");
  });

  it("unknown tool returns error", () => {
    const responses = mcpCall([
      INIT_MSG,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "dispatch_nonexistent",
          arguments: {},
        },
      },
    ]);
    const result = responses.find((r) => r.id === 2);
    assert.ok(result);
    assert.ok(result.result.isError);
    assert.ok(result.result.content[0].text.includes("Unknown tool"));
  });
});
