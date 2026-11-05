// OKX mobile adapter tests. MOCK SDK + mock chain only: no real wallet, no relay, no phone, no signature, no money.
import { describe, expect, it } from "vitest";
import { makeMockProvider, mockConfig } from "../scripts/ui_mainnet_mock.mjs";
import { MAINNET, MainnetController } from "../src/mainnet";
import { MemoryKV } from "../src/pending";
import { OkxEth, OKX_RPC, type OkxProviderLike } from "../src/okx";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
class FakePhone implements OkxProviderLike {
  reqs: { method: string; chain?: string; params?: unknown }[] = []; handlers = new Map<string, Set<(...a: never[]) => void>>();
  up = true; def = 4663; accts: string[]; chains: string[]; sendErr: unknown = null; chainMock: any;
  constructor(chainMock: any, chains = ["eip155:1", "eip155:4663"], accts = [`eip155:1:${A}`, `eip155:4663:${A}`]) { this.chainMock = chainMock; this.chains = chains; this.accts = accts; }
  get session() { return { namespaces: { eip155: { chains: this.chains, accounts: this.accts } } }; }
  connected() { return this.up; }
  on(e: string, f: (...a: never[]) => void) { if (!this.handlers.has(e)) this.handlers.set(e, new Set()); this.handlers.get(e)!.add(f); }
  removeListener(e: string, f: (...a: never[]) => void) { this.handlers.get(e)?.delete(f); }
  fire(e: string) { for (const f of [...(this.handlers.get(e) ?? [])]) f(); }
  nHandlers() { let n = 0; for (const s of this.handlers.values()) n += s.size; return n; }
  async request(a: { method: string; params?: unknown }, chain?: string) {
    this.reqs.push({ method: a.method, chain, params: a.params });
    if (!this.up) throw new Error("not connected");
    switch (a.method) {
      case "eth_chainId": return this.def;
      case "eth_accounts": return [...new Set(this.accts.filter((x) => x.split(":")[1] === String(this.def)).map((x) => x.split(":")[2]))];
      case "eth_sendTransaction": if (this.sendErr) throw this.sendErr; return this.chainMock.request({ method: "eth_sendTransaction", params: a.params });
      case "wallet_addEthereumChain": return null;
      default: throw new Error("phone cannot do " + a.method);
    }
  }
  methods() { return this.reqs.map((r) => r.method); }
}
async function setup(mut?: (p: FakePhone) => void, extra: Record<string, unknown> = {}) {
  const cfg = await mockConfig(extra); const mock = makeMockProvider(cfg) as any; const phone = new FakePhone(mock); mut?.(phone);
  const reads: string[] = [];
  const fetchFn = async (url: string, init: { body: string }) => {
    const j = JSON.parse(init.body); reads.push(j.method + "@" + url);
    if (j.method === "eth_chainId") return { ok: true, status: 200, json: async () => ({ result: "0x1237" }) };
    try { return { ok: true, status: 200, json: async () => ({ result: await mock.request({ method: j.method, params: j.params }) }) }; }
    catch (e) { return { ok: true, status: 200, json: async () => ({ error: { code: -32000, message: (e as Error).message } }) }; }
  };
  const eth = new OkxEth(phone, fetchFn as never);
  const mn = new MainnetController(eth, new MemoryKV(), MAINNET, () => {}, 300, 10);
  return { cfg, mock, phone, eth, mn, reads, fetchFn };
}
const run = async (mn: MainnetController, kind: any, p?: any) => { await mn.stage(kind, p); await mn.confirm(); };

