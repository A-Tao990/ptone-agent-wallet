import { CHAINS, TransferIntent, checkPolicy, formatAmount, newNonce, parseAmount, parseHours, parseIntent, Policy } from "./core";
import { SimulatedAdapter, type Receipt } from "./adapters";
import { ChainAdapter } from "./chain";
import { connectMainnet, initMainnetUI, leaveMainnet } from "./mainnet_ui";
import { connectOkx, initOkxUI, leaveOkx } from "./okx_ui";
import { initLive } from "./live_chain";
import { MemoryKV, PendingStore, allowanceErrors, pendingKey, resolveOrphan, resolvePending } from "./pending";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLButtonElement & HTMLElement;
const env = import.meta.env as Record<string, string>;
let FEE = parseAmount("1"), feeDec = 18, dec = 18; // dec = spend-token decimals: 18 in DEMO, read from chain decimals() in TESTNET
const TEST_SYMBOL = "mUSD"; // Testnet-only mock token
let SYMBOL = "WIF"; // DEMO mirrors mainnet: the spend token is WIF and the fee is 1 WIF
const DEMO_TO = "0x1111111111111111111111111111111111111111"; // sample recipient, DEMO only (nothing is sent anywhere in DEMO)
/** DEMO is a click-through: pre-fill a sample recipient and instruction. Leaving DEMO clears them so no sample value reaches a real network. */
function demoSamples(on: boolean) {
  const al = $("allow"), cmd = $("cmd"), sample = `send 0.1 WIF to ${DEMO_TO}`;
  if (on) { if (!al.value) al.value = DEMO_TO; if (!cmd.value) cmd.value = sample; }
  else { if (al.value === DEMO_TO) al.value = ""; if (cmd.value === sample) cmd.value = ""; }
}
function setSymbol(s: string) { SYMBOL = s; $("sym").textContent = s; $("cmd").placeholder = `send 0.1 ${s} to 0x…`; }
let mode: "DEMO" | "TESTNET" = "DEMO";
let demo = new SimulatedAdapter();
let chain: ChainAdapter | null = null;
let store = new PendingStore(new MemoryKV(), "demo"); // TESTNET: localStorage-backed, survives refresh; nonce stays locked until chain facts resolve it
let allowance: bigint | null = null;
let busy = false;
let chainPolicy: Policy | null = null;

