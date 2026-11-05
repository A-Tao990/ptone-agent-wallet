import { describe, it, expect } from "vitest";
import { MemoryKV, PendingStore, resolvePending, resolveOrphan, allowanceErrors, pendingKey, type PendingRecord, type ChainFacts } from "../src/pending";
import { newNonce, parseAmount, formatAmount } from "../src/core";
const BOB = "0x" + "b".repeat(40);
const intent = (a = "1") => ({ type: "transfer" as const, symbol: "mUSD", amount: parseAmount(a), to: BOB });
const K = pendingKey(46630, "0x" + "1".repeat(40), "0x" + "A".repeat(40));
const H1 = "0x" + "9".repeat(64), H2 = "0x" + "8".repeat(64);
const N = "0x" + "1".repeat(64);
const rec = (o: Partial<PendingRecord> = {}): PendingRecord => ({ nonce: N, state: "unknown", to: BOB, amount: "1", symbol: "mUSD", createdAt: 0, hashes: [{ hash: H1 }], ...o });
/** facts at one snapshot block: nonceUsed + accountCount; per-hash receipt/txNonce */
const facts = (o: Partial<ChainFacts> = {}, hashes: ChainFacts["hashes"] = {}): ChainFacts => ({ nonceUsed: false, accountCount: 5n, accountOwner: OWNER, block: 100n, hashes, ...o });
const OWNER = "0x" + "A".repeat(40), RELAYER = "0x" + "c".repeat(40);
/** from defaults to OWNER when a txNonce is given (use hf(.., n, RELAYER) / hf(.., n, null) for counter-examples) */
const hf = (receipt: "success" | "reverted" | "notfound" | null, txNonce: bigint | null = null, from: string | null | undefined = undefined) => ({ receipt, txNonce, from: from === undefined ? (txNonce === null ? null : OWNER) : from });

/** Mimics main.ts: persist 'submitting' before signing, hash as soon as wallet returns it. */
function submit(s: PendingStore, outcome: "unknown" | "reject" | "crash", hash = H1) {
  s.markSubmitting();
  if (outcome === "crash") return;
  if (outcome === "unknown") s.markHash(hash, s.get()!.nonce);
}

describe("pending lock survives refresh (double-spend guard)", () => {
  it("unknown result keeps the SAME nonce locked in storage; new Preview refused after reload", () => {
    const kv = new MemoryKV(); const a = new PendingStore(kv, K); const n = newNonce();
    a.prepare(intent(), n, 1); submit(a, "unknown");
    const reloaded = new PendingStore(kv, K);
    expect(reloaded.locked()).toBe(true); expect(reloaded.get()!.nonce).toBe(n);
    expect(() => reloaded.prepare(intent(), newNonce(), 2)).toThrow(/unresolved/);
    expect(reloaded.get()!.nonce).toBe(n);
  });
  it("crash mid-submit (no hash) is also locked", () => {
    const kv = new MemoryKV(); const a = new PendingStore(kv, K); a.prepare(intent(), newNonce(), 1); submit(a, "crash");
    const b = new PendingStore(kv, K); expect(b.locked()).toBe(true); expect(b.get()!.hashes).toBeUndefined();
    expect(() => b.prepare(intent(), newNonce(), 2)).toThrow();
  });
  it("a merely prepared (never signed) request may be replaced by a new preview", () => {
    const a = new PendingStore(new MemoryKV(), K); a.prepare(intent("1"), newNonce(), 1);
    expect(a.locked()).toBe(false); const n2 = newNonce(); a.prepare(intent("2"), n2, 2); expect(a.get()!.nonce).toBe(n2);
  });
  it("corrupted storage fails closed (locked), never silently unlocked", () => {
    const kv = new MemoryKV(); kv.setItem(K, "{not json"); expect(new PendingStore(kv, K).locked()).toBe(true);
    kv.setItem(K, JSON.stringify({ nonce: "0x12", state: "prepared" })); expect(new PendingStore(kv, K).locked()).toBe(true);
  });
  it("storage is per account/chain/registry", () => {
    const kv = new MemoryKV(); const k2 = pendingKey(46630, "0x" + "1".repeat(40), "0x" + "C".repeat(40));
    const a = new PendingStore(kv, K); a.prepare(intent(), newNonce(), 1); submit(a, "unknown");
    expect(new PendingStore(kv, k2).locked()).toBe(false);
  });
  it("full cycle: unknown -> blocked -> chain says nonce used -> unlock -> independent transfer allowed", () => {
    const s = new PendingStore(new MemoryKV(), K); const n1 = newNonce(); s.prepare(intent(), n1, 1); submit(s, "unknown");
    expect(() => s.prepare(intent(), newNonce(), 2)).toThrow();
    expect(resolvePending(s.get()!, facts({ nonceUsed: true })).kind).toBe("succeeded"); s.clear();
    const n2 = newNonce(); s.prepare(intent(), n2, 3); expect(n2).not.toBe(n1); expect(s.locked()).toBe(false);
  });
});

