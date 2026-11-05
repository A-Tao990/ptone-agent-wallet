// OKX mobile wallet (official @okxconnect SDK, OKX relay, no WalletConnect projectId) as an EIP-1193 `Eth` for MainnetController.
// Safety shape: the phone is only asked for (a) the pairing session, (b) explicit user-clicked add/switch chain, (c) eth_sendTransaction of a controller-confirmed tx.
// Every read goes to the FIXED public RPC (never to the phone). No personal_sign / typed data / raw tx / arbitrary methods. Session URI/topic are never stored or logged here.
import type { Eth } from "./mainnet";

export const OKX_CHAIN_ID = 4663;
export const OKX_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const OKX_CAIP = "eip155:4663";
const READ_METHODS = new Set(["eth_call", "eth_getCode", "eth_getBalance", "eth_blockNumber", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_estimateGas", "eth_gasPrice"]);
export const ADD_CHAIN_PARAMS = { chainId: "0x1237", chainName: "Robinhood Chain Mainnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [OKX_RPC], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] };

/** Minimal surface of OKXUniversalProvider that we use (so tests can mock it). */
export interface OkxProviderLike {
  request(a: { method: string; params?: unknown }, chain?: string): Promise<unknown>;
  connected(): boolean;
  session?: { namespaces?: Record<string, { chains?: string[]; accounts?: string[] }> };
  on(e: string, f: (...a: never[]) => void): void;
  removeListener(e: string, f: (...a: never[]) => void): void;
}
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export class OkxError extends Error { constructor(readonly code: number, m: string) { super(m); } }
const SDK_EVENTS = ["session_update", "session_delete", "disconnect", "chainChanged", "accountChanged", "accountsChanged", "default_chain_changed"];
const lc = (s: string) => s.toLowerCase();

export interface OkxSessionInfo { connected: boolean; defaultChain: number | null; chains: string[]; accountsOn4663: string[]; accountsAll: string[]; has4663: boolean }

export class OkxEth implements Eth {
  isOkx = true; private ls = new Map<string, Set<(...a: never[]) => void>>(); private sdk: [string, (...a: never[]) => void][] = []; private dead = false; private rpcOk: Promise<void> | null = null; private id = 1;
  constructor(private p: OkxProviderLike, private f: Fetch = (u, i) => fetch(u, i) as never, private rpcUrl = OKX_RPC) {
    for (const ev of SDK_EVENTS) {
      const h = (() => { this.emit(ev === "session_delete" || ev === "disconnect" ? "disconnect" : ev === "chainChanged" || ev === "default_chain_changed" ? "chainChanged" : "accountsChanged"); }) as (...a: never[]) => void;
      p.on(ev, h); this.sdk.push([ev, h]);
    }
  }
  private emit(ev: string) { if (this.dead) return; for (const f of [...(this.ls.get(ev) ?? [])]) f(); }
  on(e: string, f: (...a: never[]) => void) { if (!this.ls.has(e)) this.ls.set(e, new Set()); this.ls.get(e)!.add(f); }
  removeListener(e: string, f: (...a: never[]) => void) { this.ls.get(e)?.delete(f); }
  /** Destroy: no more events to the controller, SDK listeners removed. Does NOT disconnect the SDK session (caller decides). */
  destroy() { this.dead = true; for (const [e, h] of this.sdk) this.p.removeListener(e, h); this.sdk = []; this.ls.clear(); }

  /** Fresh facts from the live SDK session (never cached / never fixed). */
  info(): OkxSessionInfo {
    if (this.dead || !this.p.connected()) return { connected: false, defaultChain: null, chains: [], accountsOn4663: [], accountsAll: [], has4663: false };
    const ns = this.p.session?.namespaces?.eip155; const chains = ns?.chains ?? []; const accts = ns?.accounts ?? [];
    const on = accts.filter((a) => a.startsWith(OKX_CAIP + ":")).map((a) => lc(a.split(":")[2] ?? ""));
    return { connected: true, defaultChain: null, chains, accountsOn4663: on, accountsAll: [...new Set(accts.map((a) => lc(a.split(":")[2] ?? "")))], has4663: on.length > 0 };
  }
  private async defaultChain(): Promise<number> { const v = await this.p.request({ method: "eth_chainId" }); const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new OkxError(-32603, "bad chain id from SDK"); return n; } // SDK returns DECIMAL
  async fullInfo(): Promise<OkxSessionInfo> { const i = this.info(); if (!i.connected) return i; return { ...i, defaultChain: await this.defaultChain().catch(() => null) }; }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const call = async (m: string, ps: unknown[]) => {
      const r = await this.f(this.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method: m, params: ps }) });
      if (!r.ok) throw new OkxError(-32603, `RPC HTTP ${r.status}`);
      const j = (await r.json()) as { result?: unknown; error?: { code?: number; message?: string } };
      if (j.error) throw new OkxError(j.error.code ?? -32603, j.error.message ?? "rpc error");
      return j.result;
    };
    this.rpcOk ??= call("eth_chainId", []).then((v) => { if (parseInt(String(v), 16) !== OKX_CHAIN_ID) throw new OkxError(-32603, "fixed RPC is not chain 4663"); });
    try { await this.rpcOk; } catch (e) { this.rpcOk = null; throw e; }
    return call(method, params);
  }

  async request(a: { method: string; params?: unknown[] }): Promise<unknown> {
    if (this.dead) throw new OkxError(4900, "OKX adapter closed");
    const { method, params } = a;
    if (READ_METHODS.has(method)) return this.rpc(method, params ?? []);
    if (method === "eth_chainId" || method === "eth_accounts" || method === "eth_requestAccounts") {
      if (!this.p.connected()) throw new OkxError(4900, "OKX session not connected");
      if (method === "eth_chainId") return "0x" + (await this.defaultChain()).toString(16);
      const r = (await this.p.request({ method: "eth_accounts" })) as string[]; // SDK returns accounts of the CURRENT default chain, local call (no phone)
      return Array.isArray(r) ? r : [];
    }
    if (method === "eth_sendTransaction") return this.send(params);
    throw new OkxError(4200, `method not supported by the OKX adapter: ${method}`);
  }

  private async send(params?: unknown[]): Promise<string> {
    if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== "object" || params[0] === null) throw new OkxError(-32602, "exactly one tx object required");
    const tx = params[0] as Record<string, unknown>;
    for (const k of Object.keys(tx)) if (!["from", "to", "data"].includes(k)) throw new OkxError(-32602, `tx field not allowed: ${k}`);
    if (typeof tx.from !== "string" || typeof tx.to !== "string" || typeof tx.data !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tx.from) || !/^0x[0-9a-fA-F]{40}$/.test(tx.to) || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) throw new OkxError(-32602, "malformed tx");
    if (!this.p.connected()) throw new OkxError(4900, "OKX session not connected");
    const i = this.info(); if (!i.has4663) throw new OkxError(4901, "session has no 4663 account: signing refused");
    const chain = await this.defaultChain(); if (chain !== OKX_CHAIN_ID) throw new OkxError(4901, `active chain is ${chain}, not 4663: signing refused`);
    if (!i.accountsOn4663.includes(lc(tx.from))) throw new OkxError(4100, "from is not an account of the OKX session on 4663");
    const fresh = this.info(); if (!fresh.connected || !fresh.accountsOn4663.includes(lc(tx.from))) throw new OkxError(4900, "session changed");
    // Explicit chain argument => SDK signs on eip155:4663 only. Rejection codes are NOT translated (300 stays 300): the controller then treats it as UNRESOLVED (fail-closed).
    return (await this.p.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data }] }, OKX_CAIP)) as string;
  }

  /** Explicit user-click only. Adds Robinhood 4663 to the wallet (official rpc / explorer), requested on the default (connected) chain. */
  async addChain(): Promise<void> {
    if (this.dead || !this.p.connected()) throw new OkxError(4900, "OKX session not connected");
    const i = this.info(); const on = i.chains.find((c) => !c.endsWith(":4663")) ?? i.chains[0]; if (!on) throw new OkxError(4900, "no chain in session");
    await this.p.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN_PARAMS] }, on);
  }
  /** Explicit user-click only. SDK switches locally if 4663 is in the session, else asks the wallet. */
  async switchChain(): Promise<void> {
    if (this.dead || !this.p.connected()) throw new OkxError(4900, "OKX session not connected");
    if (!this.info().has4663) throw new OkxError(4901, "4663 is not in the session accounts: add it first");
    await this.p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ADD_CHAIN_PARAMS.chainId }] }, OKX_CAIP);
  }
}
