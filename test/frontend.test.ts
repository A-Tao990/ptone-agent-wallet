// MAINNET frontend logic tests against a MockEIP1193 provider (scripts/ui_mainnet_mock.mjs).
// MOCK ONLY: no real wallet, no real chain, no real money. Signatures here are fake.
import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { makeMockProvider, mockConfig } from "../scripts/ui_mainnet_mock.mjs";
import { MAINNET, MainnetController, Rpc, verifyTarget } from "../src/mainnet";
import { REGISTRY_ABI, ERC20_ABI } from "../src/chain";
import { MemoryKV } from "../src/pending";

const B = "0x" + "b2".repeat(20);
async function setup(extra: Record<string, unknown> = {}, kv = new MemoryKV()) {
  const cfg = await mockConfig(extra); const mock = makeMockProvider(cfg) as any;
  const mk = () => new MainnetController(mock, kv, MAINNET, () => {}, 300, 10);
  const mn = mk(); await mn.connect();
  return { cfg, mock, mn, kv, mk, A: cfg.accounts[0] as string };
}
const run = async (mn: MainnetController, kind: any, p?: any) => { await mn.stage(kind, p); await mn.confirm(); };
async function bootstrap(mn: MainnetController) {
  await run(mn, "approveFee"); await run(mn, "register"); await run(mn, "setPolicy"); await run(mn, "approveSpend", { amount: "0.2" });
}
const say = async (mn: MainnetController, to: string, amt = "0.1") => mn.preview(`send ${amt} WIF to ${to}`);

describe("target verification (pinned deployment)", () => {
  it("accepts the pinned deployment (code rebuilt from compiled artifact == pinned hash)", async () => {
    const { mn, mock } = await setup(); expect(mn.state.phase).toBe("ready"); expect(mock.ctl.signs).toBe(0); expect(mn.state.facts?.registered).toBe(false);
  });
  it("wrong chain => no signing, no auto switch", async () => {
    const { mn, mock } = await setup({ chainId: 1 }); expect(mn.state.phase).toBe("wrongNetwork");
    await expect(mn.stage("approveFee")).rejects.toThrow(/Signing disabled/); expect(mock.ctl.signs).toBe(0);
  });
  it("wrong code hash => read-only", async () => {
    const { mn, mock, cfg } = await setup({ code: "0x6000" }); expect(mn.state.phase).toBe("readonly"); expect(mn.state.reason).toMatch(/code hash/);
    await expect(mn.stage("register")).rejects.toThrow(); expect(mock.ctl.signs).toBe(0); expect(cfg.code).toBe("0x6000");
  });
  it("immutables mismatch (feeSink / fee) with matching code => read-only", async () => {
    for (const x of [{ feeSink: "0x" + "99".repeat(20) }, { fee: (2n * 10n ** 18n).toString() }]) {
      const { cfg, mock } = await setup(); const bad = makeMockProvider({ ...cfg, ...x }) as any;
      const v = await verifyTarget(new Rpc(bad)); expect(v.ok).toBe(false);
      expect(mock.ctl.signs).toBe(0);
    }
  });
  it("verification read failure is unknown => not ok", async () => {
    const { cfg } = await setup(); const m = makeMockProvider(cfg) as any; m.ctl.failCalls.add("wif");
    const v = await verifyTarget(new Rpc(m)); expect(v.ok).toBe(false); expect((v as any).reason).toMatch(/unknown/);
  });
});

describe("unknown state never defaults", () => {
  it("registered read failure => cannot onboard / set policy (not treated as unregistered)", async () => {
    const { mn, cfg } = await setup(); const m = makeMockProvider(cfg) as any; m.ctl.failCalls.add("registered");
    const kv = new MemoryKV(); const c = new MainnetController(m, kv, MAINNET, () => {}, 100, 10); await c.connect();
    expect(c.state.facts?.registered).toBeNull(); await expect(c.stage("approveFee")).rejects.toThrow(/UNKNOWN/); await expect(c.stage("setPolicy")).rejects.toThrow(); expect(m.ctl.signs).toBe(0); expect(mn.state.phase).toBe("ready");
  });
  it("policy read failure => unknown, preview refuses", async () => {
    const { cfg } = await setup(); const m = makeMockProvider(cfg) as any; const c = new MainnetController(m, new MemoryKV(), MAINNET, () => {}, 100, 10); await c.connect();
    await bootstrap(c); m.ctl.failCalls.add("policies"); await expect(say(c, cfg.accounts[0])).rejects.toThrow(/UNKNOWN/);
  });
});

