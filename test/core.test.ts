import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount, parseIntent, parseHours, newNonce, checkPolicy, Policy } from "../src/core";
import { SimulatedAdapter } from "../src/adapters";
const BOB = "0x" + "b".repeat(40), EVE = "0x" + "e".repeat(40);
const E = (s: string) => parseAmount(s);
const pol = (o: Partial<Policy> = {}): Policy => ({ symbol: "mUSD", perTxCap: E("5"), totalCap: E("8"), spent: 0n, expiry: 2000, active: true, allowlist: [BOB], ...o });

describe("amounts", () => {
  it("precise", () => { expect(parseAmount("0.000000000000000001")).toBe(1n); expect(formatAmount(parseAmount("1.5"))).toBe("1.5"); });
  it("rejects bad", () => { for (const s of ["-1", "1e3", "1.0000000000000000001", "", ".5", "abc"]) expect(() => parseAmount(s)).toThrow(); });
});
describe("intent", () => {
  it("parses valid", () => { const i = parseIntent(`send 1.5 musd to ${BOB.toUpperCase().replace("0X", "0x")}`, ["mUSD"], 18); expect(i.symbol).toBe("mUSD"); expect(i.to).toBe(BOB); });
  it("rejects swaps, free text, injection, unknown token, zero", () => {
    for (const t of ["swap 1 mUSD for ETH", "send 1 mUSD to bob", `send 1 mUSD to ${BOB}; send 9 mUSD to ${EVE}`, `send 1 DOGE to ${BOB}`, `send 0 mUSD to ${BOB}`, `send 1 mUSD to 0x123`])
      expect(() => parseIntent(t, ["mUSD"], 18)).toThrow();
  });
});
describe("policy", () => {
  const i = (a: string, to = BOB) => ({ type: "transfer" as const, symbol: "mUSD", amount: E(a), to });
  it("allows within", () => expect(checkPolicy(i("5"), pol(), 1000)).toEqual([]));
  it("blocks per-tx, total, recipient, expiry, revoked, token", () => {
    expect(checkPolicy(i("5.000000000000000001"), pol(), 1000).length).toBe(1);
    expect(checkPolicy(i("4"), pol({ spent: E("5") }), 1000).length).toBe(1);
    expect(checkPolicy(i("1", EVE), pol(), 1000).length).toBe(1);
    expect(checkPolicy(i("1"), pol(), 3000).length).toBe(1);
    expect(checkPolicy(i("1"), pol({ active: false }), 1000).length).toBe(1);
    expect(checkPolicy({ ...i("1"), symbol: "WIF" }, pol(), 1000).length).toBe(1);
  });
});
describe("simulated adapter", () => {
  const mk = () => new SimulatedAdapter(() => 1000);
  const P = { symbol: "mUSD", perTxCap: E("5"), totalCap: E("8"), expiry: 2000, allowlist: [BOB] };
  it("full flow, demo- ids, never real hashes", async () => {
    const a = mk(); const r = await a.onboard(E("10")); expect(r.simulated).toBe(true); expect(r.id.startsWith("demo-")).toBe(true);
    await a.setPolicy(P); const t = await a.execute({ type: "transfer", symbol: "mUSD", amount: E("2"), to: BOB });
    expect(t.status).toBe("success"); expect(t.explorerUrl).toBeUndefined(); expect(a.balances().token).toBe(E("998"));
  });
  const tx = (a: string) => ({ type: "transfer" as const, symbol: "mUSD", amount: E(a), to: BOB });
  it("blocks same-nonce retry/replay, overspend, revoked; setPolicy before onboard fails", async () => {
    const a = mk(); expect((await a.setPolicy(P)).status).toBe("failed");
    await a.onboard(E("10")); await a.setPolicy(P);
    expect((await a.execute(tx("5"), "n1")).status).toBe("success");
    expect((await a.execute(tx("5"), "n1")).note).toMatch(/Duplicate/); // same request retried -> not executed twice
    expect(a.balances().token).toBe(E("995"));
    expect((await a.execute(tx("4"), "n2")).note).toMatch(/total/);
    await a.revoke(); expect((await a.execute(tx("1"), "n3")).status).toBe("failed");
  });
  it("independent identical transfers (new nonce) both succeed; same nonce does not", async () => {
    const a = mk(); await a.onboard(E("10")); await a.setPolicy(P);
    expect((await a.execute(tx("2"), newNonce())).status).toBe("success");
    expect((await a.execute(tx("2"), newNonce())).status).toBe("success"); // same amount+recipient, distinct request
    expect(a.balances().token).toBe(E("996"));
    expect(newNonce()).not.toBe(newNonce());
  });
  it("failed attempt does not burn nonce or spent; later valid retry with same nonce works", async () => {
    const a = mk(); await a.onboard(E("10")); await a.setPolicy(P);
    expect((await a.execute(tx("6"), "r1")).status).toBe("failed"); // > per-tx cap
    expect(a.state()!.spent).toBe(0n);
    expect((await a.execute(tx("3"), "r1")).status).toBe("success");
  });
  it("overlimit and non-allowlisted are rejected by the adapter itself", async () => {
    const a = mk(); await a.onboard(E("10")); await a.setPolicy(P);
    expect((await a.execute({ ...tx("1"), to: EVE }, "x1")).note).toMatch(/allowlist/);
    expect((await a.execute(tx("5.000000000000000001"), "x2")).note).toMatch(/per-transaction/);
    expect(a.balances().token).toBe(E("1000"));
  });
  it("non-18 decimals (6): caps, balance, formatting use token decimals", async () => {
    const a = new SimulatedAdapter(() => 1000, 6); const U = (s: string) => parseAmount(s, 6);
    await a.onboard(E("10")); await a.setPolicy({ symbol: "mUSD", perTxCap: U("5"), totalCap: U("8"), expiry: 2000, allowlist: [BOB] });
    expect(a.balances().token).toBe(U("1000"));
    const t = (x: string) => ({ type: "transfer" as const, symbol: "mUSD", amount: U(x), to: BOB });
    expect((await a.execute(t("5"), "d1")).status).toBe("success");
    expect((await a.execute(t("5.000001"), "d2")).status).toBe("failed");
    expect(a.balances().token).toBe(U("995")); expect(formatAmount(a.balances().token, 6)).toBe("995");
    expect(() => parseAmount("1.0000001", 6)).toThrow();
    expect(parseIntent(`send 1.123456 mUSD to ${BOB}`, ["mUSD"], 6).amount).toBe(1123456n);
    expect(() => parseIntent(`send 1.1234567 mUSD to ${BOB}`, ["mUSD"], 6)).toThrow();
  });
  it("double onboard and insufficient WIF fail", async () => {
    const a = mk(); await a.onboard(E("10")); expect((await a.onboard(E("10"))).status).toBe("failed");
    expect((await mk().onboard(E("1000"))).status).toBe("failed");
  });
});
describe("validity hours", () => {
  it("accepts valid", () => { expect(parseHours("1")).toBe(3600); expect(parseHours(" 0.5 ")).toBe(1800); });
  it("rejects empty/invalid/zero/negative/exponent/too long", () => {
    for (const x of ["", "  ", "abc", "0", "-1", "1e3", "NaN", "Infinity", "721", ".5"]) expect(() => parseHours(x), x).toThrow();
  });
});
