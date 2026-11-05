import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { rpcCall, RpcError, runAll, exitCode, loadManifest, READ_METHODS } from "../scripts/verify_public.mjs";

const REC = JSON.parse(readFileSync(new URL("./fixtures/verify-recorded-rpc.json", import.meta.url), "utf8")); // real public chain responses
const M = loadManifest();
const make = (mut, rec = REC) => {
  const db = JSON.parse(JSON.stringify(rec)); mut?.(db);
  const calls = [];
  const call = async (_u, method, params) => { calls.push(method); const k = JSON.stringify([method, params]); if (!(k in db)) throw new RpcError("no recorded response " + k.slice(0, 80)); if (db[k] instanceof Error) throw db[k]; return db[k]; };
  return { call, calls, db };
};
const run = (mut, o = {}) => { const c = make(mut); return runAll({ rpc: "x", manifest: M, call: c.call, ...o }).then((rows) => ({ rows, code: exitCode(rows), calls: c.calls })); };
const key = (method, pred) => (db) => Object.keys(db).filter((k) => JSON.parse(k)[0] === method && pred(JSON.parse(k)[1]));
const tx = (n) => M.txs.find((t) => t.step === n).hash;
const failing = (r) => r.rows.filter((x) => x.status !== "PASS" && x.status !== "SKIP").map((x) => x.id);

describe("verify_public: read-only guarantees", () => {
  it("allow-list contains only read methods and blocks every write/sign method before any network access", async () => {
    expect([...READ_METHODS].every((m) => /^eth_(chainId|blockNumber|getTransactionByHash|getTransactionReceipt|getBlockByNumber|getCode|call)$/.test(m))).toBe(true);
    let fetched = 0; const f = async () => { fetched++; return { ok: true, json: async () => ({}) }; };
    for (const m of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "eth_signTransaction", "personal_sign", "eth_signTypedData_v4", "wallet_sendCalls", "eth_accounts", "eth_estimateGas"]) await expect(rpcCall("https://x", m, [], f)).rejects.toThrow(/BLOCKED/);
    expect(fetched).toBe(0);
  });
  it("source has no signing / wallet / key code", () => {
    const src = readFileSync(new URL("../scripts/verify_public.mjs", import.meta.url), "utf8");
    for (const bad of ["privateKeyToAccount", "createWalletClient", "signTransaction", "signMessage", "mnemonic", "spawn", "execFile", "child_process", "baw", "readFileSync(\".env"]) expect(src.includes(bad), bad).toBe(false);
  });
  it("a full run only uses allow-listed methods", async () => { const r = await run(); expect(r.calls.every((m) => READ_METHODS.has(m))).toBe(true); });
});

