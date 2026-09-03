// Several accounts, and moving an agent between them.
//
// The shape here is forced by two measured facts, not by taste:
// CLAUDE_CONFIG_DIR isolates authentication, and session history lives inside
// that same directory. So an agent keeps one directory for life and only the
// credential inside it is swapped. Every test below is really checking that
// history never has to move.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SHARED_CONFIG,
  addAccount,
  accountsConfigured,
  listAccounts,
  nextAccount,
  removeAccount,
  useAccount,
  type Account,
} from "../src/accounts.js";

const tmp = (what: string) => mkdtempSync(join(tmpdir(), `dispatch-acct-${what}-`));

function loggedInDir(token = "tok-a"): string {
  const d = tmp("src");
  writeFileSync(join(d, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  return d;
}

describe("the account vault", () => {
  it("is empty until something is added, so nothing changes for anyone", () => {
    const dir = tmp("empty");
    assert.deepEqual(listAccounts(dir), []);
    assert.equal(accountsConfigured(dir), false, "cycling must stay off by default");
  });

  it("stores a credential from a logged-in config dir", () => {
    const dir = tmp("vault");
    addAccount("work", loggedInDir("tok-work"), dir);
    const accounts = listAccounts(dir);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].name, "work");
    assert.match(readFileSync(accounts[0].credentials, "utf-8"), /tok-work/);
  });

  it("writes the credential 0600 and never world-readable", () => {
    // Caught a real bug: writeFileSync's mode option only applies when the
    // file is created, so copying a loosely-permissioned source left a live
    // credential group- and world-readable. It needs an explicit chmod.
    const dir = tmp("perm");
    const src = loggedInDir();
    chmodSync(join(src, ".credentials.json"), 0o644);
    const path = addAccount("work", src, dir);
    assert.equal(lstatSync(path).mode & 0o077, 0, "a live credential must not be group or world readable");
  });

  it("refuses to add an account that is not logged in", () => {
    // Silently storing nothing would produce an account that fails only later,
    // in the middle of a cycle, which is the worst time to find out.
    assert.throws(() => addAccount("empty", tmp("nologin"), tmp("vault2")), /log in there first/i);
  });

  it("removes one, and says whether it was there", () => {
    const dir = tmp("rm");
    addAccount("gone", loggedInDir(), dir);
    assert.equal(removeAccount("gone", dir), true);
    assert.equal(removeAccount("gone", dir), false);
  });
});

describe("pointing an agent at an account", () => {
  it("writes the credential and records which account it is on", () => {
    const vault = tmp("v"); const shared = tmp("shared");
    addAccount("one", loggedInDir("tok-one"), vault);
    const acct = listAccounts(vault)[0];
    const dir = useAccount(`a-${Date.now()}`, acct, shared);
    assert.match(readFileSync(join(dir, ".credentials.json"), "utf-8"), /tok-one/);
    assert.equal(readFileSync(join(dir, ".dispatch-account"), "utf-8").trim(), "one");
  });

  it("links the person's own setup in, so a second account is not a blank slate", () => {
    const vault = tmp("v2"); const shared = tmp("shared2");
    writeFileSync(join(shared, "CLAUDE.md"), "# my instructions");
    mkdirSync(join(shared, "skills"));
    addAccount("two", loggedInDir(), vault);
    const dir = useAccount(`b-${Date.now()}`, listAccounts(vault)[0], shared);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), "# my instructions");
    assert.ok(existsSync(join(dir, "skills")));
  });

  it("never links the session state, or every agent shares one history", () => {
    // This is the whole reason the design works: projects/ and sessions/ stay
    // private to the agent, which is what lets the credential be swapped
    // underneath without orphaning the conversation.
    for (const state of ["projects", "sessions", "session-env", "history.jsonl"]) {
      assert.ok(!SHARED_CONFIG.includes(state), `${state} must not be shared`);
    }
  });

  it("swapping the credential leaves everything else alone", () => {
    // The cycle itself: same directory, different credential, history intact.
    const vault = tmp("v3"); const shared = tmp("shared3");
    addAccount("first", loggedInDir("tok-1"), vault);
    addAccount("second", loggedInDir("tok-2"), vault);
    const [a, b] = listAccounts(vault);
    const id = `c-${Date.now()}`;
    const dir = useAccount(id, a, shared);
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(join(dir, "projects", "history.txt"), "a conversation");

    const again = useAccount(id, b, shared);
    assert.equal(again, dir, "the directory must not move");
    assert.match(readFileSync(join(dir, ".credentials.json"), "utf-8"), /tok-2/);
    assert.equal(readFileSync(join(dir, "projects", "history.txt"), "utf-8"), "a conversation");
  });
});

describe("choosing where to go next", () => {
  const acct = (name: string): Account => ({ name, credentials: `/vault/${name}` });
  const three = [acct("a"), acct("b"), acct("c")];

  it("moves to the next one, not always back to the first", () => {
    assert.equal(nextAccount(three, "a")!.name, "b");
    assert.equal(nextAccount(three, "b")!.name, "c");
  });

  it("wraps around", () => {
    assert.equal(nextAccount(three, "c")!.name, "a");
  });

  it("skips an account that is still limited", () => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(nextAccount(three, "a", { b: soon })!.name, "c");
  });

  it("returns to an account whose limit has passed", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    assert.equal(nextAccount(three, "a", { b: past })!.name, "b");
  });

  it("says nothing rather than picking a dead account when all are limited", () => {
    // The caller has to report this. Continuing on a limited account looks
    // exactly like the agent hanging, which is the failure this whole feature
    // exists to remove.
    const soon = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(nextAccount(three, "a", { a: soon, b: soon, c: soon }), null);
  });

  it("says nothing when there are no accounts at all", () => {
    assert.equal(nextAccount([], null), null);
  });
});
