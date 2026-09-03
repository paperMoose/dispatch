// Every command dispatch dispatches on must be findable in its own help.
//
// `gc` and `doctor` shipped in 0.16.0 and appeared nowhere in 145 lines of
// `dispatch --help`. Both were wired into the command switch and neither was
// documented, so they existed and could not be discovered. Found by running
// every command by hand, which is not a scalable way to notice it again.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf-8");

/** Aliases and meta-commands: real entry points, but not things a reader needs
 *  a separate help line for. Anything added here should be a synonym of a
 *  command that IS documented, not an undocumented feature. */
const ALIASES = new Set([
  "-h", "-v", "--help", "--version", "help", "version",
  "ls", "dir", "threads", "search", "setup", "dashboard",
]);

function switchCommands(): string[] {
  const found = new Set<string>();
  for (const m of cli.matchAll(/^\s+case "([a-z-]+)":/gm)) found.add(m[1]);
  return [...found].sort();
}

function helpText(): string {
  // The help block is a template literal in cli.ts; matching the rendered
  // string rather than importing avoids running the CLI's arg parsing.
  return cli;
}

describe("help covers every command", () => {
  it("finds the command switch at all", () => {
    // If this breaks, the test below silently passes on an empty list.
    assert.ok(switchCommands().length > 10, `only found ${switchCommands().length} commands`);
  });

  it("documents every non-alias command", () => {
    const help = helpText();
    const undocumented = switchCommands().filter(
      (c) => !ALIASES.has(c) && !help.includes(`dispatch ${c}`),
    );
    assert.deepEqual(
      undocumented,
      [],
      `these commands exist but are not in --help: ${undocumented.join(", ")}`,
    );
  });

  it("documents the two that shipped invisible", () => {
    // Named explicitly, so a future refactor of the check above cannot quietly
    // stop covering the exact case that motivated it.
    const help = helpText();
    assert.ok(help.includes("dispatch gc"), "gc missing from help");
    assert.ok(help.includes("dispatch doctor"), "doctor missing from help");
  });

  it("warns that prune keeps dirty worktrees forever", () => {
    // prune and gc do the same job with opposite rules: prune refuses to
    // remove anything with uncommitted changes, which is how a stale worktree
    // survives indefinitely, while gc rescues the work and collects it. Help
    // has to say which is which or the wrong one gets reached for.
    assert.match(helpText(), /prefer gc/);
  });
});