describe("REGRESSION: Retry/new-hash must not inherit the old hash's sender nonce (Opus FIX3 #1)", () => {
  it("there is NO re-sign while unknown: markSubmitting on an unknown/submitting request throws (no new tx can be broadcast)", () => {
    const s = new PendingStore(new MemoryKV(), K); s.prepare(intent(), N, 1); submit(s, "unknown");
    expect(() => s.markSubmitting()).toThrow(/not in 'prepared'/);
    const c = new PendingStore(new MemoryKV(), K); c.prepare(intent(), N, 1); submit(c, "crash"); expect(() => c.markSubmitting()).toThrow();
  });
  it("EXACT counter-example: tx1 (sender nonce 5) unknown; a 2nd hash tx2 (nonce 6) the RPC has NOT seen; tx1 reverted -> must stay LOCKED", () => {
    // markHash appends: both candidates kept, tx1's txNonce is NOT copied onto tx2
    const s = new PendingStore(new MemoryKV(), K); s.prepare(intent(), N, 1); submit(s, "unknown", H1);
    s.setTxNonce(H1, 5n, OWNER); s.markHash(H2, N);
    const r = s.get()!; expect(r.hashes).toEqual([{ hash: H1, txNonce: "5", from: OWNER }, { hash: H2 }]);
    // old bug state: count 6 > 5, tx2 notfound, used false => was released. Now:
    const res = resolvePending(r, facts({ accountCount: 6n }, { [H1]: hf("reverted", 5n), [H2]: hf("notfound", null) }));
    expect(res.kind).toBe("still-unknown");
    // also when tx1's nonce 5 was taken by a foreign tx
    expect(resolvePending(r, facts({ accountCount: 6n }, { [H1]: hf("notfound", 5n), [H2]: hf("notfound", null) })).kind).toBe("still-unknown");
  });
  it("released only when EVERY candidate is proven dead, each by its OWN nonce", () => {
    const r = rec({ hashes: [{ hash: H1, txNonce: "5", from: OWNER }, { hash: H2, txNonce: "6", from: OWNER }] });
    expect(resolvePending(r, facts({ accountCount: 6n }, { [H1]: hf("reverted"), [H2]: hf("notfound") })).kind).toBe("still-unknown"); // count 6 does NOT cover nonce 6
    expect(resolvePending(r, facts({ accountCount: 7n }, { [H1]: hf("notfound"), [H2]: hf("notfound") })).kind).toBe("failed-final");
    expect(resolvePending(r, facts({ accountCount: 7n }, { [H1]: hf("reverted"), [H2]: hf("reverted") })).kind).toBe("failed-final");
    expect(resolvePending(r, facts({ accountCount: 7n }, { [H1]: hf("notfound"), [H2]: hf("success") })).kind).toBe("still-unknown"); // success but used=false: inconsistent
  });
  it("old tx reverted, new hash pending in the pool (txNonce known 6 >= count 6): locked", () => {
    const r = rec({ hashes: [{ hash: H1, txNonce: "5", from: OWNER }, { hash: H2, txNonce: "6", from: OWNER }] });
    expect(resolvePending(r, facts({ accountCount: 6n }, { [H1]: hf("reverted", 5n), [H2]: hf("notfound", 6n) })).kind).toBe("still-unknown");
  });
  it("two 'Retry' appends (3 hashes): releases only with all 3 proven", () => {
    const H3 = "0x" + "7".repeat(64);
    const s = new PendingStore(new MemoryKV(), K); s.prepare(intent(), N, 1); submit(s, "unknown", H1); s.markHash(H2, N); s.markHash(H3, N); s.markHash(H3, N);
    expect(s.get()!.hashes!.length).toBe(3); // duplicates not re-added
    const r = s.get()!;
    expect(resolvePending(r, facts({ accountCount: 9n }, { [H1]: hf("reverted"), [H2]: hf("reverted") /* H3 unseen */ })).kind).toBe("still-unknown");
    expect(resolvePending(r, facts({ accountCount: 9n }, { [H1]: hf("reverted"), [H2]: hf("reverted"), [H3]: hf("reverted") })).kind).toBe("failed-final");
  });
  it("released request is reset to prepared with the SAME nonce and NO stale candidates/baseTxCount", () => {
    const s = new PendingStore(new MemoryKV(), K); s.prepare(intent(), N, 1); submit(s, "unknown"); s.setBaseTxCount(4n); s.setTxNonce(H1, 5n, OWNER);
    s.reset(); const r = s.get()!; expect(r).toMatchObject({ nonce: N, state: "prepared" }); expect(r.hashes).toBeUndefined(); expect(r.baseTxCount).toBeUndefined();
    s.markSubmitting(); expect(s.get()!.baseTxCount).toBeUndefined(); // each attempt starts clean
  });
  it("migration: a FIX3-format record {hash, txNonce} becomes a candidate; the old hash is never dropped", () => {
    const kv = new MemoryKV(); kv.setItem(K, JSON.stringify({ nonce: N, state: "unknown", to: BOB, amount: "1", symbol: "mUSD", createdAt: 0, hash: H1, txNonce: "5", baseTxCount: "5" }));
    const r = new PendingStore(kv, K).get()!; expect(r.hashes).toEqual([{ hash: H1, txNonce: "5" }]); expect((r as never as { hash?: string }).hash).toBeUndefined();
    const s = new PendingStore(kv, K); s.markHash(H2, N); expect(s.get()!.hashes!.map((h) => h.hash)).toEqual([H1, H2]);
    // legacy record without txNonce
    kv.setItem(K, JSON.stringify({ nonce: N, state: "unknown", to: BOB, amount: "1", symbol: "mUSD", createdAt: 0, hash: H1 }));
    expect(new PendingStore(kv, K).get()!.hashes).toEqual([{ hash: H1 }]);
  });
});

