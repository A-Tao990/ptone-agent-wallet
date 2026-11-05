// Read-only "verify on mainnet now" panel. No wallet, no keys, no signing: plain JSON-RPC reads against the public Robinhood Chain RPC.
// It re-checks the pinned Registry and re-reads the 8 flow-A transactions to show how much WIF each one actually moved.
import { MAINNET, Rpc, verifyTarget, type Eth } from "./mainnet";
import receipts from "../evidence/mainnet-receipts.json";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (s: string) => s.toLowerCase();

export interface LogLike { address: string; topics: string[]; data: string }
export interface ReceiptLike { status?: string; blockNumber?: string; logs: LogLike[] }
export interface WifMove { from: string; to: string; amount: bigint }

/** Every ERC-20 Transfer emitted by the WIF token inside one receipt (pure; used by tests). */
export function wifTransfers(rc: ReceiptLike, wif: string = MAINNET.wif): WifMove[] {
  const out: WifMove[] = [];
  for (const l of rc.logs ?? []) {
    if (lc(l.address) !== lc(wif) || l.topics?.[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    out.push({ from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), amount: BigInt(l.data === "0x" ? "0x0" : l.data) });
  }
  return out;
}
export const totalWif = (m: WifMove[]) => m.reduce((a, x) => a + x.amount, 0n);
export function fmtWif(a: bigint): string {
  const s = a.toString().padStart(19, "0"), i = s.slice(0, -18), f = s.slice(-18).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}
export function rpcProvider(url: string, fetchImpl: typeof fetch = fetch): Eth {
  let id = 0;
  return { async request({ method, params = [] }) {
    const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!r.ok) throw new Error("rpc http " + r.status);
    const j = await r.json(); if (j.error) throw new Error(j.error.message || "rpc error"); return j.result;
  } };
}

interface Step { step: string; what: string; hash: string; url: string }
const STEPS = (receipts as unknown as { flowA_cli_8tx: Step[] }).flowA_cli_8tx;

export function initLive() {
  const btn = document.getElementById("bLive") as HTMLButtonElement | null, out = document.getElementById("liveOut");
  if (!btn || !out) return;
  btn.onclick = async () => {
    btn.disabled = true; out.textContent = "Reading Robinhood Chain mainnet (read-only)…";
    try {
      const rpc = new Rpc(rpcProvider((receipts as { rpc: string }).rpc));
      const [v, head] = await Promise.all([verifyTarget(rpc), rpc.req<string>("eth_blockNumber")]);
      const frag = document.createDocumentFragment();
      const line = (t: string, cls = "") => { const d = document.createElement("div"); d.textContent = t; if (cls) d.className = cls; frag.appendChild(d); };
      line(`Chain 4663, head block ${parseInt(head, 16)}. Pinned Registry check: ${v.ok ? "OK (code hash, WIF token, 1 WIF fee, fee sink all match)" : "FAILED — " + v.reason}`, v.ok ? "ok" : "err");
      for (const s of STEPS) {
        const rc = await rpc.req<ReceiptLike | null>("eth_getTransactionReceipt", [s.hash]);
        const d = document.createElement("div"); d.className = "row";
        const a = document.createElement("a"); a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.style.color = "#8ab4ff";
        a.textContent = `${s.step}  ${s.hash.slice(0, 10)}…`; const left = document.createElement("span"); left.appendChild(a);
        const right = document.createElement("span");
        if (!rc) { right.textContent = "not found"; right.className = "err"; }
        else { const w = totalWif(wifTransfers(rc)); right.textContent = `${rc.status === "0x1" ? "success" : "FAILED"} · ${w > 0n ? fmtWif(w) + " WIF moved" : "0 WIF moved (ETH gas only)"}`; right.className = rc.status === "0x1" ? (w > 0n ? "ok" : "") : "err"; }
        d.append(left, right); frag.appendChild(d);
      }
      line("Rows with WIF moved = the onboarding fee (once) and the agent payment itself. Policy, revoke and allowance reset move no WIF.", "warn");
      out.replaceChildren(frag);
    } catch (e) { out.textContent = "Read failed (unknown, nothing assumed): " + (e as Error).message.split("\n")[0]; }
    finally { btn.disabled = false; }
  };
}