const log = (m: string) => { $("log").textContent = m + "\n" + $("log").textContent; };
const show = (r: Receipt) => log(`[${r.simulated ? "SIMULATED" : "ONCHAIN"}] ${r.status.toUpperCase()} ${r.id}${r.explorerUrl ? " " + r.explorerUrl : ""}${r.note ? " — " + r.note : ""}`);
function setMode(m: "DEMO" | "TESTNET" | "MAINNET") {
  if (m !== "MAINNET") { leaveMainnet(); leaveOkx(); } // epoch++ : old mainnet async results dropped; the real store stays in localStorage
  $("stdCards").hidden = m === "MAINNET"; $("mnCard").hidden = m !== "MAINNET";
  if (m !== "MAINNET") mode = m; const b = $("badge"); b.className = "badge " + m; b.textContent = m === "DEMO" ? "DEMO — SIMULATED" : m === "MAINNET" ? "MAINNET — Robinhood Chain 4663 (REAL FUNDS)" : "TESTNET — Robinhood Chain 46630";
}
async function refresh() {
  if (mode === "DEMO") {
    const b = demo.balances(), p = demo.state();
    $("bal").textContent = `WIF balance (simulated): ${formatAmount(b.wif + b.token)}\nGas ETH (simulated): ${formatAmount(b.gasEth)}\n` +
      (p ? `Scope: per-tx ${formatAmount(p.perTxCap, dec)}, total ${formatAmount(p.totalCap, dec)}, spent ${formatAmount(p.spent, dec)}, active=${p.active}` : "No scope set");
  } else if (chain) {
    const g = await chain.gasEth().catch(() => null);
    chainPolicy = await chain.readPolicy().catch(() => null);
    allowance = await chain.allowance();
    $("bal").textContent = `Gas ETH balance: ${g === null ? "unknown (RPC read failed)" : formatAmount(g)}\n` + `Token allowance to Registry: ${allowance === null ? "unknown (RPC read failed)" : formatAmount(allowance, dec)} ${SYMBOL}\n` + (chainPolicy ? `On-chain scope: per-tx ${formatAmount(chainPolicy.perTxCap, dec)}, total ${formatAmount(chainPolicy.totalCap, dec)}, spent ${formatAmount(chainPolicy.spent, dec)}, active=${chainPolicy.active}` : "No on-chain scope");
  }
}
function pendLine() {
  const r = store.get(); const locked = store.locked(); const hs = r?.hashes ?? [];
  $("pend").textContent = r ? `${locked ? "LOCKED — unresolved request" : "Prepared request"}: send ${formatAmount(BigInt(r.amount), dec)} ${r.symbol} -> ${r.to}\nnonce ${r.nonce}\nstate ${r.state}${hs.length ? "\n" + hs.map((h) => "tx " + h.hash + (h.txNonce && h.from ? " (sender " + h.from.slice(0, 8) + "… nonce " + h.txNonce + ")" : " (sender/nonce unverified)")).join("\n") : " (no tx hash recorded)"}${r.broken ? "\nRECORD CORRUPTED: execute disabled. Verify in wallet/explorer, then Discard (attested)." : ""}\n` + (locked ? "No new Preview and no re-sign while unresolved: only Check status (read-only) can release it, when EVERY broadcast hash is proven unable to execute." : "") : "";
  const orph = store.orphans();
  if (orph.length) $("pend").textContent += `\nORPHAN tx hash(es) with no request record (another tab discarded it?): ${orph.map((o) => o.hash).join(", ")}\nNew Preview blocked until Check status proves them dead, or you verify in the explorer and Discard (attested).`;
  $("bChk").disabled = (!r && !orph.length) || !locked;
  // Discard: no-hash records, corrupt records and orphans only, always with explorer attestation. A record WITH hashes can only be settled by chain proof.
  $("bDisc").disabled = !locked || (!!r && !r.broken && hs.length > 0 && !orph.length);
  $("bExec").disabled = !r || !!r.broken || r.state !== "prepared" || orph.length > 0; $("bExec").textContent = r?.broken ? "Execute disabled (corrupted record)" : locked ? "Execute disabled (unresolved — no re-sign)" : "Confirm & execute (you sign)";
}
/** Settle the stored request from chain facts. Only proven outcomes clear the lock. */
async function settle(walletRejected = false) {
  const r = store.get();
  if (mode === "DEMO") { if (r) log("STILL UNRESOLVED — demo"); return; }
  for (const o of store.orphans()) {
    const f = await chain!.facts(o.nonce ?? null, [o.hash]); const hx = f.hashes?.[o.hash]; if (hx?.txNonce != null && hx.from && o.txNonce === undefined) store.setOrphanNonce(o.hash, hx.txNonce.toString(), hx.from);
    const res = resolveOrphan(o, f);
    if (res.kind !== "still-unknown") { store.removeOrphan(o.hash); log(`[ONCHAIN] orphan ${o.hash.slice(0, 10)}… released — ${res.why}`); } else log(`ORPHAN STILL UNRESOLVED — ${res.why}`);
  }
  if (!r) return;
  const f = await chain!.facts(r.nonce, (r.hashes ?? []).map((h) => h.hash));
  for (const h of r.hashes ?? []) { const hx = f.hashes?.[h.hash]; if (h.txNonce === undefined && hx?.txNonce != null && hx.from) store.setTxNonce(h.hash, hx.txNonce, hx.from); } // each hash keeps ITS OWN (sender nonce, from) pair
  const res = resolvePending(r, f, walletRejected);
  if (res.kind === "succeeded") { store.clear(); log(`[ONCHAIN] SETTLED success — ${res.why}`); }
  else if (res.kind === "failed-final") { store.reset(); log(`[ONCHAIN] SETTLED not executed — ${res.why}; the same prepared request (same nonce) may be executed again`); }
  else log(`STILL UNRESOLVED — ${res.why}`);
}
async function guard<T>(f: () => Promise<T>) { if (busy) return log("Busy: wait for the current action"); busy = true; try { await f(); } catch (e) { log("ERROR: " + (e as Error).message); } finally { busy = false; pendLine(); refresh(); } }

