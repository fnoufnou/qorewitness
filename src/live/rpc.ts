/**
 * Minimal JSON-RPC client for the live probes. Read-only: it sends eth_call and a few
 * read methods, never a transaction. Sequential or low concurrency, a gap between
 * requests, retries with backoff. The network function is injectable for tests.
 *
 * An eth_call answer is one of three things:
 *   return    the node ran the call and gave return data (maybe empty)
 *   revert    the node ran the call and it reverted (this is an answer, not an error)
 *   rpc-error the node or the network failed to answer. This is NOT an answer.
 */
import type { Hex } from "viem";

export type CallOutcome =
  | { kind: "return"; data: Hex }
  | { kind: "revert"; data?: Hex; message: string }
  | { kind: "rpc-error"; message: string };

export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface Rpc {
  readonly url: string;
  /** Generic read call. Throws RpcDownError when the node cannot answer after the retries. */
  request(method: string, params: unknown[]): Promise<unknown>;
  /** eth_call at "latest". Never throws. */
  ethCall(to: string, data: Hex, from?: string): Promise<CallOutcome>;
}

export class RpcDownError extends Error {
  constructor(url: string, detail: string) {
    super(`The EVM RPC ${url} did not answer: ${detail}. The testnet may be down. Nothing was concluded from this run.`);
    this.name = "RpcDownError";
  }
}

export interface RpcOptions {
  url: string;
  fetchImpl?: FetchLike;
  retries?: number; // extra attempts after the first
  baseDelayMs?: number; // backoff: base * 2^attempt
  minGapMs?: number; // minimum time between two request starts
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface JsonRpcError { code?: number; message?: string; data?: unknown }

const isRevert = (e: JsonRpcError): boolean =>
  e.code === 3 || /revert/i.test(e.message ?? "") || (typeof e.data === "string" && /^0x[0-9a-f]{8,}$/i.test(e.data));

const revertData = (e: JsonRpcError): Hex | undefined =>
  typeof e.data === "string" && /^0x[0-9a-f]*$/i.test(e.data) ? (e.data as Hex) : undefined;

export function createRpc(opts: RpcOptions): Rpc {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const retries = opts.retries ?? 4;
  const baseDelay = opts.baseDelayMs ?? 400;
  const minGap = opts.minGapMs ?? 40;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  let nextSlot = 0;
  let id = 0;

  /** Spaces request starts by minGap, also when several callers run at once. */
  async function gate(): Promise<void> {
    const t = now();
    const start = Math.max(t, nextSlot);
    nextSlot = start + minGap;
    if (start > t) await sleep(start - t);
  }

  type Raw = { ok: true; result: unknown } | { ok: false; rpcError: JsonRpcError } | { ok: false; transport: string };

  async function once(method: string, params: unknown[]): Promise<Raw> {
    await gate();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, transport: `HTTP ${res.status}` };
      let body: { result?: unknown; error?: JsonRpcError };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        return { ok: false, transport: "answer is not JSON" };
      }
      if (body.error) return { ok: false, rpcError: body.error };
      if (!("result" in body)) return { ok: false, transport: "answer has no result" };
      return { ok: true, result: body.result };
    } catch (err) {
      const e = err as Error;
      return { ok: false, transport: e.name === "AbortError" ? `timeout after ${timeoutMs} ms` : e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retries transport failures and non-revert JSON-RPC errors. A revert is returned at once. */
  async function withRetry(method: string, params: unknown[], stopOnRevert: boolean): Promise<Raw> {
    let last: Raw = { ok: false, transport: "no attempt" };
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1));
      last = await once(method, params);
      if (last.ok) return last;
      if (stopOnRevert && "rpcError" in last && isRevert(last.rpcError)) return last;
    }
    return last;
  }

  const describe = (r: Raw): string =>
    "transport" in r ? r.transport : "rpcError" in r ? `JSON-RPC ${r.rpcError.code ?? "?"} ${(r.rpcError.message ?? "").split("\n")[0]}` : "";

  return {
    url: opts.url,
    async request(method, params) {
      const r = await withRetry(method, params, false);
      if (r.ok) return r.result;
      throw new RpcDownError(opts.url, `${method}: ${describe(r)}`);
    },
    async ethCall(to, data, from) {
      const call: Record<string, string> = { to, data };
      if (from) call.from = from;
      const r = await withRetry("eth_call", [call, "latest"], true);
      if (r.ok) {
        return typeof r.result === "string" && /^0x[0-9a-f]*$/i.test(r.result)
          ? { kind: "return", data: r.result as Hex }
          : { kind: "rpc-error", message: "eth_call result is not hex" };
      }
      if ("rpcError" in r && isRevert(r.rpcError)) {
        return { kind: "revert", data: revertData(r.rpcError), message: (r.rpcError.message ?? "").split("\n")[0] };
      }
      return { kind: "rpc-error", message: describe(r) };
    },
  };
}
