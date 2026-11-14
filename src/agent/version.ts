/**
 * What made a receipt: tool name, release, git commit and spec version.
 * A court or an auditor can then check out that exact commit and replay the
 * computation. See docs/SPEC.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Version of docs/SPEC.md: hashing, Merkle tree, signed message and receipt rules. */
export const SPEC_VERSION = "qorewitness-spec/2";

export interface Generator {
  name: "qorewitness";
  version: string; // package.json version
  commit: string; // 40-hex git commit, or "unknown"
  spec: typeof SPEC_VERSION;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Reads HEAD without running git. Works in a normal checkout and in a worktree. */
export function gitCommit(repo = root): string {
  const env = process.env.QW_COMMIT?.trim();
  if (env && /^[0-9a-f]{40}$/.test(env)) return env;
  try {
    let gitDir = join(repo, ".git");
    if (!existsSync(gitDir)) return "unknown";
    if (!existsSync(join(gitDir, "HEAD"))) {
      // Worktree: .git is a file "gitdir: <path>"
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return "unknown";
      gitDir = resolve(repo, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return "unknown";
    // Loose ref in this git dir or in the common dir (worktrees), then packed-refs.
    const common = existsSync(join(gitDir, "commondir"))
      ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
      : gitDir;
    for (const dir of [gitDir, common]) {
      const p = join(dir, ref);
      if (existsSync(p)) return readFileSync(p, "utf8").trim();
    }
    const packed = join(common, "packed-refs");
    if (existsSync(packed)) {
      const line = readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
      if (line) return line.split(" ")[0];
    }
  } catch {
    // fall through
  }
  return "unknown";
}

export function generator(): Generator {
  let version = "unknown";
  try {
    version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    // keep "unknown"
  }
  return { name: "qorewitness", version, commit: gitCommit(), spec: SPEC_VERSION };
}
