// MAINNET (4663) user-owned EIP-1193 mode. Fixed target (never from env), verified by chain reads before connect and before every signature.
// Every state-changing step is its own user-confirmed tx. No auto switch/addChain, no auto approve, nothing autonomous.
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { REGISTRY_ABI, ERC20_ABI } from "./chain";
import { checkPolicy, formatAmount, newNonce, parseAmount, parseHours, parseIntent, type Policy, type TransferIntent } from "./core";
import { PendingStore, allowanceErrors, pendingKey, resolveOrphan, resolvePending, type ChainFacts, type HashFacts, type KV } from "./pending";

export const MAINNET = {
  chainId: 4663, name: "Robinhood Chain Mainnet", explorer: "https://robinhoodchain.blockscout.com",
  registry: "0x92ad0E8D7d48334b9f9535dd9109C8A37271f45D", wif: "0x5173b8eA6923c2d40267890D45C46a3480954773",
  codeHash: "0x1539ae84f0c9440ce6eb8f44f4ecf493d39ca8cb823998aca722b4ea2b25c5cf",
  fee: 10n ** 18n, feeSink: "0xFC51A000e7E0B48f271BE023f494E8c46a5f660f",
} as const;
export type Target = { chainId: number; name: string; explorer: string; registry: string; wif: string; codeHash: string; fee: bigint; feeSink: string };
/** Guardrails of this first version (tiny amounts only). */
export const LIMITS = { perTx: parseAmount("1"), total: parseAmount("2"), maxHours: 24 };
const EXTRA_ABI = parseAbi(["function wif() view returns (address)", "function feeSink() view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

export interface Eth { request(a: { method: string; params?: unknown[] }): Promise<unknown>; on?(e: string, f: (...a: never[]) => void): void; removeListener?(e: string, f: (...a: never[]) => void): void }
const lc = (s: string) => s.toLowerCase();

/** Raw JSON-RPC reads through the provider. Failure => throws (caller turns into UNKNOWN, never a default). */
export class Rpc {
  constructor(private eth: Eth) {}
  req<T = unknown>(method: string, params: unknown[] = []) { return this.eth.request({ method, params }) as Promise<T>; }
  async chainId() { return parseInt(await this.req<string>("eth_chainId"), 16); }
  async accounts() { return (await this.req<string[]>("eth_accounts")).map(lc); }
  getCode(a: string) { return this.req<string>("eth_getCode", [a, "latest"]); }
  async call<T>(to: string, abi: never, fn: string, args: unknown[] = [], block?: bigint): Promise<T> {
    const data = encodeFunctionData({ abi, functionName: fn, args } as never);
    const out = await this.req<Hex>("eth_call", block === undefined ? [{ to, data }, "latest"] : [{ to, data }, "0x" + block.toString(16)]);
    return decodeFunctionResult({ abi, functionName: fn, data: out } as never) as T;
  }
  async balance(a: string) { return BigInt(await this.req<string>("eth_getBalance", [a, "latest"])); }
}

export type Verified = { ok: true } | { ok: false; reason: string };
/** Chain id + deployed code hash + immutables (wif / fee / feeSink) against the FIXED target. Any mismatch or read failure => not ok (read-only). */
export async function verifyTarget(rpc: Rpc, t: Target = MAINNET): Promise<Verified> {
  try {
    const id = await rpc.chainId();
    if (id !== t.chainId) return { ok: false, reason: `wrong network (${id}); switch your wallet to Robinhood Chain Mainnet (${t.chainId}) yourself (no auto-switch)` };
    const code = await rpc.getCode(t.registry);
    if (!code || code === "0x") return { ok: false, reason: "no contract code at the fixed Registry address" };
    if (lc(keccak256(code as Hex)) !== lc(t.codeHash)) return { ok: false, reason: "Registry code hash does not match the pinned deployment (read-only)" };
    const [w, fee, sink] = await Promise.all([rpc.call<string>(t.registry, EXTRA_ABI as never, "wif"), rpc.call<bigint>(t.registry, REGISTRY_ABI as never, "onboardingFee"), rpc.call<string>(t.registry, EXTRA_ABI as never, "feeSink")]);
    if (lc(w) !== lc(t.wif)) return { ok: false, reason: "Registry.wif() differs from the pinned WIF token" };
    if (fee !== t.fee) return { ok: false, reason: `Registry.onboardingFee() is ${fee}, pinned ${t.fee}` };
    if (lc(sink) !== lc(t.feeSink)) return { ok: false, reason: "Registry.feeSink() differs from the pinned sink" };
    return { ok: true };
  } catch (e) { return { ok: false, reason: "verification read failed (unknown): " + (e as Error).message.split("\n")[0] }; }
}

export type Kind = "approveFee" | "register" | "setPolicy" | "approveSpend" | "revokePolicy" | "zeroAllowance" | "transfer";
export interface ActionLockRec { kind: Kind; hash?: string; at: number }
/** Persistent "a non-transfer tx may be in flight" lock (transfers use PendingStore). */
export class ActionLock {
  constructor(private kv: KV, private key: string) {}
  get(): ActionLockRec | null { const r = this.kv.getItem(this.key); if (r === null) return null; try { const j = JSON.parse(r); if (j && typeof j.kind === "string") return j; } catch { /* fallthrough */ } return { kind: "setPolicy", at: 0 }; } // unreadable => locked
  begin(kind: Kind) { this.kv.setItem(this.key, JSON.stringify({ kind, at: Date.now() })); }
  hash(h: string) { const r = this.get(); this.kv.setItem(this.key, JSON.stringify({ ...(r ?? { kind: "setPolicy", at: Date.now() }), hash: h })); }
  clear() { this.kv.removeItem(this.key); }
}

export interface Session { epoch: number; chainId: number; account: string; eth: Eth; rpc: Rpc; store: PendingStore; lock: ActionLock }
export interface Facts { registered: boolean | null; policy: (Policy & { executor: string }) | null | "unknown"; allowance: bigint | null; gasEth: bigint | null; wif: bigint | null; isAllowedSelf: boolean | null; decimals: number | null }
export interface Staged { id: number; kind: Kind; title: string; lines: string[]; to: string; data: Hex; epoch: number; nonce?: string }
export interface MnState { phase: "disconnected" | "wrongNetwork" | "readonly" | "ready" | "noAccount"; reason: string; account: string | null; facts: Facts | null; staged: Staged | null; log: string[]; locked: string | null }
export class NotSent extends Error {}
const EMPTY: Facts = { registered: null, policy: "unknown", allowance: null, gasEth: null, wif: null, isAllowedSelf: null, decimals: null };

export class MainnetController {
  epoch = 0; session: Session | null = null; state: MnState = { phase: "disconnected", reason: "", account: null, facts: null, staged: null, log: [], locked: null };
  private busy = false; private sid = 0; private listeners: [string, (...a: never[]) => void][] = [];
  constructor(readonly eth: Eth, private kv: KV, readonly target: Target = MAINNET, private onChange: () => void = () => {}, private waitMs = 90_000, private pollMs = 1500) {}

  private emit() { this.onChange(); }
  private log(m: string) { this.state.log = [m, ...this.state.log].slice(0, 60); this.emit(); }
  private cur(s: Session) { return this.session === s && s.epoch === this.epoch; }
  private async sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

  /** User clicked Connect: asks the wallet for accounts (only wallet request outside signing), then loads. */
  async connect() {
    const accts = (await this.eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!this.listeners.length && this.eth.on) {
      const inv = () => { void this.invalidate(); };
      for (const ev of ["accountsChanged", "chainChanged", "disconnect"]) { this.eth.on(ev, inv as never); this.listeners.push([ev, inv as never]); }
    }
    if (!accts?.length) { this.invalidate(true); return; }
    await this.load();
  }
  /** accountsChanged / chainChanged / disconnect / leaving mainnet: old session dies, UI results of old requests are dropped; stores are untouched. */
  async invalidate(noReload = false) {
    this.epoch++; this.session = null; this.state = { ...this.state, staged: null, facts: null, phase: "disconnected", reason: "wallet account/network changed: re-checking", locked: null };
    this.emit();
    if (!noReload && this.listeners.length) await this.load();
  }
  detach() { this.epoch++; this.session = null; for (const [e, f] of this.listeners) this.eth.removeListener?.(e, f); this.listeners = []; this.state = { ...this.state, phase: "disconnected", staged: null, facts: null, account: null, reason: "left mainnet mode", locked: null }; this.emit(); }

  async load() {
    const epoch = this.epoch; const rpc = new Rpc(this.eth);
    let accts: string[]; try { accts = await rpc.accounts(); } catch { this.state = { ...this.state, phase: "readonly", reason: "cannot read wallet accounts (unknown)", account: null }; return this.emit(); }
    if (epoch !== this.epoch) return;
    if (!accts.length) { this.state = { ...this.state, phase: "noAccount", reason: "wallet has no connected account", account: null, facts: null }; return this.emit(); }
    const account = accts[0];
    const v = await verifyTarget(rpc, this.target); if (epoch !== this.epoch) return;
    const chainId = await rpc.chainId().catch(() => -1);
    const key = pendingKey(this.target.chainId, this.target.registry, account);
    const s: Session = { epoch, chainId, account, eth: this.eth, rpc, store: new PendingStore(this.kv, key), lock: new ActionLock(this.kv, "ptone.act.v1:" + key) };
    this.session = s; this.state = { ...this.state, account, staged: null, phase: v.ok ? "ready" : chainId !== this.target.chainId ? "wrongNetwork" : "readonly", reason: v.ok ? "" : v.reason, facts: null };
    this.emit();
    if (!v.ok) return;
    if (s.store.locked()) { this.log("Recovered an unresolved transfer request from storage; checking chain (read-only)…"); await this.settle(s).catch(() => {}); }
    if (this.cur(s) && s.lock.get()) await this.checkLock(s).catch(() => {});
    if (this.cur(s)) await this.refresh();
  }

  /** Reads all facts; every failed read stays unknown (null / "unknown"), never defaults like "not registered" / "no policy". */
  async refresh() {
    const s = this.session; if (!s) return; const t = this.target; const f: Facts = { ...EMPTY };
    const safe = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };
    f.registered = await safe(s.rpc.call<boolean>(t.registry, REGISTRY_ABI as never, "registered", [s.account]));
    const pol = await safe(s.rpc.call<readonly [string, bigint, bigint, bigint, bigint, boolean, string]>(t.registry, REGISTRY_ABI as never, "policies", [s.account]));
    f.policy = pol === null ? "unknown" : pol[4] === 0n ? null : { symbol: "WIF", perTxCap: pol[1], totalCap: pol[2], spent: pol[3], expiry: Number(pol[4]), active: pol[5], allowlist: [], executor: pol[6] };
    f.allowance = await safe(s.rpc.call<bigint>(t.wif, ERC20_ABI as never, "allowance", [s.account, t.registry]));
    f.wif = await safe(s.rpc.call<bigint>(t.wif, ERC20_ABI as never, "balanceOf", [s.account]));
    f.gasEth = await safe(s.rpc.balance(s.account));
    const d = await safe(s.rpc.call<number>(t.wif, ERC20_ABI as never, "decimals")); f.decimals = d === null ? null : Number(d);
    f.isAllowedSelf = await safe(s.rpc.call<boolean>(t.registry, REGISTRY_ABI as never, "isAllowed", [s.account, s.account]));
    if (!this.cur(s)) return; // stale: dropped
    const lock = s.lock.get(), pend = s.store.locked();
    this.state = { ...this.state, facts: f, locked: lock ? `${lock.kind} tx ${lock.hash ?? "(no hash recorded)"} unresolved` : pend ? "transfer request unresolved" : null };
    this.emit();
  }

  private need(f: Facts | null): Facts { if (!f) throw new Error("State not loaded yet"); return f; }
  private ready(): Session { const s = this.session; if (!s || this.state.phase !== "ready") throw new Error("Signing disabled: " + (this.state.reason || this.state.phase)); if (s.lock.get()) throw new Error("A previous transaction is unresolved: use Check status (no new signing)"); if (s.store.locked()) throw new Error("A previous transfer request is unresolved: use Check status"); return s; }
  private dec(f: Facts): number { if (f.decimals === null) throw new Error("WIF decimals unknown (read failed)"); if (f.decimals > 36) throw new Error("Unreasonable decimals"); return f.decimals; }
  private async gasLine(s: Session, to: string, data: Hex): Promise<string> {
    try { const [g, p] = await Promise.all([s.rpc.req<string>("eth_estimateGas", [{ from: s.account, to, data }]), s.rpc.req<string>("eth_gasPrice")]); return `~${formatAmount(BigInt(g) * BigInt(p))} ETH (estimate, paid by you)`; }
    catch { return "NOT ESTIMATED (estimate failed; may revert) — you pay gas in ETH"; }
  }
  private async fresh(s: Session): Promise<Facts> { await this.refresh(); if (!this.cur(s)) throw new Error("Wallet changed: action cancelled"); return this.need(this.state.facts); }

  /** STAGE = build + show the exact tx (fee / gas / principal); nothing is signed. Confirm is a separate user action. */
  async stage(kind: Exclude<Kind, "transfer">, p: { perTx?: string; total?: string; hours?: string; amount?: string } = {}): Promise<Staged> {
    const s = this.ready(); const t = this.target; const f = await this.fresh(s);
    let to: string = t.registry, data: Hex, title: string; const lines: string[] = [`Contract: ${t.registry}`, `Network: ${t.name} (${t.chainId}); real funds; the Registry is NOT audited`];
    const noPrincipal = "Principal moved by this tx: none";
    if (f.registered === null) throw new Error("Registration state UNKNOWN (read failed): refusing");
    if (f.gasEth === null || f.gasEth === 0n) throw new Error("ETH gas balance unknown or zero: refusing");
    if (kind === "approveFee" || kind === "register") {
      if (f.registered) throw new Error("Already registered: no onboarding fee is needed and this will not touch your allowance");
      if (f.wif === null || f.wif < t.fee) throw new Error("WIF balance unknown or below the 1 WIF fee");
      if (kind === "approveFee") {
        if (f.allowance === null) throw new Error("Allowance unknown: refusing");
        to = t.wif; data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [t.registry as never, t.fee] }); title = "Step 1: approve exactly the 1 WIF onboarding fee";
        lines.push(`Token ${t.wif}: approve(spender=Registry, ${formatAmount(t.fee)} WIF)`, `Fee: 1 WIF is charged only by step 2 (to ${t.feeSink}); ${noPrincipal}`);
      } else {
        if (f.allowance === null || f.allowance < t.fee) throw new Error("Allowance to Registry is below the 1 WIF fee: do step 1 first");
        data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "register" }); title = "Step 2: register (pays the fee)";
        lines.push(`register(): pulls ${formatAmount(t.fee)} WIF fee -> ${t.feeSink}`, noPrincipal);
      }
    } else {
      if (f.registered !== true) throw new Error("Not registered (on-chain read): register first");
      const d = this.dec(f);
      if (kind === "setPolicy") {
        const perTx = parseAmount(p.perTx ?? "0.1", d), total = parseAmount(p.total ?? "0.2", d), secs = parseHours(p.hours ?? "1");
        if (perTx <= 0n || perTx > total) throw new Error("Caps invalid: need 0 < per-tx <= total");
        if (perTx > LIMITS.perTx || total > LIMITS.total) throw new Error(`This version limits caps to per-tx ${formatAmount(LIMITS.perTx)} / total ${formatAmount(LIMITS.total)} WIF`);
        if (secs > LIMITS.maxHours * 3600) throw new Error(`Validity max ${LIMITS.maxHours}h in this version`);
        const expiry = Math.floor(Date.now() / 1000) + secs;
        data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "setPolicy", args: [t.wif as never, perTx, total, BigInt(expiry), ZERO as never, [s.account as never]] }); title = "Set spend policy (does NOT approve any allowance)";
        lines.push(`token WIF, per-tx ${formatAmount(perTx, d)}, total ${formatAmount(total, d)}, expires in ${p.hours ?? "1"}h, recipients: ONLY your own account ${s.account}, no extra executor`, `Replaces any previous policy (spent resets). ${noPrincipal}`);
      } else if (kind === "revokePolicy") {
        data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "revoke" }); title = "Revoke policy (step 1 of 2; allowance stays until reset)";
        lines.push(noPrincipal, "Afterwards also run 'Reset allowance to 0'.");
      } else {
        if (f.allowance === null) throw new Error("Allowance unknown: refusing");
        to = t.wif;
        if (kind === "zeroAllowance") { data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [t.registry as never, 0n] }); title = "Reset allowance to 0"; lines.push(`Token ${t.wif}: approve(Registry, 0); current allowance ${formatAmount(f.allowance, d)} WIF`, noPrincipal); }
        else {
          const pol = f.policy; if (pol === "unknown" || !pol || !pol.active) throw new Error("No active on-chain policy (or unknown): set a policy first");
          if (pol.executor !== ZERO && lc(pol.executor) !== ZERO) throw new Error("Policy has an extra executor: refusing to approve");
          const amt = parseAmount(p.amount ?? "0.2", d); const remaining = pol.totalCap - pol.spent;
          if (amt <= 0n) throw new Error("Use 'Reset allowance to 0' for zero");
          if (amt > remaining) throw new Error(`Amount exceeds remaining policy cap (${formatAmount(remaining, d)})`);
          if (amt > LIMITS.total) throw new Error("Amount above this version's limit");
          data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [t.registry as never, amt] }); title = "Approve limited transfer allowance (not unlimited)";
          lines.push(`Token ${t.wif}: approve(Registry, ${formatAmount(amt, d)} WIF) — the Registry can pull at most this, and only within the policy`, `Max principal exposed: ${formatAmount(amt, d)} WIF`);
        }
      }
    }
    lines.push("Gas: " + await this.gasLine(s, to, data));
    if (!this.cur(s)) throw new Error("Wallet changed: action cancelled");
    const st: Staged = { id: ++this.sid, kind, title, lines, to, data, epoch: s.epoch };
    this.state.staged = st; this.emit(); return st;
  }
  cancelStage() { this.state.staged = null; this.emit(); }

  /** Final gate + the ONLY place a signing request is made. Checks session, accounts and chain right before eth_sendTransaction; mismatch => NotSent. */
  private async send(s: Session, to: string, data: Hex, onHash: (h: string) => void): Promise<{ hash?: string; rejected?: boolean; note?: string }> {
    if (!this.cur(s)) throw new NotSent("wallet changed");
    const [accts, id] = await Promise.all([s.rpc.accounts(), s.rpc.chainId()]);
    if (!this.cur(s) || accts[0] !== s.account || id !== this.target.chainId) throw new NotSent("account or network changed before signing: nothing was sent");
    const v = await verifyTarget(s.rpc, this.target); if (!v.ok) throw new NotSent(v.reason);
    if (!this.cur(s)) throw new NotSent("wallet changed");
    try {
      const h = (await s.eth.request({ method: "eth_sendTransaction", params: [{ from: s.account, to, data }] })) as string;
      onHash(h); return { hash: h };
    } catch (e) { const err = e as { code?: number; message?: string }; return { rejected: err.code === 4001, /* ONLY structured EIP-1193 4001 (no hash exists here); message text is display-only, never safety evidence */ note: (err.message ?? "failed").split("\n")[0] }; }
  }
  private async receipt(s: Session, hash: string): Promise<"success" | "failed" | "unknown"> {
    const end = Date.now() + this.waitMs;
    for (;;) {
      try { const r = await s.rpc.req<{ status: string } | null>("eth_getTransactionReceipt", [hash]); if (r) return r.status === "0x1" ? "success" : "failed"; } catch { /* keep polling */ }
      if (Date.now() >= end) return "unknown"; await this.sleep(this.pollMs);
    }
  }
  private exp(h: string) { return `${this.target.explorer}/tx/${h}`; }

  /** Confirm the staged non-transfer tx (one signature). */
  async confirm() {
    const st = this.state.staged; if (!st || st.kind === "transfer") throw new Error("Nothing staged"); const s = this.ready();
    if (st.epoch !== s.epoch) { this.state.staged = null; throw new Error("Staged action belongs to an old wallet session"); }
    if (this.busy) throw new Error("Busy"); this.busy = true; this.state.staged = null; this.emit();
    try {
      s.lock.begin(st.kind);
      let r; try { r = await this.send(s, st.to, st.data, (h) => s.lock.hash(h)); } catch (e) { if (e instanceof NotSent) { s.lock.clear(); throw e; } throw e; }
      if (!r.hash) { if (r.rejected) { s.lock.clear(); if (this.cur(s)) this.log(`[MAINNET] ${st.title}: wallet rejected, no transaction`); } else if (this.cur(s)) this.log(`[MAINNET] ${st.title}: wallet error without hash (${r.note}); UNRESOLVED — verify in wallet, then Check status / attested discard`); return; }
      const res = await this.receipt(s, r.hash);
      if (res !== "unknown") s.lock.clear();
      if (!this.cur(s)) return; // old account: hash stays in ITS store; UI of the new account untouched
      this.log(`[MAINNET] ${st.title}: ${res.toUpperCase()} ${this.exp(r.hash)}${res === "unknown" ? " — result unknown; no re-sign, use Check status" : ""}`);
      await this.refresh();
    } finally { this.busy = false; this.emit(); }
  }

  /** Read-only: resolve a non-transfer lock from the receipt. No hash => cannot be proven (attested discard only). */
  private async checkLock(s: Session) {
    const l = s.lock.get(); if (!l) return; if (!l.hash) { this.log("Unresolved action without a recorded hash: verify in wallet/explorer, then Discard (attested)"); return; }
    try { const r = await s.rpc.req<{ status: string } | null>("eth_getTransactionReceipt", [l.hash]); if (r) { s.lock.clear(); this.log(`[MAINNET] ${l.kind} resolved: ${r.status === "0x1" ? "SUCCESS" : "FAILED"} ${this.exp(l.hash)}`); } else this.log(`${l.kind} tx ${l.hash} not mined yet / not seen: stays locked`); }
    catch { this.log("Receipt read failed: stays locked"); }
  }
  async check() { const s = this.session; if (!s) throw new Error("No session"); await this.checkLock(s); if (s.store.locked()) await this.settle(s); if (this.cur(s)) await this.refresh(); }
  discardAttested() { const s = this.session; if (!s) return; const r = s.store.get(); if (r && !r.broken && (r.hashes?.length ?? 0) > 0) throw new Error("A request with tx hashes is only released by chain proof"); s.store.clearAll(); const l = s.lock.get(); if (l?.hash) throw new Error("An action with a tx hash is only released by its receipt"); s.lock.clear(); this.log("Discarded on user attestation"); void this.refresh(); }

  // ---- transfer (policy-gated, via PendingStore) ----
  async facts(s: Session, nonce: string | null, hashes: string[]): Promise<ChainFacts> {
    const t = this.target; const rpc = s.rpc;
    const block = await rpc.req<string>("eth_blockNumber").then((b) => BigInt(b), () => null);
    const accountCount = block === null ? null : await rpc.req<string>("eth_getTransactionCount", [s.account, "0x" + block.toString(16)]).then((c) => BigInt(c), () => null);
    const nonceUsed = block === null || nonce === null ? null : await rpc.call<boolean>(t.registry, REGISTRY_ABI as never, "used", [s.account, nonce], block).catch(() => null);
    const hf: Record<string, HashFacts> = {};
    for (const hash of hashes) {
      let receipt: HashFacts["receipt"] = null, txNonce: bigint | null = null, from: string | null = null;
      try { const r = await rpc.req<{ status: string } | null>("eth_getTransactionReceipt", [hash]); receipt = r === null ? "notfound" : r.status === "0x1" ? "success" : "reverted"; } catch { receipt = null; }
      try { const x = await rpc.req<{ nonce: string; from: string } | null>("eth_getTransactionByHash", [hash]); if (x) { txNonce = BigInt(x.nonce); from = x.from; } } catch { /* unknown stays null */ }
      hf[hash] = { receipt, txNonce, from: txNonce === null ? null : from };
    }
    return { nonceUsed, accountCount, accountOwner: s.account, block, hashes: hf };
  }
  async settle(s: Session, walletRejected = false) {
    for (const o of s.store.orphans()) { const f = await this.facts(s, o.nonce ?? null, [o.hash]); const res = resolveOrphan(o, f); if (res.kind !== "still-unknown") { s.store.removeOrphan(o.hash); if (this.cur(s)) this.log(`orphan released — ${res.why}`); } else if (this.cur(s)) this.log("ORPHAN STILL UNRESOLVED — " + res.why); }
    const r = s.store.get(); if (!r) return;
    const f = await this.facts(s, r.nonce, (r.hashes ?? []).map((h) => h.hash));
    for (const h of r.hashes ?? []) { const hx = f.hashes?.[h.hash]; if (h.txNonce === undefined && hx?.txNonce != null && hx.from) s.store.setTxNonce(h.hash, hx.txNonce, hx.from); }
    const res = resolvePending(r, f, walletRejected); const say = (m: string) => { if (this.cur(s)) this.log(m); };
    if (res.kind === "succeeded") { s.store.clear(); say(`[MAINNET] transfer SETTLED success — ${res.why}`); }
    else if (res.kind === "failed-final") { s.store.reset(); say(`[MAINNET] transfer SETTLED not executed — ${res.why}`); }
    else say("STILL UNRESOLVED — " + res.why);
  }
  async preview(text: string): Promise<string[]> {
    const s = this.ready(); const f = await this.fresh(s); const d = this.dec(f);
    if (f.registered !== true) throw new Error("Not registered (on-chain read)");
    const pol = f.policy; if (pol === "unknown") throw new Error("Policy state UNKNOWN (read failed): refusing"); if (!pol) throw new Error("No on-chain policy: set one first");
    if (pol.executor !== ZERO) throw new Error("Policy has an extra executor: refusing");
    const i = parseIntent(text, ["WIF"], d);
    const allowed = await s.rpc.call<boolean>(this.target.registry, REGISTRY_ABI as never, "isAllowed", [s.account, i.to]).catch(() => null);
    if (allowed === null) throw new Error("Recipient allowlist read failed (unknown): refusing");
    const errs = [...checkPolicy(i, { ...pol, allowlist: allowed ? [i.to] : [] }, Math.floor(Date.now() / 1000), d), ...allowanceErrors(i.amount, f.allowance, (v) => formatAmount(v, d))];
    if (f.wif !== null && f.wif < i.amount) errs.push("WIF balance below amount");
    const nonce = newNonce(); const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "execute", args: [s.account as never, nonce as never, this.target.wif as never, i.to as never, i.amount] });
    const gas = await this.gasLine(s, this.target.registry, data);
    const lines = [`Transfer ${formatAmount(i.amount, d)} WIF -> ${i.to}`, `Principal moved: ${formatAmount(i.amount, d)} WIF (real) | Fee: 0 WIF | Gas: ${gas}`, errs.length ? "BLOCKED: " + errs.join("; ") : "Within policy. Nothing is sent until you press Confirm and sign. Not autonomous."];
    if (!this.cur(s)) throw new Error("Wallet changed: cancelled");
    if (!errs.length) s.store.prepare(i, nonce, Date.now()); else if (!s.store.locked()) s.store.clear();
    this.state.staged = errs.length ? null : { id: ++this.sid, kind: "transfer", title: "Transfer", lines, to: this.target.registry, data, epoch: s.epoch, nonce }; this.emit();
    return lines;
  }
  async executeTransfer() {
    const s = this.session; if (!s || this.state.phase !== "ready") throw new Error("Signing disabled: " + (this.state.reason || this.state.phase));
    if (s.lock.get()) throw new Error("A previous transaction is unresolved");
    const rec = s.store.get(); if (!rec) throw new Error("No prepared request"); if (rec.broken) throw new Error("Stored request corrupted: execute disabled");
    if (rec.state !== "prepared") throw new Error("Request already submitted/unknown: Check status; no second signing");
    if (this.busy) throw new Error("Busy"); this.busy = true; this.state.staged = null;
    try {
      const f = await this.fresh(s); // fresh allowance/policy right before signing
      const d = this.dec(f); const i: TransferIntent = { type: "transfer", symbol: rec.symbol, amount: BigInt(rec.amount), to: rec.to };
      const pol = f.policy; if (pol === "unknown" || !pol || f.allowance === null) throw new Error("Policy/allowance unknown: refusing to sign");
      // re-read recipient allowlist on-chain right before signing (never assume the preview-time answer)
      const allowed = await s.rpc.call<boolean>(this.target.registry, REGISTRY_ABI as never, "isAllowed", [s.account, i.to]).catch(() => null);
      if (allowed === null) throw new Error("Recipient allowlist read failed (unknown): refusing to sign; retry or re-prepare");
      const errs = [...checkPolicy(i, { ...pol, allowlist: allowed === true ? [i.to] : [] }, Math.floor(Date.now() / 1000), d), ...allowanceErrors(i.amount, f.allowance, (v) => formatAmount(v, d))];
      if (f.registered !== true) errs.push("account not registered on-chain");
      if (pol.executor !== ZERO) errs.push("policy has an extra executor");
      if (errs.length) { s.store.clear(); throw new Error("BLOCKED (preview is stale and was voided; press Prepare again): " + errs.join("; ")); }
      const used = await s.rpc.call<boolean>(this.target.registry, REGISTRY_ABI as never, "used", [s.account, rec.nonce]).catch(() => null);
      if (used !== false) throw new Error("Request nonce state unknown or already used: use Check status");
      s.store.markSubmitting(); // persisted BEFORE the wallet is asked
      const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "execute", args: [s.account as never, rec.nonce as never, this.target.wif as never, i.to as never, i.amount] });
      let r; try { r = await this.send(s, this.target.registry, data, (h) => s.store.markHash(h, rec.nonce)); } // hash goes to the ORIGINAL session store
      catch (e) { if (e instanceof NotSent) s.store.reset(); throw e; }
      if (r.hash) { const res = await this.receipt(s, r.hash); if (res === "unknown") { if (this.cur(s)) this.log(`[MAINNET] transfer: result UNKNOWN ${this.exp(r.hash)}; no re-sign; Check status`); return; } }
      await this.settle(s, !!r.rejected);
      if (this.cur(s)) { if (r.rejected) this.log("[MAINNET] transfer: wallet rejected, no transaction"); else if (r.hash) this.log(`[MAINNET] transfer: ${this.exp(r.hash)}`); await this.refresh(); }
    } finally { this.busy = false; this.emit(); }
  }
}