describe("independent confirmations and allowance handling", () => {
  it("each tx is its own confirm; setPolicy does not approve; finite approve; revoke + zero are two steps", async () => {
    const { mn, mock, A } = await setup();
    await mn.stage("approveFee"); expect(mock.ctl.signs).toBe(0); await mn.confirm(); expect(mock.ctl.signs).toBe(1);
    await run(mn, "register"); expect(mock.ctl.signs).toBe(2); expect(mn.state.facts?.registered).toBe(true);
    await run(mn, "setPolicy"); expect(mock.ctl.signs).toBe(3);
    expect(mn.state.facts?.allowance).toBe(0n); // no auto approve (register consumed the fee allowance)
    const p = mn.state.facts?.policy as any; expect(p.perTxCap).toBe(10n ** 17n); expect(p.totalCap).toBe(2n * 10n ** 17n);
    await expect(mn.stage("approveSpend", { amount: "0" })).rejects.toThrow(/Reset allowance/);
    await expect(mn.stage("approveSpend", { amount: "0.3" })).rejects.toThrow(/exceeds remaining/);
    const st = await mn.stage("approveSpend", { amount: "0.2" }); const d = decodeFunctionData({ abi: ERC20_ABI, data: st.data }) as any;
    expect(d.functionName).toBe("approve"); expect(d.args[1]).toBe(2n * 10n ** 17n); await mn.confirm(); expect(mn.state.facts?.allowance).toBe(2n * 10n ** 17n);
    const lines = await say(mn, A); expect(lines.join("\n")).toMatch(/Within policy/); await mn.executeTransfer();
    expect((mn.state.facts?.policy as any).spent).toBe(10n ** 17n);
    await run(mn, "revokePolicy"); expect((mn.state.facts?.policy as any).active).toBe(false); expect(mn.state.facts?.allowance).toBe(10n ** 17n);
    const z = await mn.stage("zeroAllowance"); expect((decodeFunctionData({ abi: ERC20_ABI, data: z.data }) as any).args[1]).toBe(0n); await mn.confirm(); expect(mn.state.facts?.allowance).toBe(0n);
  });
  it("already registered => no fee approve (would overwrite allowance), no second register", async () => {
    const { mn } = await setup(); await bootstrap(mn); const before = mn.state.facts?.allowance;
    await expect(mn.stage("approveFee")).rejects.toThrow(/Already registered/); await expect(mn.stage("register")).rejects.toThrow(/Already registered/); expect(mn.state.facts?.allowance).toBe(before);
  });
  it("caps above this version's limits are refused; recipient is always own account", async () => {
    const { mn, A } = await setup(); await run(mn, "approveFee"); await run(mn, "register");
    await expect(mn.stage("setPolicy", { perTx: "5", total: "6" })).rejects.toThrow(/limits/);
    const st = await mn.stage("setPolicy"); const d = decodeFunctionData({ abi: REGISTRY_ABI, data: st.data }) as any; expect(d.args[5].map((x: string) => x.toLowerCase())).toEqual([A]); expect(d.args[4]).toBe("0x0000000000000000000000000000000000000000");
  });
  it("transfer to a non-allowlisted recipient is BLOCKED and nothing is prepared", async () => {
    const { mn, mock } = await setup(); await bootstrap(mn); const n = mock.ctl.signs;
    const lines = await say(mn, B); expect(lines.join("\n")).toMatch(/BLOCKED.*allowlist/); expect(mn.session!.store.get()).toBeNull(); expect(mock.ctl.signs).toBe(n);
  });
});