describe("resolvePending: only proven outcomes unlock", () => {
  it("nonce used at the snapshot => succeeded (whatever the receipts say)", () => {
    for (const receipt of ["success", "notfound", null, "reverted"] as const) expect(resolvePending(rec(), facts({ nonceUsed: true }, { [H1]: hf(receipt) })).kind).toBe("succeeded");
  });
  it("reverted receipt + nonce unused => failed-final", () => expect(resolvePending(rec(), facts({}, { [H1]: hf("reverted") })).kind).toBe("failed-final"));
  it("reverted but nonce unreadable => stays unknown", () => expect(resolvePending(rec(), facts({ nonceUsed: null }, { [H1]: hf("reverted") })).kind).toBe("still-unknown"));
  it("hash not yet mined and its sender nonce unknown => stays locked", () => expect(resolvePending(rec(), facts({}, { [H1]: hf("notfound") })).kind).toBe("still-unknown"));
  it("RPC failure never unlocks", () => expect(resolvePending(rec(), facts({ nonceUsed: null, accountCount: null }, { [H1]: hf(null) })).kind).toBe("still-unknown"));
  it("no hash + not explicit rejection => locked (tx may be in flight); explicit rejection => safe", () => {
    expect(resolvePending(rec({ hashes: undefined, state: "submitting" }), facts()).kind).toBe("still-unknown");
    expect(resolvePending(rec({ hashes: undefined, state: "submitting" }), facts(), true).kind).toBe("failed-final");
  });
  it("wallet-rejected flag cannot override a recorded hash", () => expect(resolvePending(rec(), facts({}, { [H1]: hf("notfound") }), true).kind).toBe("still-unknown"));
  it("single-node 'not found' + any amount of time never releases (no time-based rule)", () => {
    expect(resolvePending(rec({ createdAt: 1 }), facts({ accountCount: 5n }, { [H1]: hf("notfound") })).kind).toBe("still-unknown");
  });
});

