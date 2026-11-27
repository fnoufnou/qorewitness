/** Shared argument handling for the live probe scripts. */
import { parseArgs } from "node:util";

export interface CommonArgs { report?: string; rpc: string }

export const DEFAULT_RPC = "https://evm-testnet.qore.host";

export function parseCli<T extends Record<string, { type: "string" }>>(argv: string[], extra: T) {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== "--"),
    options: { report: { type: "string" }, rpc: { type: "string" }, ...extra },
    strict: true,
    allowPositionals: false,
  });
  return values as Record<string, string | undefined>;
}

/** The command line as a user would type it, without absolute paths. */
export function commandLine(script: string, argv: string[]): string {
  return ["pnpm", script, ...argv.filter((a) => a !== "--")].join(" ");
}

export function parseIntArg(name: string, v: string | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return Number(v);
}
