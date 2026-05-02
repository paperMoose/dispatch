import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findRunningCmuxSocket } from "../src/cmux.js";

describe("findRunningCmuxSocket", () => {
  it("returns null when pointer file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cmux-"));
    const got = findRunningCmuxSocket(join(dir, "no-such-pointer"));
    assert.equal(got, null);
  });

  it("returns null when pointer is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cmux-"));
    const ptr = join(dir, "ptr");
    writeFileSync(ptr, "");
    assert.equal(findRunningCmuxSocket(ptr), null);
  });

  it("returns null when pointer references missing socket", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cmux-"));
    const ptr = join(dir, "ptr");
    writeFileSync(ptr, "/nope/missing.sock\n");
    assert.equal(findRunningCmuxSocket(ptr), null);
  });

  it("returns null when pointer references a regular file (not a socket)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-cmux-"));
    const ptr = join(dir, "ptr");
    const fake = join(dir, "fake.sock");
    writeFileSync(fake, "");  // regular file, not a socket
    writeFileSync(ptr, fake + "\n");
    assert.equal(findRunningCmuxSocket(ptr), null);
  });
});