initMainnetUI(); initOkxUI();
$("bMain").onclick = () => {
  if (!$("mnAck").checked) return log("Tick the MAINNET risk box first (real funds, unaudited contract)");
  const eth = (window as never as { ethereum?: never }).ethereum as never as Parameters<typeof connectMainnet>[0] | undefined;
  if (!eth) return log("No injected EIP-1193 wallet found (mainnet needs a browser wallet you control)");
  leaveOkx(); setMode("MAINNET"); $("net").textContent = "Mainnet mode: verification and read-only until the pinned contract checks pass."; connectMainnet(eth);
};
$("bOkx").onclick = () => {
  if (!$("mnAck").checked) return log("Tick the MAINNET risk box first (real funds, unaudited contract)");
  void connectOkx({ log, enter: (eth) => { setMode("MAINNET"); $("net").textContent = "OKX mobile: verification and read-only until the pinned contract checks pass."; connectMainnet(eth); } });
};
$("bDemo").onclick = () => { setMode("DEMO"); setSymbol("WIF"); demoSamples(true); dec = demo.decimals; FEE = parseAmount("1"); feeDec = 18; store = new PendingStore(new MemoryKV(), "demo"); $("net").textContent = "Demo: no chain, no wallet. All receipts are simulated (ids start with demo-)."; refresh(); };
$("bTest").onclick = () => guard(async () => {
  const eth = (window as never as { ethereum?: never }).ethereum as never as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | undefined;
  if (!eth) throw new Error("No injected wallet found");
  const reg = env.VITE_REGISTRY_ADDRESS, wif = env.VITE_WIF_ADDRESS, tok = env.VITE_TOKEN_ADDRESS;
  if (!reg || !wif || !tok) throw new Error("Testnet contracts not deployed/configured (see .env.example). Staying in Demo.");
  const [acct] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const id = await ChainAdapter.chainIdOf(eth);
  if (id !== CHAINS.testnet.id) throw new Error(`Wrong network (${id}). Please switch your wallet to Robinhood Chain Testnet (46630) yourself; no auto-switch.`);
  const onchainDec = await ChainAdapter.readDecimals(tok as never); // from the token contract, never hard-coded
  if (env.VITE_TOKEN_DECIMALS && Number(env.VITE_TOKEN_DECIMALS) !== onchainDec) throw new Error(`Configured VITE_TOKEN_DECIMALS=${env.VITE_TOKEN_DECIMALS} does not match on-chain decimals()=${onchainDec}`);
  dec = onchainDec; feeDec = await ChainAdapter.readDecimals(wif as never);
  chain = new ChainAdapter(eth, { registry: reg as never, wif: wif as never, token: tok as never, tokenSymbol: TEST_SYMBOL, tokenDecimals: dec }, acct as never);
  FEE = await chain.fee();
  store = new PendingStore(window.localStorage, pendingKey(CHAINS.testnet.id, reg, acct)); // recovers any unresolved request after refresh
  if (store.locked()) { log("RECOVERED an unresolved request from storage; checking chain..."); await settle(); }
  setMode("TESTNET"); setSymbol(TEST_SYMBOL); demoSamples(false); $("net").textContent = `Connected ${acct} | ${SYMBOL} decimals (on-chain): ${dec} | fee: ${formatAmount(FEE, feeDec)} WIF`;
});
$("bOn").onclick = () => guard(async () => show(mode === "DEMO" ? await demo.onboard(FEE) : await chain!.onboard(FEE)));
$("bPol").onclick = () => guard(async () => {
  const allowlist = $("allow").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.length || allowlist.some((a) => !/^0x[0-9a-f]{40}$/.test(a))) throw new Error("Provide valid allowlist addresses");
  const secs = parseHours($("hrs").value); // throws on empty/NaN/<=0/too long: nothing is submitted
  const p = { symbol: SYMBOL, perTxCap: parseAmount($("per").value, dec), totalCap: parseAmount($("tot").value, dec), expiry: Math.floor(Date.now() / 1000) + secs, allowlist };
  if (p.perTxCap <= 0n || p.perTxCap > p.totalCap) throw new Error("Caps invalid: need 0 < per-tx <= total");
  if (mode === "DEMO") return show(await demo.setPolicy(p));
  const r = await chain!.setPolicy(p); show(r);
  if (r.status === "success") show(await chain!.approveToken(p.totalCap)); // finite allowance = total cap; Registry can never pull more
  else log("Policy not confirmed; do NOT approve until it is (check status/explorer)");
});
// Independent, finite approve: recovers "policy ok but approve failed/unknown". Amount = remaining cap, never unlimited.
$("bApp").onclick = () => guard(async () => {
  if (mode !== "TESTNET") throw new Error("Approve applies to testnet only");
  const pol = await chain!.readPolicy(); if (!pol || !pol.active) throw new Error("No active on-chain scope; set scope first");
  const remaining = pol.totalCap - pol.spent; if (remaining <= 0n) throw new Error("No remaining cap to approve");
  show(await chain!.approveToken(remaining));
});
$("bRev").onclick = () => guard(async () => { show(mode === "DEMO" ? await demo.revoke() : await chain!.revoke()); });
$("bPrev").onclick = () => guard(async () => {
  if (store.locked()) { await settle(); if (store.locked()) throw new Error("Previous request unresolved: a new Preview would create a NEW nonce and could pay twice. Use Check status."); }
  const i = parseIntent($("cmd").value, [SYMBOL], dec);
  const pol = mode === "DEMO" ? demo.state() : chainPolicy;
  if (!pol) throw new Error("Set a spend scope first");
  let eff = pol; let gas = "not estimated (simulated mode); you pay gas in ETH"; let extra: string[] = [];
  const nonce = newNonce(); // new preview = new independent request (only reachable when nothing is unresolved)
  if (mode === "TESTNET") {
    const ok = await chain!.isAllowed(i.to); // real on-chain allowlist check of the CURRENT policy version
    eff = { ...pol, allowlist: ok ? [i.to] : [] };
    extra = allowanceErrors(i.amount, await chain!.allowance(), (v) => formatAmount(v, dec));
    const g = await chain!.estimateExecute(i, nonce);
    gas = g === null ? "NOT ESTIMATED (estimate failed; may revert or RPC unavailable). You pay gas in ETH" : `~${formatAmount(g)} ETH (estimate), paid by you`;
  }
  const errs = [...checkPolicy(i, eff, Math.floor(Date.now() / 1000), dec), ...extra];
  $("prev").textContent = `Transfer ${formatAmount(i.amount, dec)} ${i.symbol} -> ${i.to}\nFee: 0 WIF (already paid) | Gas: ${gas}\n` +
    (errs.length ? "BLOCKED (preview only; the contract is the real enforcement in TESTNET): " + errs.join("; ") : "Within scope. User-confirm mode: nothing is sent until you press Confirm and sign in your wallet. Not autonomous.");
  if (!errs.length) store.prepare(i, nonce, Date.now()); else if (!store.locked()) store.clear();
});
const withTabLock = <T>(f: () => Promise<T>): Promise<T | void> => {
  const l = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!l) return f(); // no Web Locks: the in-store 'prepared'-only check still refuses a second signing attempt
  return l.request("ptone-exec", { ifAvailable: true }, async (lock) => { if (!lock) { log("Another tab is signing; wait"); return; } return f(); });
};
$("bExec").onclick = () => guard(() => withTabLock(async () => {
  const rec = store.get(); if (!rec) return;
  if (rec.broken) throw new Error("Stored request is corrupted; execute is disabled");
  const i: TransferIntent = { type: "transfer", symbol: rec.symbol, amount: BigInt(rec.amount), to: rec.to };
  $("bExec").disabled = true;
  if (rec.state !== "prepared") throw new Error("Request already submitted/unknown: use Check status; no second signing");
  store.markSubmitting(); // persisted BEFORE the wallet is asked to sign; throws if another tab already did
  if (mode === "TESTNET") store.setBaseTxCount(await chain!.pendingCount()); // evidence only
  const r = mode === "DEMO" ? await demo.execute(i, rec.nonce) : await chain!.execute(i, rec.nonce, (h) => store.markHash(h, rec.nonce)); show(r);
  if (r.status === "success") store.clear();
  else if (mode === "DEMO") store.put({ ...rec, state: "prepared" }); // simulated failures are definite
  else await settle(!!r.rejected);
}));
$("bChk").onclick = () => guard(async () => { await settle(); });
$("bDisc").onclick = () => guard(async () => {
  const r = store.get(), orph = store.orphans(); if (!r && !orph.length) return;
  if (r && !r.broken && (r.hashes?.length ?? 0) > 0 && !orph.length) return; // a record WITH hashes is settled only by chain proof
  if (!window.confirm("Discard ONLY if you checked your wallet AND the explorer and NO transaction for this request was sent (or every listed hash is proven not to have executed the transfer). A sent tx would be paid twice by a new Preview. Discard?")) return;
  store.clearAll(); log("Discarded on user attestation (record/orphans cleared)");
});
demoSamples(true); pendLine(); refresh();
initLive();