describe("rejection vs unknown", () => {
  it("wallet rejection without hash releases the lock", async () => {
    const { mn, mock } = await setup(); mock.ctl.rejectNext = true; await mn.stage("approveFee"); await mn.confirm();
    expect(mn.session!.lock.get()).toBeNull(); expect(mn.state.log[0]).toMatch(/rejected/); await mn.stage("approveFee");
  });
  it("transfer rejected (no hash) => back to prepared, same nonce; hash-less success is impossible", async () => {
    const { mn, mock, A } = await setup(); await bootstrap(mn); await say(mn, A); const nonce = mn.session!.store.get()!.nonce; mock.ctl.rejectNext = true; await mn.executeTransfer();
    const r = mn.session!.store.get()!; expect(r.state).toBe("prepared"); expect(r.nonce).toBe(nonce); expect(mock.ctl.sent.length).toBe(4);
  });
  it("unknown (never mined): locked, survives refresh/new controller, not released by switching accounts and back; released only by chain proof", async () => {
    const kv = new MemoryKV(); const { mn, mock, A, mk } = await setup({}, kv); await bootstrap(mn); await say(mn, A); mock.ctl.hold = true; await mn.executeTransfer();
    const rec = mn.session!.store.get()!; expect(rec.state).toBe("unknown"); expect(rec.hashes?.length).toBe(1);
    await expect(say(mn, A)).rejects.toThrow(/unresolved/); await expect(mn.executeTransfer()).rejects.toThrow(/submitted|unresolved/);
    mock.setAccount(B); await new Promise((r) => setTimeout(r, 50)); expect(mn.state.account).toBe(B); expect(mn.session!.store.get()).toBeNull(); // new account: nothing from A
    mock.setAccount(A); await new Promise((r) => setTimeout(r, 50)); expect(mn.session!.store.locked()).toBe(true);
    const mn2 = mk(); await mn2.connect(); expect(mn2.session!.store.locked()).toBe(true); await expect(say(mn2, A)).rejects.toThrow(/unresolved/); // "page refresh"
    mock.ctl.hold = false; mock.mineHeld(); await mn2.check(); expect(mn2.session!.store.locked()).toBe(false); expect((mn2.state.facts?.policy as any).spent).toBe(10n ** 17n);
  });
  it("unknown non-transfer tx locks further signing until receipt", async () => {
    const { mn, mock } = await setup(); mock.ctl.hold = true; await mn.stage("approveFee"); await mn.confirm();
    expect(mn.session!.lock.get()?.hash).toBeTruthy(); await expect(mn.stage("approveFee")).rejects.toThrow(/unresolved/);
    mock.ctl.hold = false; mock.mineHeld(); await mn.check(); expect(mn.session!.lock.get()).toBeNull(); await mn.stage("register");
  });
});

describe("account / chain changes (session epoch)", () => {
  it("account changed (event) after staging => staged dropped, nothing sent", async () => {
    const { mn, mock } = await setup(); await mn.stage("approveFee"); mock.setAccount(B); await new Promise((r) => setTimeout(r, 50));
    expect(mn.state.staged).toBeNull(); await expect(mn.confirm()).rejects.toThrow(); expect(mock.ctl.signs).toBe(0);
  });
  it("account changed silently (no event) before signing => NotSent, lock cleared, nothing sent", async () => {
    const { mn, mock } = await setup(); await mn.stage("approveFee"); mock.st.accounts = [B.toLowerCase()];
    await expect(mn.confirm()).rejects.toThrow(/nothing was sent/); expect(mock.ctl.signs).toBe(0); expect(mn.session!.lock.get()).toBeNull();
  });
  it("chain changed silently before signing => nothing sent; transfer returns to prepared", async () => {
    const { mn, mock, A } = await setup(); await bootstrap(mn); await say(mn, A); const n = mock.ctl.signs; mock.st.chainId = 1;
    await expect(mn.executeTransfer()).rejects.toThrow(); expect(mock.ctl.signs).toBe(n); expect(mn.session!.store.get()!.state).toBe("prepared");
  });
  it("account changes WHILE signing: hash stays in the OLD account's store; new account untouched", async () => {
    const { mn, mock, A, kv } = await setup(); await bootstrap(mn); await say(mn, A); mock.ctl.hold = true;
    mock.ctl.onSend = async () => { mock.setAccount(B); await new Promise((r) => setTimeout(r, 20)); };
    const oldStore = mn.session!.store; await mn.executeTransfer(); mock.ctl.onSend = null;
    expect(oldStore.get()!.hashes?.length).toBe(1); expect(oldStore.locked()).toBe(true);
    expect(mn.state.account).toBe(B); expect(mn.session!.store.get()).toBeNull(); expect(mn.session!.store.orphans()).toEqual([]);
    expect(mn.state.log.join("\n")).not.toMatch(/transfer: https/); // old result never shown on the new account
    expect(kv.getItem(`ptone.pending.v1:4663:${MAINNET.registry.toLowerCase()}:${B}`)).toBeNull();
    mock.setAccount(A); await new Promise((r) => setTimeout(r, 50)); expect(mn.session!.store.locked()).toBe(true); await expect(mn.stage("setPolicy")).rejects.toThrow(/unresolved/);
  });
  it("detach (switch to Demo) does not lose the real store", async () => {
    const kv = new MemoryKV(); const { mn, mock, A, mk } = await setup({}, kv); await bootstrap(mn); await say(mn, A); mock.ctl.hold = true; await mn.executeTransfer(); mn.detach();
    expect(mn.session).toBeNull(); const again = mk(); await again.connect(); expect(again.session!.store.locked()).toBe(true);
  });
});

