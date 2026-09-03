import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Several Claude accounts, and moving an agent between them.
 *
 *  Two facts decide the whole shape of this, both measured rather than assumed
 *  (see docs/NOTE-account-failover.md):
 *
 *  1. `CLAUDE_CONFIG_DIR` isolates authentication completely. A run under a
 *     fresh one reports `loggedIn: false`.
 *  2. Session history lives inside that same directory. So swapping the
 *     directory mid-run would orphan the conversation.
 *
 *  Together those force the design: an agent keeps ONE config directory for
 *  its whole life, and only `.credentials.json` inside it is swapped. History
 *  never moves. The swap is a single file write.
 *
 *  Everything here is opt-in. With no accounts registered, dispatch launches
 *  agents exactly as it always has, against ~/.claude. */

export function accountsDir(): string {
  return join(homedir(), ".dispatch", "accounts");
}

/** Where one agent's isolated config lives, for its whole life. */
export function agentConfigDir(agentId: string): string {
  return join(homedir(), ".dispatch", "agent-config", agentId);
}

const CREDENTIALS = ".credentials.json";

/** Config that belongs to the person, not the account: instructions, skills,
 *  plugins, settings, subagents, hooks. Symlinked into every isolated dir so
 *  an agent on a second account still has the setup Ryan built.
 *
 *  Deliberately excludes `projects`, `sessions`, `session-env`,
 *  `history.jsonl` and `shell-snapshots`: those are the session state that has
 *  to stay per-agent, and sharing them would put every agent in one history. */
export const SHARED_CONFIG = [
  "CLAUDE.md",
  "settings.json",
  "settings.local.json",
  "skills",
  "plugins",
  "agents",
  "hooks",
];

export interface Account {
  name: string;
  /** Path to the stored credentials for this account. */
  credentials: string;
}

export function listAccounts(dir = accountsDir()): Account[] {
  if (!existsSync(dir)) return [];
  const out: Account[] = [];
  for (const name of readdirSync(dir).sort()) {
    const credentials = join(dir, name, CREDENTIALS);
    if (existsSync(credentials)) out.push({ name, credentials });
  }
  return out;
}

/** Whether cycling is configured at all. Everything stays off until it is. */
export function accountsConfigured(dir = accountsDir()): boolean {
  return listAccounts(dir).length > 0;
}

/** Store the credentials currently in `sourceConfigDir` under `name`.
 *
 *  Copied rather than moved: the account the person is logged into stays
 *  logged in. Mode 0600 because this is a live credential. */
export function addAccount(name: string, sourceConfigDir: string, dir = accountsDir()): string {
  const src = join(sourceConfigDir, CREDENTIALS);
  if (!existsSync(src)) {
    throw new Error(
      `No ${CREDENTIALS} in ${sourceConfigDir}. Log in there first, then add it.`,
    );
  }
  const target = join(dir, name);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const dest = join(target, CREDENTIALS);
  copyFileSync(src, dest);
  // chmod, not writeFileSync's mode option: that only applies when the file is
  // created, so copying a loosely-permissioned source left a live credential
  // group- and world-readable. Caught by a test, not by review.
  chmodSync(dest, 0o600);
  return dest;
}

export function removeAccount(name: string, dir = accountsDir()): boolean {
  const target = join(dir, name);
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

/** Which account an agent is currently on, or null. */
export function currentAccount(agentId: string): string | null {
  const marker = join(agentConfigDir(agentId), ".dispatch-account");
  try {
    return readFileSync(marker, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** Point an agent's config directory at `account`, creating it if needed.
 *
 *  Returns the directory to set CLAUDE_CONFIG_DIR to. Safe to call repeatedly:
 *  relinking is idempotent and the credential is simply overwritten, which is
 *  exactly what cycling does. */
export function useAccount(
  agentId: string,
  account: Account,
  sharedFrom = join(homedir(), ".claude"),
): string {
  const dir = agentConfigDir(agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const entry of SHARED_CONFIG) {
    const source = join(sharedFrom, entry);
    if (!existsSync(source)) continue;
    const link = join(dir, entry);
    try {
      // lstat, not existsSync: a symlink whose target vanished still exists as
      // a link and must be replaced rather than skipped.
      statSync(link);
      continue;
    } catch {
      // not there, or a broken link
    }
    try {
      rmSync(link, { force: true });
      symlinkSync(source, link);
    } catch {
      // A missing convenience is not worth failing a launch over; the agent
      // runs without that piece of shared config.
    }
  }

  const live = join(dir, CREDENTIALS);
  writeFileSync(live, readFileSync(account.credentials), { mode: 0o600 });
  chmodSync(live, 0o600);
  writeFileSync(join(dir, ".dispatch-account"), account.name + "\n", { mode: 0o600 });
  return dir;
}

/** The next account to try after `current`, skipping any still limited.
 *
 *  Round-robin from the current one so cycling walks the whole set rather than
 *  hammering the first. Returns null when every account is limited, which the
 *  caller must report rather than paper over: silently continuing on a dead
 *  account looks like the agent hanging. */
export function nextAccount(
  accounts: Account[],
  current: string | null,
  limitedUntil: Record<string, number> = {},
  nowMs: number = Date.now(),
): Account | null {
  if (!accounts.length) return null;
  const start = Math.max(0, accounts.findIndex((a) => a.name === current));
  for (let step = 1; step <= accounts.length; step++) {
    const candidate = accounts[(start + step) % accounts.length];
    const until = limitedUntil[candidate.name];
    if (until && nowMs < until * 1000) continue;
    return candidate;
  }
  return null;
}