describe("replaced / dropped tx (one consistent snapshot block)", () => {
  const r7 = (extra: Partial<PendingRecord> = {}) => rec({ hashes: [{ hash: H1, txNonce: "7", from: OWNER }], ...extra });
  it("sender nonce consumed (count > txNonce) and Registry nonce unused at the SAME block => released, receipt not needed", () => {
    for (const receipt of ["notfound", null] as const) expect(resolvePending(r7(), facts({ accountCount: 8n }, { [H1]: hf(receipt) })).kind).toBe("failed-final");
  });
  it("not consumed yet (count <= txNonce) => locked", () => {
    expect(resolvePending(r7(), facts({ accountCount: 7n }, { [H1]: hf("notfound") })).kind).toBe("still-unknown");
    expect(resolvePending(r7(), facts({ accountCount: 6n }, { [H1]: hf("notfound") })).kind).toBe("still-unknown");
  });
  it("consumed by a tx that DID execute the same Registry nonce -> succeeded, not released as failed", () => {
    expect(resolvePending(r7(), facts({ accountCount: 8n, nonceUsed: true }, { [H1]: hf("notfound") })).kind).toBe("succeeded");
  });
  it("missing proof keeps the lock", () => {
    expect(resolvePending(r7(), facts({ accountCount: null }, { [H1]: hf("notfound") })).kind).toBe("still-unknown");
    expect(resolvePending(r7(), facts({ accountCount: 8n, nonceUsed: null }, { [H1]: hf("notfound") })).kind).toBe("still-unknown");
    expect(resolvePending(r7({ hashes: [{ hash: H1 }] }), facts({ accountCount: 99n }, { [H1]: hf("notfound", null) })).kind).toBe("still-unknown");
    expect(resolvePending(r7(), facts({ accountCount: 8n }, { [H1]: hf("success") })).kind).toBe("still-unknown");
  });
  it("learns the sender nonce from the node per hash when not stored", () => {
    expect(resolvePending(rec(), facts({ accountCount: 8n }, { [H1]: hf("notfound", 7n) })).kind).toBe("failed-final");
    expect(resolvePending(rec(), facts({ accountCount: 7n }, { [H1]: hf("notfound", 7n) })).kind).toBe("still-unknown");
  });
  it("corrupted record: locked, never resolvable by chain facts", () => {
    const kv = new MemoryKV(); kv.setItem(K, "{not json"); const s = new PendingStore(kv, K);
    expect(s.locked()).toBe(true); expect(s.get()!.broken).toBe("corrupt");
    expect(() => s.markSubmitting()).toThrow();
    expect(resolvePending(s.get()!, facts({ accountCount: 99n, nonceUsed: true })).kind).toBe("still-unknown");
    expect(kv.getItem(K)).toBe("{not json");
    kv.setItem(K, JSON.stringify({ ...rec(), amount: "1e5" })); expect(new PendingStore(kv, K).get()!.broken).toBe("corrupt");
    kv.setItem(K, JSON.stringify({ ...rec(), hashes: [{ hash: "0xzz" }] })); expect(new PendingStore(kv, K).get()!.broken).toBe("corrupt");
  });
});