describe("fix1: rejection classification + pre-sign allowlist re-read", () => {
  const wrapSend = (mock: any, mkErr: () => Error) => { const req = mock.request.bind(mock); mock.request = async (a: any) => { const r = await req(a); if (a.method === "eth_sendTransaction") throw mkErr(); return r; }; };
  it("post-broadcast error with 'User denied' text but no code stays locked/unknown", async () => {
    const { mn, mock, A } = await setup(); await bootstrap(mn); mock.ctl.hold = true; wrapSend(mock, () => new Error("User denied receipt delivery"));
    await say(mn, A); await mn.executeTransfer();
    expect(mn.session!.store.locked()).toBe(true); expect(mn.session!.store.get()!.state).not.toBe("prepared");
    await expect(mn.executeTransfer()).rejects.toThrow(); expect(mock.ctl.signs).toBe(5);
  });
  it("code 4001 with text mismatch is still a clean rejection (no hash); non-numeric/string code is not", async () => {
    const { mn, mock, A } = await setup(); await bootstrap(mn); mock.ctl.rejectNext = true; await say(mn, A); await mn.executeTransfer();
    expect(mn.session!.store.locked()).toBe(false);
    const b = await setup(); await bootstrap(b.mn); b.mock.ctl.hold = true; wrapSend(b.mock, () => Object.assign(new Error("denied"), { code: "4001" }));
    await say(b.mn, b.A); await b.mn.executeTransfer(); expect(b.mn.session!.store.locked()).toBe(true);
  });
  it("allowlist removed after preview => no wallet request, preview voided", async () => {
    const { mn, mock, A } = await setup(); await bootstrap(mn); await say(mn, A); for (const k of Object.keys(mock.st.allowed)) mock.st.allowed[k] = false;
    const before = mock.ctl.signs; await expect(mn.executeTransfer()).rejects.toThrow(/BLOCKED/); expect(mock.ctl.signs).toBe(before);
    expect(mn.session!.store.get()).toBeNull(); expect(mn.session!.store.locked()).toBe(false);
  });
  it("isAllowed read failure => refuse, no wallet request, record kept (not unlocked/cleared)", async () => {
    const { mn, mock, A } = await setup(); await bootstrap(mn); await say(mn, A); mock.ctl.failCalls.add("isAllowed"); const before = mock.ctl.signs;
    await expect(mn.executeTransfer()).rejects.toThrow(/unknown/); expect(mock.ctl.signs).toBe(before); expect(mn.session!.store.get()!.state).toBe("prepared");
  });
  it("unconfirmed extra-executor policy change after preview => no wallet request", async () => {
    const { mn, mock, A } = await setup(); await bootstrap(mn); await say(mn, A); mock.st.pol[A.toLowerCase()].executor = B; const before = mock.ctl.signs;
    await expect(mn.executeTransfer()).rejects.toThrow(/executor/); expect(mock.ctl.signs).toBe(before);
  });
});
