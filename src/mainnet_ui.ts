// DOM glue for the MAINNET card. All logic lives in MainnetController (src/mainnet.ts).
import { MAINNET, MainnetController, type Eth } from "./mainnet";
import { formatAmount } from "./core";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLButtonElement & HTMLElement;
let mn: MainnetController | null = null;

function render() {
  const c = mn; if (!c) return; const st = c.state, f = st.facts; const d = f?.decimals ?? 18; const u = (v: bigint | null) => (v === null ? "UNKNOWN (read failed)" : formatAmount(v, d));
  const ready = st.phase === "ready" && !st.locked && !!f; const reg = f?.registered;
  const eth = c.eth as Eth & { isMock?: boolean };
  let t = (eth.isMock ? "*** MOCK PROVIDER: no real wallet, no real chain, no real money ***\n" : "") + `Target (fixed, not configurable): ${MAINNET.name} ${MAINNET.chainId}\nRegistry ${MAINNET.registry}\nWIF ${MAINNET.wif}\n`;
  t += `Account: ${st.account ?? "-"}\nVerification: ${st.phase === "ready" ? "OK (chain id, code hash, wif/fee/feeSink match the pinned deployment)" : "NOT OK -> read-only, signing disabled: " + st.reason}\n`;
  if (st.locked) t += `LOCKED: ${st.locked}. No new signing; use Check status.\n`;
  if (f) {
    t += `registered: ${reg === null ? "UNKNOWN" : reg}\nGas ETH: ${f.gasEth === null ? "UNKNOWN" : formatAmount(f.gasEth)} | WIF balance: ${u(f.wif)}\nallowance: ${f.allowance === null ? "UNKNOWN (read failed)" : formatAmount(f.allowance, d) + " WIF"} (WIF -> Registry)\n`;
    const p = f.policy;
    t += p === "unknown" ? "policy: UNKNOWN (read failed)" : p === null ? "policy: none on chain" : `policy: per-tx ${formatAmount(p.perTxCap, d)}, total ${formatAmount(p.totalCap, d)}, spent ${formatAmount(p.spent, d)}, active=${p.active}, expires ${new Date(p.expiry * 1000).toISOString()}, recipients: own account only`;
  }
  $("mnStatus").textContent = t;
  const sg = st.staged; $("mnStaged").textContent = sg ? `${sg.title}\n${sg.lines.join("\n")}` : "";
  $("mnConfirm").disabled = !sg; $("mnCancel").disabled = !sg;
  $("mnConfirm").textContent = sg ? "Confirm & sign THIS tx only" : "Confirm";
  $("mnOnA").disabled = !ready || reg !== false; $("mnOnR").disabled = !ready || reg !== false;
  for (const id of ["mnPol", "mnApp", "mnRev", "mnZero", "mnPrev"]) $(id).disabled = !ready || reg !== true;
  $("mnChk").disabled = !mn || st.phase === "disconnected";
  $("mnLog").textContent = st.log.join("\n");
}
let busy = false;
const act = (f: () => Promise<unknown>) => async () => { if (!mn || busy) return; busy = true; try { await f(); } catch (e) { mn.state.log = ["ERROR: " + (e as Error).message, ...mn.state.log]; } finally { busy = false; render(); } };

export function connectMainnet(eth: Eth) {
  mn?.detach(); mn = new MainnetController(eth, window.localStorage, MAINNET, render); busy = false;
  void act(() => mn!.connect())();
}
export function leaveMainnet() { mn?.detach(); mn = null; }
export function initMainnetUI() {
  const c = () => mn!;
  $("mnOnA").onclick = act(() => c().stage("approveFee"));
  $("mnOnR").onclick = act(() => c().stage("register"));
  $("mnPol").onclick = act(() => c().stage("setPolicy", { perTx: $("mnPer").value, total: $("mnTot").value, hours: $("mnHrs").value }));
  $("mnApp").onclick = act(() => c().stage("approveSpend", { amount: $("mnAmt").value }));
  $("mnRev").onclick = act(() => c().stage("revokePolicy"));
  $("mnZero").onclick = act(() => c().stage("zeroAllowance"));
  $("mnPrev").onclick = act(() => c().preview($("mnCmd").value));
  $("mnConfirm").onclick = act(async () => { const k = c().state.staged?.kind; if (k === "transfer") await c().executeTransfer(); else await c().confirm(); });
  $("mnCancel").onclick = () => { mn?.cancelStage(); render(); };
  $("mnChk").onclick = act(() => c().check());
  $("mnDisc").onclick = act(async () => { if (window.confirm("Discard ONLY if you checked wallet AND explorer and NO transaction was sent. Discard?")) c().discardAttested(); });
}