describe("OKX adapter: connect + reads", () => {
  it("connect/verify sends NO signing request; reads go to the fixed RPC, never to the phone", async () => {
    const { mn, phone, reads } = await setup(); await mn.connect();
    expect(mn.state.phase).toBe("ready"); expect(mn.state.account).toBe(A);
    expect(new Set(phone.methods())).toEqual(new Set(["eth_chainId", "eth_accounts"]));
    expect(phone.reqs.every((r) => !/send|sign|wallet_/.test(r.method))).toBe(true);
    expect(reads.length).toBeGreaterThan(5); expect(reads.every((r) => r.endsWith("@" + OKX_RPC))).toBe(true);
  });
  it("chain/accounts come from the live SDK state, not constants", async () => {
    const { eth, phone } = await setup(); expect(await eth.request({ method: "eth_chainId" })).toBe("0x1237");
    phone.def = 1; expect(await eth.request({ method: "eth_chainId" })).toBe("0x1"); phone.accts = [`eip155:1:${B}`]; expect(await eth.request({ method: "eth_accounts" })).toEqual([B]);
  });
  it("fixed RPC answering a different chain id is refused", async () => {
    const { phone } = await setup(); const e = new OkxEth(phone, (async () => ({ ok: true, status: 200, json: async () => ({ result: "0x1" }) })) as never);
    await expect(e.request({ method: "eth_blockNumber" })).rejects.toThrow(/not chain 4663/);
  });
});

describe("OKX adapter: session without 4663 / wrong network", () => {
  it("session only has chain 1 => wrongNetwork, signing disabled, nothing reaches the phone, adapter refuses too", async () => {
    const { mn, phone, eth } = await setup((p) => { p.def = 1; p.chains = ["eip155:1"]; p.accts = [`eip155:1:${A}`]; }); await mn.connect();
    expect(mn.state.phase).toBe("wrongNetwork"); await expect(mn.stage("approveFee")).rejects.toThrow(/Signing disabled/);
    await expect(eth.request({ method: "eth_sendTransaction", params: [{ from: A, to: B, data: "0x" }] })).rejects.toMatchObject({ code: 4901 });
    expect(phone.methods().includes("eth_sendTransaction")).toBe(false);
  });
  it("4663 in session but active chain is 1 => adapter refuses to sign on chain 1", async () => {
    const { eth, phone } = await setup((p) => { p.def = 1; });
    await expect(eth.request({ method: "eth_sendTransaction", params: [{ from: A, to: B, data: "0x" }] })).rejects.toMatchObject({ code: 4901 });
    expect(phone.methods().includes("eth_sendTransaction")).toBe(false);
  });
  it("add/switch are explicit methods only: never triggered by connect; add goes to the connected default chain; switch refused without 4663", async () => {
    const { mn, phone, eth } = await setup((p) => { p.def = 1; p.chains = ["eip155:1"]; p.accts = [`eip155:1:${A}`]; }); await mn.connect();
    expect(phone.methods().some((m) => m.startsWith("wallet_"))).toBe(false);
    await expect(eth.switchChain()).rejects.toMatchObject({ code: 4901 });
    await eth.addChain(); const r = phone.reqs.find((x) => x.method === "wallet_addEthereumChain")!;
    expect(r.chain).toBe("eip155:1"); expect(JSON.stringify(r.params)).toContain("0x1237"); expect(JSON.stringify(r.params)).toContain(OKX_RPC);
  });
  it("generic request() can never reach wallet_add/switch", async () => {
    const { eth, phone } = await setup(); for (const m of ["wallet_addEthereumChain", "wallet_switchEthereumChain"]) await expect(eth.request({ method: m, params: [{}] })).rejects.toMatchObject({ code: 4200 });
    expect(phone.reqs.length).toBe(0);
  });
});

describe("OKX adapter: method whitelist and tx gate", () => {
  it("unknown / signing / raw methods rejected without reaching the phone", async () => {
    const { eth, phone } = await setup();
    for (const m of ["personal_sign", "eth_signTypedData_v4", "eth_sign", "eth_sendRawTransaction", "eth_signTransaction", "wallet_watchAsset", "eth_subscribe", "foo"]) await expect(eth.request({ method: m, params: [] })).rejects.toMatchObject({ code: 4200 });
    expect(phone.reqs.length).toBe(0);
  });
  it("tx shape: extra fields, bad address, from outside the session => refused, phone untouched", async () => {
    const { eth, phone } = await setup();
    for (const tx of [{ from: A, to: B, data: "0x", value: "0x1" }, { from: A, to: B, data: "0x", gas: "0x1" }, { from: A, to: "0x12", data: "0x" }, { from: A, to: B, data: "0xzz" }]) await expect(eth.request({ method: "eth_sendTransaction", params: [tx] })).rejects.toMatchObject({ code: -32602 });
    await expect(eth.request({ method: "eth_sendTransaction", params: [{ from: B, to: A, data: "0x" }] })).rejects.toMatchObject({ code: 4100 });
    expect(phone.methods().includes("eth_sendTransaction")).toBe(false);
  });
  it("confirmed tx is sent explicitly on eip155:4663 with only from/to/data", async () => {
    const { mn, phone } = await setup(); await mn.connect(); await run(mn, "approveFee");
    const s = phone.reqs.filter((r) => r.method === "eth_sendTransaction"); expect(s.length).toBe(1); expect(s[0].chain).toBe("eip155:4663");
    expect(Object.keys((s[0].params as any[])[0]).sort()).toEqual(["data", "from", "to"]);
  });
});