describe("FIX5: sender account must be the compared owner (relayer nonce proves nothing)", () => {
  const legacy = () => rec({ hashes: [{ hash: H1, txNonce: "3" }] }); // pre-FIX5 stored nonce, no from
  it("Codex counter-example: relayer nonce 3, owner count 6, used=false, tx still pending => still-unknown", () => {
    const f = facts({ accountCount: 6n }, { [H1]: hf("notfound", 3n, RELAYER) });
    expect(resolvePending(rec(), f).kind).toBe("still-unknown");
    expect(resolveOrphan({ hash: H1, nonce: N, at: 0 }, f).kind).toBe("still-unknown");
  });
  it("stored relayer pair is not trusted either", () => {
    expect(resolvePending(rec({ hashes: [{ hash: H1, txNonce: "3", from: RELAYER }] }), facts({ accountCount: 6n }, { [H1]: hf("notfound") })).kind).toBe("still-unknown");
  });
  it("missing from (node gave nonce, no from) => still-unknown", () => {
    expect(resolvePending(rec(), facts({ accountCount: 6n }, { [H1]: hf("notfound", 3n, null) })).kind).toBe("still-unknown");
    expect(resolvePending(rec(), facts({ accountCount: 6n }, { [H1]: { receipt: "notfound", txNonce: 3n } })).kind).toBe("still-unknown");
  });
  it("legacy stored txNonce without from => still-unknown (even if consumed)", () => {
    expect(resolvePending(legacy(), facts({ accountCount: 6n }, { [H1]: hf("notfound") })).kind).toBe("still-unknown");
  });
  it("legacy stored nonce + fresh node data with from==owner => may resolve using the fresh pair", () => {
    expect(resolvePending(legacy(), facts({ accountCount: 6n }, { [H1]: hf("notfound", 3n, OWNER) })).kind).toBe("failed-final");
  });
  it("accountOwner missing from facts => still-unknown", () => {
    expect(resolvePending(rec(), facts({ accountCount: 6n, accountOwner: null }, { [H1]: hf("notfound", 3n, OWNER) })).kind).toBe("still-unknown");
    expect(resolvePending(rec(), facts({ accountCount: 6n, accountOwner: RELAYER }, { [H1]: hf("notfound", 3n, OWNER) })).kind).toBe("still-unknown");
  });
  it("normal owner path: from==owner (case-insensitive), count>nonce, used=false => failed-final", () => {
    expect(resolvePending(rec(), facts({ accountCount: 6n }, { [H1]: hf("notfound", 3n, OWNER.toLowerCase()) })).kind).toBe("failed-final");
    expect(resolvePending(rec(), facts({ accountCount: 3n }, { [H1]: hf("notfound", 3n, OWNER) })).kind).toBe("still-unknown");
  });
  it("relayer tx that REVERTED is still a standalone proof (availability kept)", () => {
    expect(resolvePending(rec(), facts({ accountCount: 0n }, { [H1]: hf("reverted", 3n, RELAYER) })).kind).toBe("failed-final");
  });
  it("one owner hash + one relayer hash: relayer one blocks release", () => {
    const r = rec({ hashes: [{ hash: H1 }, { hash: H2 }] });
    expect(resolvePending(r, facts({ accountCount: 9n }, { [H1]: hf("notfound", 3n, OWNER), [H2]: hf("notfound", 4n, RELAYER) })).kind).toBe("still-unknown");
  });
  it("orphan: owner pair released; relayer / legacy / no-from orphans stay locked; store persists the pair", () => {
    const f = (hx: ReturnType<typeof hf>) => facts({ accountCount: 6n }, { [H1]: hx });
    expect(resolveOrphan({ hash: H1, nonce: N, txNonce: "3", from: OWNER, at: 0 }, f(hf("notfound"))).kind).toBe("failed-final");
    expect(resolveOrphan({ hash: H1, nonce: N, txNonce: "3", from: RELAYER, at: 0 }, f(hf("notfound"))).kind).toBe("still-unknown");
    expect(resolveOrphan({ hash: H1, nonce: N, txNonce: "3", at: 0 }, f(hf("notfound"))).kind).toBe("still-unknown");
    const kv = new MemoryKV(); const s = new PendingStore(kv, K); s.markHash(H1, N); s.setOrphanNonce(H1, "3", RELAYER);
    expect(new PendingStore(kv, K).orphans()[0]).toMatchObject({ txNonce: "3", from: RELAYER });
    const s2 = new PendingStore(new MemoryKV(), K); s2.prepare(intent(), N, 1); submit(s2, "unknown"); s2.setTxNonce(H1, 3n, RELAYER);
    expect(s2.get()!.hashes).toEqual([{ hash: H1, txNonce: "3", from: RELAYER }]);
  });
  it("malformed stored from => corrupt (fail closed)", () => {
    const kv = new MemoryKV(); kv.setItem(K, JSON.stringify({ ...rec(), hashes: [{ hash: H1, txNonce: "3", from: "0xzz" }] }));
    expect(new PendingStore(kv, K).get()!.broken).toBe("corrupt");
  });
});