describe("verify_public: baseline and tamper detection (recorded real mainnet responses)", () => {
  it("baseline: everything PASS, exit 0 (local-artifact comparison is SKIP, never PASS)", async () => {
    const r = await run(); expect(failing(r)).toEqual([]); expect(r.code).toBe(0);
    expect(r.rows.filter((x) => x.status === "PASS").length).toBeGreaterThanOrEqual(27);
    expect(r.rows.find((x) => x.id.startsWith("LOCAL source")).status).toBe("SKIP");
  });
  const rcOf = (db, step) => Object.entries(db).find(([k]) => JSON.parse(k)[0] === "eth_getTransactionReceipt" && JSON.parse(k)[1][0] === tx(step))[1];
  const txOf = (db, step) => Object.entries(db).find(([k]) => JSON.parse(k)[0] === "eth_getTransactionByHash" && JSON.parse(k)[1][0] === tx(step))[1];
  const cases = {
    "receipt status failed": (db) => { rcOf(db, "06-transfer").status = "0x0"; },
    "tx from differs": (db) => { txOf(db, "06-transfer").from = "0x9999999999999999999999999999999999999999"; },
    "tx to differs": (db) => { txOf(db, "02-approve").to = "0x9999999999999999999999999999999999999999"; },
    "native value non-zero": (db) => { txOf(db, "07-revoke").value = "0x1"; },
    "calldata amount changed": (db) => { const t = txOf(db, "06-transfer"); t.input = t.input.slice(0, -4) + "ffff"; },
    "calldata recipient changed": (db) => { const t = txOf(db, "04-policy"); t.input = t.input.replace(/(fc51a000e7e0b48f271be023f494e8c46a5f660f)(?![\s\S]*fc51a000e7e0b48f271be023f494e8c46a5f660f)/, "9999999999999999999999999999999999999999"); },
    "approve spender changed": (db) => { const t = txOf(db, "05-token-approve"); t.input = t.input.replace("92ad0e8d7d48334b9f9535dd9109c8a37271f45d", "9999999999999999999999999999999999999999"); },
    "deploy initcode changed": (db) => { const t = txOf(db, "01-deploy"); t.input = t.input.slice(0, 200) + "00" + t.input.slice(202); },
    "event removed": (db) => { rcOf(db, "06-transfer").logs.pop(); },
    "extra event": (db) => { const r = rcOf(db, "07-revoke"); r.logs.push(r.logs[0]); },
    "event amount changed": (db) => { const l = rcOf(db, "06-transfer").logs[0]; l.data = "0x" + "0".repeat(63) + "1"; },
    "event emitter changed": (db) => { rcOf(db, "07-revoke").logs[0].address = "0x9999999999999999999999999999999999999999"; },
    "different tx hash returned": (db) => { txOf(db, "08-reset").hash = tx("07-revoke"); },
    "runtime code changed": (db) => { for (const k of key("eth_getCode", (p) => p[1] === "latest")(db)) db[k] = db[k].slice(0, 300) + "00" + db[k].slice(302); },
    "chain id wrong": (db) => { db[JSON.stringify(["eth_chainId", []])] = "0x1"; },
    "allowance non-zero": (db) => { for (const k of key("eth_call", (p) => p[1] === "latest" && p[0].data.startsWith("0xdd62ed3e"))(db)) db[k] = "0x" + "0".repeat(63) + "1"; },
    "policy active": (db) => { for (const k of key("eth_call", (p) => p[1] === "latest" && p[0].data.startsWith("0x" + "") && db[JSON.stringify(["eth_call", p])].length === 2 + 64 * 7)(db)) { const v = db[k]; db[k] = v.slice(0, 2 + 64 * 5) + "0".repeat(63) + "1" + v.slice(2 + 64 * 6); } },
  };
  for (const [name, mut] of Object.entries(cases)) it(`detects: ${name}`, async () => { const r = await run(mut); expect(r.code, name).toBe(1); if (name === "policy active") expect(r.rows.find((x) => x.status === "FAIL").id).toMatch(/active/); expect(r.rows.some((x) => x.status === "FAIL")).toBe(true); });
});

describe("verify_public: failed reads are never a pass", () => {
  const histTag = "0x" + M.finalBlock.toString(16);
  const hist = (db) => { for (const k of Object.keys(db)) if (JSON.parse(k)[0] === "eth_call" && JSON.parse(k)[1][1] === histTag) db[k] = new RpcError("historical state is not available"); };
  it("archive state missing => INCONCLUSIVE, exit 2, message tells to use --archive-rpc", async () => {
    const r = await run(hist); expect(r.code).toBe(2); const x = r.rows.filter((q) => q.status === "INCONCLUSIVE"); expect(x.length).toBe(1); expect(x[0].detail).toMatch(/archive-rpc.*NOT a pass/);
    expect(r.rows.filter((q) => q.status === "PASS").length).toBeGreaterThan(20);
  });
  it("--skip-historical => SKIP (not PASS), exit 0", async () => { const r = await run(hist, { skipHistorical: true }); expect(r.code).toBe(0); expect(r.rows.find((q) => q.id === "state at finalBlock").status).toBe("SKIP"); });
  it("receipt unreachable => INCONCLUSIVE not PASS", async () => { const r = await run((db) => { for (const k of key("eth_getTransactionReceipt", (p) => p[0] === tx("03-register"))(db)) db[k] = new RpcError("timeout"); }); expect(r.code).toBe(2); expect(r.rows.find((q) => q.id.startsWith("03-register")).status).toBe("INCONCLUSIVE"); });
  it("unknown tx (null result) => FAIL", async () => { const r = await run((db) => { for (const k of key("eth_getTransactionByHash", (p) => p[0] === tx("03-register"))(db)) db[k] = null; }); expect(r.code).toBe(1); });
});