describe("OKX adapter: session lifecycle", () => {
  it("session_update with a new account invalidates the epoch, drops staged, re-binds to the new account", async () => {
    const { mn, phone } = await setup(); await mn.connect(); await mn.stage("approveFee"); expect(mn.state.staged).not.toBeNull(); const e0 = mn.epoch;
    phone.accts = [`eip155:1:${B}`, `eip155:4663:${B}`]; phone.fire("session_update"); await new Promise((r) => setTimeout(r, 30));
    expect(mn.epoch).toBeGreaterThan(e0); expect(mn.state.staged).toBeNull(); expect(mn.state.account).toBe(B);
  });
  it("session_delete => disconnected, signing disabled, no phone sign", async () => {
    const { mn, phone, eth } = await setup(); await mn.connect(); await mn.stage("approveFee"); phone.up = false; phone.fire("session_delete"); await new Promise((r) => setTimeout(r, 30));
    expect(mn.state.staged).toBeNull(); await expect(mn.confirm()).rejects.toThrow(); await expect(mn.stage("approveFee")).rejects.toThrow();
    await expect(eth.request({ method: "eth_sendTransaction", params: [{ from: A, to: B, data: "0x" }] })).rejects.toMatchObject({ code: 4900 });
    expect(phone.methods().includes("eth_sendTransaction")).toBe(false);
  });
  it("chain switched on the phone side before confirm => nothing is sent", async () => {
    const { mn, phone } = await setup(); await mn.connect(); await mn.stage("approveFee"); phone.def = 1; // silent, no event
    await expect(mn.confirm()).rejects.toThrow(/nothing was sent/); expect(phone.methods().includes("eth_sendTransaction")).toBe(false);
  });
  it("destroy (switch to Demo / leave): SDK listeners removed, later events ignored, requests refused", async () => {
    const { mn, phone, eth } = await setup(); await mn.connect(); const e0 = mn.epoch; expect(phone.nHandlers()).toBeGreaterThan(0);
    mn.detach(); eth.destroy(); expect(phone.nHandlers()).toBe(0); const e1 = mn.epoch; phone.fire("session_update"); await new Promise((r) => setTimeout(r, 20));
    expect(mn.epoch).toBe(e1); expect(e1).toBeGreaterThan(e0); await expect(eth.request({ method: "eth_chainId" })).rejects.toMatchObject({ code: 4900 }); expect(eth.info().connected).toBe(false);
  });
});

describe("OKX adapter: rejection classification (fail-closed)", () => {
  it("SDK code 300 is NOT translated to 4001: the lock stays (UNRESOLVED)", async () => {
    const { mn, phone } = await setup(); await mn.connect(); phone.sendErr = Object.assign(new Error("User rejects, 4001"), { code: 300 });
    await mn.stage("approveFee"); await mn.confirm(); expect((mn.session as any).lock.get()).not.toBeNull(); expect(mn.state.log[0]).toMatch(/UNRESOLVED/);
    await expect(mn.stage("approveFee")).rejects.toThrow(/unresolved/);
  });
  it("text-only 'rejected' without a code also stays locked", async () => {
    const { mn, phone } = await setup(); await mn.connect(); phone.sendErr = new Error("user rejected the request");
    await mn.stage("approveFee"); await mn.confirm(); expect((mn.session as any).lock.get()).not.toBeNull();
  });
});