describe("multi-tab", () => {
  it("two tabs both sign the same prepared request: second markSubmitting refused; if both got hashes both are kept", () => {
    const kv = new MemoryKV(); const A = new PendingStore(kv, K), B = new PendingStore(kv, K);
    A.prepare(intent(), N, 1); A.markSubmitting();
    expect(() => B.markSubmitting()).toThrow(/not in 'prepared'/);
    A.markHash(H1, N); B.markHash(H2, N); // a racing tab that did sign anyway
    expect(new PendingStore(kv, K).get()!.hashes!.map((h) => h.hash)).toEqual([H1, H2]);
  });
  it("tab B discards while tab A signs: A's hash is kept as orphan WITH its request nonce, lock survives refresh", () => {
    const kv = new MemoryKV(); const A = new PendingStore(kv, K), B = new PendingStore(kv, K);
    A.prepare(intent(), N, 1); A.markSubmitting(); B.clear(); A.markHash(H1, N);
    const C = new PendingStore(kv, K);
    expect(C.get()).toBeNull(); expect(C.orphans().map((o) => [o.hash, o.nonce])).toEqual([[H1, N]]);
    expect(C.locked()).toBe(true); expect(() => C.prepare(intent(), newNonce(), 3)).toThrow(/unresolved/);
  });
  it("tab B already started a NEW request: A's hash must not overwrite B's record, and B cannot sign while an orphan exists", () => {
    const kv = new MemoryKV(); const A = new PendingStore(kv, K), B = new PendingStore(kv, K);
    const nA = newNonce(), nB = newNonce();
    A.prepare(intent(), nA, 1); A.markSubmitting(); B.clear(); B.prepare(intent("2"), nB, 2); A.markHash(H1, nA);
    expect(B.get()!.nonce).toBe(nB); expect(B.get()!.hashes).toBeUndefined(); expect(B.get()!.state).toBe("prepared");
    expect(B.orphans().length).toBe(1); expect(B.locked()).toBe(true);
    expect(() => B.markSubmitting()).toThrow(); // new nonce cannot be signed while the other tab's tx is unresolved
  });
  it("orphan: released by used, or by its own dead proof; unknown stays locked; no nonce stored stays locked", () => {
    const o = { hash: H1, nonce: N, at: 0 };
    expect(resolveOrphan(o, facts({ nonceUsed: true })).kind).toBe("succeeded");
    expect(resolveOrphan(o, facts({}, { [H1]: hf("reverted") })).kind).toBe("failed-final");
    expect(resolveOrphan(o, facts({ accountCount: 5n }, { [H1]: hf("notfound", 4n) })).kind).toBe("failed-final");
    expect(resolveOrphan(o, facts({ accountCount: 4n }, { [H1]: hf("notfound", 4n) })).kind).toBe("still-unknown");
    expect(resolveOrphan(o, facts({ nonceUsed: null, accountCount: 9n }, { [H1]: hf("notfound", 4n) })).kind).toBe("still-unknown");
    expect(resolveOrphan({ hash: H1, at: 0 }, facts({ accountCount: 9n }, { [H1]: hf("reverted") })).kind).toBe("still-unknown");
  });
  it("orphan removal unlocks only when no orphans and no unresolved record remain; clearAll is the attested path", () => {
    const kv = new MemoryKV(); const s = new PendingStore(kv, K); s.markHash(H1, newNonce());
    expect(s.locked()).toBe(true); s.removeOrphan(H1); expect(s.locked()).toBe(false);
    s.markHash(H1, newNonce()); s.clearAll(); expect(s.locked()).toBe(false);
  });
});

describe("allowance gate", () => {
  const f = (v: bigint) => formatAmount(v);
  it("blocks when allowance < amount", () => {
    expect(allowanceErrors(parseAmount("3"), 0n, f)[0]).toMatch(/Approve allowance/);
    expect(allowanceErrors(parseAmount("3"), parseAmount("2.9"), f)).toHaveLength(1);
  });
  it("passes when allowance covers the amount", () => { expect(allowanceErrors(parseAmount("3"), parseAmount("3"), f)).toEqual([]); });
  it("unknown allowance (RPC failure) blocks", () => expect(allowanceErrors(1n, null, f)).toHaveLength(1));
});
