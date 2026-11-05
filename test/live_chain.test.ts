import { describe, it, expect } from "vitest";
import { fmtWif, rpcProvider, totalWif, wifTransfers } from "../src/live_chain";
import { MAINNET } from "../src/mainnet";

const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => "0x" + "0".repeat(24) + a.replace("0x", "").toLowerCase();
const amt = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);

describe("live chain panel (pure parts)", () => {
  it("sums only WIF Transfer logs", () => {
    const rc = { logs: [
      { address: MAINNET.wif, topics: [T, pad(A), pad(B)], data: amt(10n ** 17n) },
      { address: "0x" + "c".repeat(40), topics: [T, pad(A), pad(B)], data: amt(5n * 10n ** 18n) },       // other token: ignored
      { address: MAINNET.wif, topics: ["0x" + "1".repeat(64), pad(A), pad(B)], data: amt(7n) },          // not a Transfer: ignored
    ] };
    const m = wifTransfers(rc);
    expect(m).toHaveLength(1); expect(totalWif(m)).toBe(10n ** 17n); expect(fmtWif(totalWif(m))).toBe("0.1");
    expect(m[0].from).toBe(A); expect(m[0].to).toBe(B);
  });
  it("policy/revoke/approve-style receipts move 0 WIF", () => { expect(totalWif(wifTransfers({ logs: [] }))).toBe(0n); });
  it("formats amounts exactly", () => { expect(fmtWif(10n ** 18n)).toBe("1"); expect(fmtWif(1n)).toBe("0.000000000000000001"); expect(fmtWif(0n)).toBe("0"); });
  it("rpc provider surfaces RPC errors and http errors", async () => {
    const bad = rpcProvider("http://x", (async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 200 })) as typeof fetch);
    await expect(bad.request({ method: "eth_blockNumber" })).rejects.toThrow("boom");
    const http = rpcProvider("http://x", (async () => new Response("no", { status: 500 })) as typeof fetch);
    await expect(http.request({ method: "eth_blockNumber" })).rejects.toThrow("500");
    const ok = rpcProvider("http://x", (async () => new Response(JSON.stringify({ result: "0x1" }), { status: 200 })) as typeof fetch);
    await expect(ok.request({ method: "eth_blockNumber" })).resolves.toBe("0x1");
  });
});
