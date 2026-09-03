import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join, resolve } from "path";

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

/** Where one agent's isolated config lives, for its whole life.
 *
 *  `base` is injectable so tests do not write into a person's real
 *  ~/.dispatch. An earlier version did exactly that and left eighteen
 *  directories behind, which is the same mistake the integration tests made
 *  with the threads directory. */
export function agentConfigDir(agentId: string, base = join(homedir(), ".dispatch")): string {
  return join(base, "agent-config", agentId);
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
/** Does this text actually carry a usable token?
 *
 *  The check that would have saved an afternoon. `~/.claude/.credentials.json`
 *  exists on this machine and its oauth object is EMPTY: a husk left behind
 *  when the real credential moved to the macOS keychain. Copying it produced a
 *  vault entry that looked fine and authenticated as `loggedIn: false`. */
export function hasToken(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = (parsed.claudeAiOauth as Record<string, unknown>) ?? parsed;
    const token = oauth?.accessToken;
    return typeof token === "string" && token.length > 0;
  } catch {
    return false;
  }
}

/** The live credential for a config directory, from wherever it really lives.
 *
 *  On macOS the default configuration keeps its credential in the keychain,
 *  not in the file, and the file is left behind empty. An isolated
 *  CLAUDE_CONFIG_DIR has no keychain entry and does read the file, which is
 *  why writing one there works. Both were verified directly: the keychain
 *  value written into an isolated directory authenticates. */
export function readLiveCredential(configDir: string): string | null {
  try {
    const raw = readFileSync(join(configDir, CREDENTIALS), "utf-8");
    if (hasToken(raw)) return raw;
  } catch {
    // fall through to the keychain
  }
  // The keychain belongs to the DEFAULT configuration only. An isolated
  // CLAUDE_CONFIG_DIR has no keychain entry of its own, so consulting it for
  // one would quietly hand back the default account no matter which directory
  // was asked about, and every vaulted account would be the same login. Caught
  // by two tests that expected a refusal and got a credential.
  const isDefault = resolve(configDir) === resolve(join(homedir(), ".claude"));
  if (isDefault && process.platform === "darwin") {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (r.status === 0 && r.stdout && hasToken(r.stdout)) return r.stdout.trim();
  }
  return null;
}

export function addAccount(name: string, sourceConfigDir: string, dir = accountsDir()): string {
  const credential = readLiveCredential(sourceConfigDir);
  if (!credential) {
    throw new Error(
      `No usable credential for ${sourceConfigDir}. Log in there first, then add it.`,
    );
  }
  const target = join(dir, name);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const dest = join(target, CREDENTIALS);
  writeFileSync(dest, credential.endsWith("\n") ? credential : credential + "\n", { mode: 0o600 });
  // chmod as well as the mode option: the option only applies when the file is
  // created, so re-adding an account over an existing entry would keep the old
  // permissions. Caught by a test, not by review.
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
export function currentAccount(agentId: string, base = join(homedir(), ".dispatch")): string | null {
  const marker = join(agentConfigDir(agentId, base), ".dispatch-account");
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
  base = join(homedir(), ".dispatch"),
): string {
  const dir = agentConfigDir(agentId, base);
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
