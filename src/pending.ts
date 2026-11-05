// Persistent pending-request store + deterministic resolution rules. Pure (no network): chain facts are passed in.
// Goal: after an UNKNOWN result (or a crash/refresh mid-submit) the same nonce stays locked in storage and a new
// Preview (= new nonce = potential double spend) is refused until chain facts settle the first attempt.
import type { TransferIntent } from "./core";

export type PendingState = "prepared" | "submitting" | "unknown";
/** One broadcast candidate. EVERY hash ever returned for this request is kept (never overwritten): each must be proven dead before release. */
/** txNonce + from are a PAIR learned from the node for THAT tx (never inherited from another hash). Without `from`, txNonce is legacy evidence and is NOT trusted. */
export interface HashEntry { hash: string; txNonce?: string; from?: string }
export interface PendingRecord {
  nonce: string; state: PendingState; to: string; amount: string; symbol: string; // amount as decimal string of base units
  hashes?: HashEntry[]; createdAt: number;
  baseTxCount?: string;  // sender pending tx count read before THIS signing attempt: evidence only, reset per attempt
  broken?: "corrupt";    // record unreadable: locked, execute disabled, only an attested Discard clears it
}
/** Hash whose owning record vanished (e.g. other tab discarded it while this tab was signing). Keeps the lock; never overwrites. `nonce` = the Registry request nonce it was sent for. */
export interface OrphanHash { hash: string; nonce?: string; txNonce?: string; from?: string; at: number }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** In-memory KV (DEMO mode and tests). */
export class MemoryKV implements KV {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

export const pendingKey = (chainId: number, registry: string, account: string) => `ptone.pending.v1:${chainId}:${registry.toLowerCase()}:${account.toLowerCase()}`;
const HASH = /^0x[0-9a-fA-F]{64}$/, UINT = /^\d+$/, ADDR = /^0x[0-9a-fA-F]{40}$/;

export class PendingStore {
  constructor(private kv: KV, private key: string) {}
  private get orphanKey() { return this.key + ":orphans"; }
  get(): PendingRecord | null {
    const raw = this.kv.getItem(this.key); if (raw === null) return null;
    try {
      const r = JSON.parse(raw) as PendingRecord & { hash?: string; txNonce?: string }; // legacy (v1 FIX3) fields: hash / txNonce
      if (!r || typeof r !== "object" || !/^0x[0-9a-f]{64}$/.test(r.nonce) || !["prepared", "submitting", "unknown"].includes(r.state)
        || typeof r.to !== "string" || !UINT.test(String(r.amount)) || typeof r.symbol !== "string"
        || (r.hash !== undefined && !HASH.test(r.hash)) || (r.txNonce !== undefined && !UINT.test(r.txNonce))
        || (r.hashes !== undefined && (!Array.isArray(r.hashes) || r.hashes.some((h) => !h || !HASH.test(h.hash) || (h.txNonce !== undefined && !UINT.test(h.txNonce)) || (h.from !== undefined && !ADDR.test(h.from)))))) throw new Error("bad");
      const { hash, txNonce, ...rest } = r;
      const hs = [...(rest.hashes ?? [])];
      if (hash && !hs.some((h) => h.hash.toLowerCase() === hash.toLowerCase())) hs.push(txNonce ? { hash, txNonce } : { hash }); // migration: old candidate is never dropped
      return hs.length ? { ...rest, hashes: hs } : rest;
    } catch { // corrupted record: fail closed (locked unknown, Retry disabled), never silently clear
      return { nonce: "0x" + "0".repeat(64), state: "unknown", to: "?", amount: "0", symbol: "?", createdAt: 0, broken: "corrupt" };
    }
  }
  orphans(): OrphanHash[] {
    const raw = this.kv.getItem(this.orphanKey); if (raw === null) return [];
    try { const a = JSON.parse(raw); if (!Array.isArray(a) || a.some((o) => !o || !HASH.test(o.hash) || (o.nonce !== undefined && !/^0x[0-9a-f]{64}$/.test(o.nonce)) || (o.txNonce !== undefined && !UINT.test(o.txNonce)) || (o.from !== undefined && !ADDR.test(o.from)))) throw new Error("bad"); return a; }
    catch { return [{ hash: "0x" + "0".repeat(64), at: 0 }]; } // unreadable orphan list stays locked (zero-hash can never be proven)
  }
  private putOrphans(a: OrphanHash[]) { if (a.length) this.kv.setItem(this.orphanKey, JSON.stringify(a)); else this.kv.removeItem(this.orphanKey); }
  put(r: PendingRecord) { this.kv.setItem(this.key, JSON.stringify(r)); }
  clear() { this.kv.removeItem(this.key); }
  /** Attested clear (user checked wallet/explorer): drops the record AND orphan hashes. */
  clearAll() { this.kv.removeItem(this.key); this.kv.removeItem(this.orphanKey); }
  removeOrphan(hash: string) { this.putOrphans(this.orphans().filter((o) => o.hash.toLowerCase() !== hash.toLowerCase())); }
  setOrphanNonce(hash: string, txNonce: string, from: string) { this.putOrphans(this.orphans().map((o) => (o.hash.toLowerCase() === hash.toLowerCase() && o.txNonce === undefined ? { ...o, txNonce, from } : o))); }
  /** True when a NEW preview/nonce must be refused: a request may already be in flight or on chain. */
  locked(): boolean { const r = this.get(); return (!!r && r.state !== "prepared") || this.orphans().length > 0; }
  prepare(i: TransferIntent, nonce: string, now: number) {
    if (this.locked()) throw new Error("A previous request has an unresolved result; resolve it first (Check status).");
    this.put({ nonce, state: "prepared", to: i.to, amount: i.amount.toString(), symbol: i.symbol, createdAt: now });
  }
  /** MUST be called (and persisted) BEFORE the wallet is asked to sign. Only a "prepared" request can start a signing attempt:
   *  an unknown request is NEVER re-signed/re-broadcast (no Retry); it is only checked against chain state. */
  markSubmitting() {
    const r = this.get(); if (!r || r.broken) throw new Error("No prepared request");
    if (r.state !== "prepared" || this.orphans().length) throw new Error("Request is not in 'prepared' state (already submitted/unknown): check status instead of signing again");
    this.put({ ...r, state: "submitting", baseTxCount: undefined });
  }
  setBaseTxCount(n: bigint | null) { const r = this.get(); if (r && !r.broken && n !== null) this.put({ ...r, baseTxCount: n.toString() }); }
  /** Persist a wallet tx hash by APPENDING it (all broadcast hashes are kept). If the record is gone or belongs to a different
   *  request (other tab), the hash is kept as an orphan so the lock survives; it never overwrites another request's record. */
  markHash(hash: string, nonce: string) {
    const r = this.get();
    if (r && !r.broken && r.nonce === nonce) {
      const hs = r.hashes ?? [];
      this.put({ ...r, hashes: hs.some((h) => h.hash.toLowerCase() === hash.toLowerCase()) ? hs : [...hs, { hash }], state: "unknown" }); return;
    }
    const o = this.orphans(); if (!o.some((x) => x.hash === hash)) this.putOrphans([...o, { hash, nonce, at: Date.now() }]);
  }
  setTxNonce(hash: string, txNonce: bigint, from: string) {
    const r = this.get(); if (!r || r.broken || !r.hashes) return;
    this.put({ ...r, hashes: r.hashes.map((h) => (h.hash.toLowerCase() === hash.toLowerCase() && h.txNonce === undefined ? { ...h, txNonce: txNonce.toString(), from } : h)) });
  }
  /** Released after chain proof: back to a prepared request (same Registry nonce), all candidates (proven dead) forgotten. */
  reset() { const r = this.get(); if (r && !r.broken) this.put({ nonce: r.nonce, state: "prepared", to: r.to, amount: r.amount, symbol: r.symbol, createdAt: r.createdAt }); }
}

export interface HashFacts {
  receipt: "success" | "reverted" | "notfound" | null; // null = RPC read failed
  txNonce?: bigint | null;                             // sender nonce of THIS tx when the node knows it
  from?: string | null;                                // actual tx.from reported by the node for THIS tx (null/absent = unknown)
}
export interface ChainFacts {
  /** Registry.used(owner, nonce) AT `block`; null = RPC read failed (or nonce unknown). */
  nonceUsed: boolean | null;
  /** Sender getTransactionCount AT THE SAME `block` as nonceUsed (one consistent snapshot); null = failed. */
  accountCount?: bigint | null;
  /** The address whose transaction count `accountCount` is (the owner EOA). A tx nonce only counts against it if tx.from equals this. */
  accountOwner?: string | null;
  block?: bigint | null;
  hashes?: Record<string, HashFacts>;
}
export type Resolution =
  | { kind: "succeeded"; why: string }   // transfer executed on chain: clear, new preview allowed
  | { kind: "failed-final"; why: string } // EVERY broadcast hash proven unable to execute, Registry nonce unused: clear, safe
  | { kind: "still-unknown"; why: string }; // keep locked

type Cand = { hash: string; txNonce?: string; from?: string };
/** A hash is DEAD (can never execute the request) only if:
 *  (a) its receipt is reverted, or
 *  (b) its OWN sender nonce is known AND its actual tx.from is the account whose count is compared, the account count at snapshot block B is > that nonce (slot consumed by some tx),
 *      and Registry.used(owner, nonce) at the same block B is false. If the slot-consumer were this tx it would have set `used`
 *      (or reverted = executed nothing); either way this hash can never be mined later. Needs no receipt. (Reorg caveat in docs.)
 *  A hash the node never saw has no known sender nonce => never dead (it may still land). */
function dead(c: Cand, f: ChainFacts): boolean {
  const hf = f.hashes?.[c.hash] ?? f.hashes?.[c.hash.toLowerCase()];
  if (hf?.receipt === "reverted") return true;
  if (hf?.receipt === "success") return false;
  // (b) needs the sender nonce AND the actual tx.from as a pair, and from must be the very account whose count we compare
  // (a relayer/other sender's nonce says nothing about the owner's count). Missing/mismatched from, legacy nonce-only data => not dead.
  let n: bigint | undefined, from: string | undefined;
  if (hf?.txNonce != null && hf.from) { n = hf.txNonce; from = hf.from; }
  else if (c.txNonce !== undefined && c.from) { n = BigInt(c.txNonce); from = c.from; }
  if (n === undefined || !from || !f.accountOwner || from.toLowerCase() !== f.accountOwner.toLowerCase()) return false;
  return f.accountCount != null && f.accountCount > n && f.nonceUsed === false;
}

/** Deterministic rules. `walletRejected` = wallet explicitly refused before returning any hash (user rejection).
 *  NEVER time-based and never a single-node "not found" inference. */
export function resolvePending(r: PendingRecord, f: ChainFacts, walletRejected = false): Resolution {
  if (r.broken) return { kind: "still-unknown", why: "stored record is corrupted; verify in wallet/explorer, then use the attested Discard" };
  if (f.nonceUsed === true) return { kind: "succeeded", why: "nonce is recorded as used on chain: the transfer executed" };
  if (f.nonceUsed === null) return { kind: "still-unknown", why: "chain read failed (RPC); cannot decide" };
  const hs = r.hashes ?? [];
  if (!hs.length) return walletRejected ? { kind: "failed-final", why: "wallet rejected before any transaction was created" }
    : { kind: "still-unknown", why: "no tx hash recorded and nonce unused: a transaction may still have been sent (submit interrupted); verify in wallet/explorer" };
  const alive = hs.filter((h) => !dead(h, f));
  if (!alive.length) return { kind: "failed-final", why: `all ${hs.length} broadcast hash(es) proven unable to execute (reverted, or their own sender nonce was consumed) and the Registry nonce is unused at block ${f.block ?? "?"}` };
  return { kind: "still-unknown", why: `${alive.length} of ${hs.length} broadcast hash(es) not proven dead (pending, not seen by the node, or sender nonce unknown): ${alive.map((h) => h.hash.slice(0, 10) + "…").join(", ")}; staying locked` };
}

/** Orphan hash (its request record was lost): same proof, using the request nonce stored with it. No nonce stored => stays locked. */
export function resolveOrphan(o: OrphanHash, f: ChainFacts): Resolution {
  if (f.nonceUsed === true) return { kind: "succeeded", why: "orphan's request nonce is used on chain: it executed once" };
  if (!o.nonce) return { kind: "still-unknown", why: "orphan without request nonce cannot be proven; verify in explorer, then Discard (attested)" };
  if (f.nonceUsed === null) return { kind: "still-unknown", why: "chain read failed (RPC)" };
  if (dead({ hash: o.hash, txNonce: o.txNonce, from: o.from }, f)) return { kind: "failed-final", why: "orphan tx proven unable to execute" };
  return { kind: "still-unknown", why: "orphan tx (its request record was lost, e.g. discarded in another tab) is unresolved; verify in explorer, then Discard (attested)" };
}

/** Allowance gate for the preview: Registry can only pull min(allowance). */
export function allowanceErrors(amount: bigint, allowance: bigint | null, decimals: (v: bigint) => string): string[] {
  if (allowance === null) return ["Allowance unknown (RPC read failed)"];
  return allowance < amount ? [`Token allowance to the Registry is ${decimals(allowance)}, below the amount; press "Approve allowance" first`] : [];
}
