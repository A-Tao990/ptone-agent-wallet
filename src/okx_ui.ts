// DOM glue for "Connect OKX mobile (QR)". The SDK is imported ONLY after the user clicks (no load / no connection otherwise).
// Pairing only: no openModalAndSign, no personal_sign, no tx/approve at connect time. QR is shown only inside the SDK modal; the session URI/topic are never read or logged here.
import type { Eth } from "./mainnet";
import { OKX_CAIP, OKX_RPC, OkxEth, type OkxProviderLike } from "./okx";

const $ = (id: string) => document.getElementById(id) as HTMLElement & HTMLButtonElement;
type UiLike = { connected(): boolean; openModal(o: unknown): Promise<unknown>; closeModal(r?: unknown): void; disconnect(): Promise<void>; getUniversalProvider(): OkxProviderLike };
export const CONNECT_PARAMS = {
  namespaces: { eip155: { chains: ["eip155:1"], defaultChain: "1" } }, // required chain: ONLY to establish the session; nothing is ever signed on it
  optionalNamespaces: { eip155: { chains: [OKX_CAIP], defaultChain: "4663", rpcMap: { "4663": OKX_RPC } } },
};
let attempt = 0, inflight = 0, ui: UiLike | null = null, adapter: OkxEth | null = null, note = "";
let hooks: { enter(eth: Eth): void; log(m: string): void } | null = null;

async function render() {
  const a = adapter; $("okxBox").hidden = !a && !note;
  if (!a) { $("okxStatus").textContent = note; $("okxAdd").disabled = true; $("okxSwitch").disabled = true; return; }
  const i = await a.fullInfo(); if (a !== adapter) return;
  let t = note ? note + "\n" : "";
  if (!i.connected) t += "OKX: NOT CONNECTED (session ended or not established). Read-only, signing disabled.";
  else {
    t += `OKX session: connected\nSession chains: ${i.chains.join(", ") || "-"}\nActive chain (from SDK): ${i.defaultChain ?? "unknown"}\nSession accounts: ${i.accountsAll.join(", ") || "-"}\n`;
    t += i.has4663 ? "Session includes Robinhood 4663: yes\n" : "Session includes Robinhood 4663: NO -> read-only, signing disabled until you add it (button below) and the wallet confirms.\n";
    t += i.defaultChain === 4663 ? "Active chain is 4663. Account/chain still must pass the contract verification below before any signing." : "Wrong network for signing (active chain is not 4663). No automatic add/switch is ever performed.";
  }
  $("okxStatus").textContent = t;
  $("okxAdd").disabled = !i.connected || i.has4663; $("okxSwitch").disabled = !i.connected || !i.has4663 || i.defaultChain === 4663;
}
function drop(disconnect: boolean) {
  attempt++; const a = adapter, u = ui; adapter = null; a?.destroy();
  if (disconnect && u) { try { u.closeModal(); } catch { /* none open */ } if (a) void u.disconnect().catch(() => {}); }
  note = ""; void render();
}
/** Leaving OKX mode (Demo / other wallet / testnet): old listeners destroyed, pending connect invalidated, session closed. */
export function leaveOkx() { if (adapter || inflight) drop(true); }

export async function connectOkx(h: { enter(eth: Eth): void; log(m: string): void }) {
  hooks = h; if (inflight) return h.log("OKX connect already in progress (scan the QR or close the dialog)");
  const my = ++attempt; inflight++; note = "OKX: loading official SDK…"; $("okxBox").hidden = false; void render();
  try {
    const mod = await import("@okxconnect/ui"); if (my !== attempt) return;
    ui = (await mod.OKXUniversalConnectUI.init({ dappMetaData: { name: "PTone Agent Wallet", icon: new URL("icon.png", location.href).href }, language: "en_US", actionsConfiguration: { modals: "all", returnStrategy: "none" } } as never)) as unknown as UiLike;
    if (my !== attempt) return;
    note = "OKX: waiting for QR scan in the dialog (phone: OKX app -> scan). Nothing is signed by pairing."; void render();
    if (!ui.connected()) await ui.openModal(CONNECT_PARAMS);
    if (my !== attempt) { if (!adapter && inflight === 1) void ui.disconnect().catch(() => {}); return; } // late result after leaving/switching: never takes over the page
    if (!ui.connected()) { note = "OKX: not connected (dialog closed or rejected)."; void render(); return; }
    adapter = new OkxEth(ui.getUniversalProvider()); const a = adapter;
    for (const ev of ["accountsChanged", "chainChanged", "disconnect"]) a.on(ev, () => { void render(); });
    note = "OKX: paired. Checking chain/account…"; void render();
    h.enter(a);
  } catch (e) { if (my === attempt) { note = "OKX connect failed: " + (e as Error).message.split("\n")[0]; h.log(note); void render(); } }
  finally { inflight--; }
}
export function initOkxUI() {
  $("okxAdd").onclick = async () => { const a = adapter; if (!a) return; try { await a.addChain(); hooks?.log("OKX: add-chain request answered by wallet (no automatic switch). Re-check status."); } catch (e) { hooks?.log("OKX add chain failed: " + (e as Error).message.split("\n")[0]); } void render(); };
  $("okxSwitch").onclick = async () => { const a = adapter; if (!a) return; try { await a.switchChain(); } catch (e) { hooks?.log("OKX switch failed: " + (e as Error).message.split("\n")[0]); } void render(); };
  $("okxDisc").onclick = () => { drop(true); hooks?.log("OKX disconnected"); };
}
