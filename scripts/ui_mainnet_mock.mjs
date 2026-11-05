#!/usr/bin/env node
// MOCK EIP-1193 provider + browser e2e for the MAINNET page. NOTHING here is a real wallet or real chain:
// all "signatures" are fake, no real money, no wallet request leaves this machine. Browser e2e uses geckodriver + a FRESH temp Firefox profile
// (never the daily browser). Usage: node scripts/ui_mainnet_mock.mjs <baseUrl> <outDir>   (needs `vite` serving baseUrl).
// The provider function is self-contained (toString()-injected into the page and imported by vitest).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Self-contained: no outer references. cfg = { chainId, accounts, code, registry, wif, feeSink, fee(dec str), sel:{selector:name}, ethBal(dec str), wifBal(dec str) } */
export function makeMockProvider(cfg) {
  const lc = (s) => s.toLowerCase(); const W = (v) => BigInt(v).toString(16).padStart(64, "0"); const A = (a) => lc(a).replace("0x", "").padStart(64, "0");
  const handlers = {}; const reg = lc(cfg.registry), wif = lc(cfg.wif);
  const st = { chainId: cfg.chainId, accounts: cfg.accounts.map(lc), block: 100n, eth: {}, bal: {}, allow: {}, registered: {}, pol: {}, allowed: {}, used: {}, txs: {}, rcpt: {}, count: {}, n: 0 };
  const ctl = { hold: false, rejectNext: false, onSend: null, failCalls: new Set(), sent: [], signs: 0 };
  const get = (o, k, d) => (o[k] === undefined ? d : o[k]);
  const ensure = (a) => { if (st.eth[a] === undefined) { st.eth[a] = BigInt(cfg.ethBal); st.bal[a] = BigInt(cfg.wifBal); } };
  const words = (data) => { const h = data.slice(10); const w = []; for (let i = 0; i < h.length; i += 64) w.push(h.slice(i, i + 64)); return w; };
  const addr = (w) => "0x" + w.slice(24); const num = (w) => BigInt("0x" + w);
  function applyTx(tx) {
    const name = cfg.sel[tx.data.slice(0, 10)]; const w = words(tx.data); const f = tx.from; ensure(f); const now = BigInt(Math.floor(Date.now() / 1000)); let ok = true;
    if (tx.to === wif && name === "approve") { st.allow[f + addr(w[0])] = num(w[1]); }
    else if (tx.to === reg && name === "register") { const al = get(st.allow, f + reg, 0n), fee = BigInt(cfg.fee); if (st.registered[f] || al < fee || st.bal[f] < fee) ok = false; else { st.registered[f] = true; st.allow[f + reg] = al - fee; st.bal[f] -= fee; } }
    else if (tx.to === reg && name === "setPolicy") {
      const off = Number(num(w[5])) / 32; const n = Number(num(w[off])); const rec = []; for (let i = 0; i < n; i++) rec.push(addr(w[off + 1 + i]));
      if (!st.registered[f] || num(w[1]) === 0n || num(w[1]) > num(w[2]) || num(w[3]) <= now) ok = false;
      else { const v = (get(st.pol, f, { v: 0 }).v) + 1; st.pol[f] = { v, token: addr(w[0]), perTx: num(w[1]), total: num(w[2]), spent: 0n, expiry: num(w[3]), active: true, executor: addr(w[4]) }; for (const r of rec) st.allowed[f + ":" + v + ":" + r] = true; }
    }
    else if (tx.to === reg && name === "revoke") { if (st.pol[f]) st.pol[f].active = false; }
    else if (tx.to === reg && name === "execute") {
      const owner = addr(w[0]), nonce = w[1], to = addr(w[3]), amt = num(w[4]), p = st.pol[owner];
      if (!p || f !== owner || !p.active || now > p.expiry || !st.allowed[owner + ":" + p.v + ":" + to] || amt === 0n || amt > p.perTx || p.spent + amt > p.total || st.used[owner + nonce] || get(st.allow, owner + reg, 0n) < amt || st.bal[owner] < amt) ok = false;
      else { st.used[owner + nonce] = true; p.spent += amt; st.allow[owner + reg] -= amt; st.bal[owner] -= amt; ensure(to); st.bal[to] += amt; }
    } else ok = false;
    return ok;
  }
  function mine(tx) { const ok = applyTx(tx); st.block += 1n; st.count[tx.from] = (st.count[tx.from] || 0) + 1; st.rcpt[tx.hash] = { transactionHash: tx.hash, status: ok ? "0x1" : "0x0", blockNumber: "0x" + st.block.toString(16), blockHash: "0x" + "ab".repeat(32), from: tx.from, to: tx.to, gasUsed: "0x5208", cumulativeGasUsed: "0x5208", logs: [], type: "0x2", transactionIndex: "0x0", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: "0x" + "0".repeat(512) }; }
  const out = {
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_chainId": return "0x" + st.chainId.toString(16);
        case "eth_accounts": return [...st.accounts];
        case "eth_requestAccounts": return [...st.accounts];
        case "eth_blockNumber": return "0x" + st.block.toString(16);
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_estimateGas": return "0x30d40";
        case "eth_getBalance": { const a = lc(params[0]); ensure(a); return "0x" + st.eth[a].toString(16); }
        case "eth_getCode": return lc(params[0]) === reg ? cfg.code : lc(params[0]) === wif ? "0x6001" : "0x";
        case "eth_getTransactionCount": { const a = lc(params[0]); return "0x" + (st.count[a] || 0).toString(16); } // pending ignored: held txs are not counted
        case "eth_getTransactionReceipt": return st.rcpt[params[0]] || null;
        case "eth_getTransactionByHash": { const t = st.txs[params[0]]; return t ? { hash: t.hash, from: t.from, to: t.to, nonce: "0x" + t.nonce.toString(16), input: t.data } : null; }
        case "eth_call": {
          const { to, data } = params[0]; const name = cfg.sel[data.slice(0, 10)]; if (ctl.failCalls.has(name)) throw new Error("mock RPC failure: " + name);
          const w = words(data); const T = lc(to);
          if (T === reg) {
            if (name === "wif") return "0x" + A(wif); if (name === "feeSink") return "0x" + A(cfg.feeSink); if (name === "onboardingFee") return "0x" + W(cfg.fee);
            if (name === "registered") return "0x" + W(st.registered[addr(w[0])] ? 1 : 0);
            if (name === "policies") { const p = st.pol[addr(w[0])]; return "0x" + (p ? A(p.token) + W(p.perTx) + W(p.total) + W(p.spent) + W(p.expiry) + W(p.active ? 1 : 0) + A(p.executor) : "0".repeat(64 * 7)); }
            if (name === "isAllowed") { const o = addr(w[0]); const p = st.pol[o]; return "0x" + W(p && st.allowed[o + ":" + p.v + ":" + addr(w[1])] ? 1 : 0); }
            if (name === "used") return "0x" + W(st.used[addr(w[0]) + w[1]] ? 1 : 0);
          } else if (T === wif) {
            if (name === "allowance") return "0x" + W(get(st.allow, addr(w[0]) + addr(w[1]), 0n)); if (name === "balanceOf") { const a = addr(w[0]); ensure(a); return "0x" + W(st.bal[a]); } if (name === "decimals") return "0x" + W(18);
          }
          throw new Error("mock: unsupported call " + name);
        }
        case "eth_sendTransaction": {
          const p = params[0]; const from = lc(p.from); ctl.signs++;
          if (from !== st.accounts[0]) { const e = new Error("unauthorized account"); e.code = 4100; throw e; }
          if (ctl.rejectNext) { ctl.rejectNext = false; const e = new Error("User rejected the request."); e.code = 4001; throw e; }
          if (ctl.onSend) await ctl.onSend(p); // user is "signing"; account/chain may change meanwhile
          const n = ++st.n; const hash = "0x" + n.toString(16).padStart(64, "0"); const tx = { hash, from, to: lc(p.to), data: p.data, nonce: (st.count[from] || 0) + (ctl.hold ? 0 : 0) };
          ensure(from); st.txs[hash] = tx; ctl.sent.push(tx); if (!ctl.hold) mine(tx); return hash;
        }
        default: throw new Error("mock: unsupported method " + method);
      }
    },
    on(e, f) { (handlers[e] = handlers[e] || []).push(f); },
    removeListener(e, f) { handlers[e] = (handlers[e] || []).filter((x) => x !== f); },
    emit(e, a) { for (const f of handlers[e] || []) f(a); },
    isMock: true, ctl, st,
    setAccount(a) { st.accounts = a ? [lc(a)] : []; out.emit("accountsChanged", [...st.accounts]); },
    setChain(id) { st.chainId = id; out.emit("chainChanged", "0x" + id.toString(16)); },
    mineHeld() { for (const t of Object.values(st.txs)) if (!st.rcpt[t.hash]) mine(t); },
  };
  return out;
}

/** Node-side helper: config with the real pinned deployment code rebuilt from the compiled artifact (immutables filled in). */
export async function mockConfig(extra = {}) {
  const require = createRequire(import.meta.url); const { toFunctionSelector, parseAbi } = await import("viem");
  const bi = require("../artifacts/build-info/98f7b8522a7a33067d2fcc87d5ecd4c7.json");
  const c = bi.output.contracts["contracts/AgentRegistry.sol"].AgentRegistry.evm.deployedBytecode;
  const wifA = "0x5173b8eA6923c2d40267890D45C46a3480954773", sink = "0xFC51A000e7E0B48f271BE023f494E8c46a5f660f";
  const vs = [wifA.slice(2).toLowerCase().padStart(64, "0"), (10n ** 18n).toString(16).padStart(64, "0"), sink.slice(2).toLowerCase().padStart(64, "0")];
  let code = c.object; Object.keys(c.immutableReferences).forEach((id, k) => { for (const r of c.immutableReferences[id]) code = code.slice(0, r.start * 2) + vs[k] + code.slice((r.start + r.length) * 2); });
  const abi = parseAbi(["function wif() view returns (address)", "function feeSink() view returns (address)", "function onboardingFee() view returns (uint256)", "function registered(address) view returns (bool)",
    "function policies(address) view returns (address,uint128,uint128,uint128,uint64,bool,address)", "function isAllowed(address,address) view returns (bool)", "function used(address,bytes32) view returns (bool)",
    "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function approve(address,uint256) returns (bool)",
    "function register()", "function setPolicy(address,uint128,uint128,uint64,address,address[])", "function revoke()", "function execute(address,bytes32,address,address,uint256)"]);
  const sel = {}; for (const f of abi) sel[toFunctionSelector(f)] = f.name;
  return { chainId: 4663, accounts: ["0x" + "a1".repeat(20)], code: "0x" + code, registry: "0x92ad0E8D7d48334b9f9535dd9109C8A37271f45D", wif: wifA, feeSink: sink, fee: (10n ** 18n).toString(), sel, ethBal: (10n ** 16n).toString(), wifBal: (5n * 10n ** 18n).toString(), ...extra };
}

// ---------------- browser e2e (only when run directly) ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base = "http://127.0.0.1:5179/", out = "logs/frontend-ui"] = process.argv.slice(2); mkdirSync(out, { recursive: true });
  const PORT = 4577; const gd = spawn("geckodriver", ["--port", String(PORT)], { stdio: "ignore" });
  const call = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json(); if (j.value?.error) throw new Error(j.value.error + ": " + j.value.message); return j.value; };
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/status`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const s = await call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { args: ["-headless"] } } } });
  const sid = s.sessionId; const WD = (m, p, b) => call(m, `/session/${sid}${p}`, b);
  const results = []; let shot = 0; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = async (id) => (await WD("POST", "/element", { using: "css selector", value: "#" + id }))["element-6066-11e4-a52e-4f735466cecf"];
  const click = async (id) => WD("POST", `/element/${await el(id)}/click`, {});
  const text = async (id) => WD("GET", `/element/${await el(id)}/text`);
  const enabled = async (id) => WD("GET", `/element/${await el(id)}/enabled`);
  const type = async (id, t) => { const e = await el(id); await WD("POST", `/element/${e}/clear`, {}); await WD("POST", `/element/${e}/value`, { text: t }); };
  const exec = (script, args = []) => WD("POST", "/execute/sync", { script, args });
  const snap = async (name) => writeFileSync(`${out}/${String(++shot).padStart(2, "0")}-${name}.png`, Buffer.from(await WD("GET", "/screenshot"), "base64"));
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: ok ? undefined : detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " :: " + String(detail).slice(0, 300)}`); };
  const cfg = await mockConfig();
  try {
    await WD("POST", "/url", { url: base });
    await exec(`window.ethereum = (${makeMockProvider.toString()})(arguments[0]);`, [cfg]);
    await snap("loaded");
    check("DEMO is default", /DEMO/.test(await text("badge")), await text("badge"));
    check("page states MAINNET needs EIP-1193 wallet, not Binance CLI wallet", /EIP-1193/.test(await text("mnPre")) && /CLI/.test(await text("mnPre")), await text("mnPre"));
    await click("bMain"); await sleep(1200);
    check("connect requires the risk checkbox (nothing happens without it)", /MAINNET/.test(await text("badge")) === false, await text("badge"));
    await click("mnAck"); await click("bMain"); await sleep(1500);
    check("mainnet badge, verified target, MOCK banner", /MAINNET/.test(await text("badge")) && /MOCK/.test(await text("mnStatus")) , await text("mnStatus"));
    check("no mUSD fake balance in mainnet", !/mUSD/.test(await text("mnStatus")), await text("mnStatus"));
    check("not registered shown from chain read", /registered: false/.test(await text("mnStatus")), await text("mnStatus"));
    await click("mnOnA"); await sleep(800); check("fee approve is STAGED, not sent", /approve exactly/i.test(await text("mnStaged")) && (await exec("return window.ethereum.ctl.signs")) === 0, await text("mnStaged")); await snap("staged-approve-fee");
    await click("mnConfirm"); await sleep(1500); check("approve fee mined (mock)", (await exec("return window.ethereum.ctl.signs")) === 1 && /SUCCESS/.test(await text("mnLog")), await text("mnLog"));
    await click("mnOnR"); await sleep(800); await click("mnConfirm"); await sleep(1500); check("registered true after step 2", /registered: true/.test(await text("mnStatus")), await text("mnStatus"));
    await click("mnPol"); await sleep(800); await click("mnConfirm"); await sleep(1500);
    const stt = await text("mnStatus"); check("policy 0.1/0.2 active, allowance still 0 (no auto approve)", /per-tx 0\.1/.test(stt) && /total 0\.2/.test(stt) && /allowance: 0 WIF/.test(stt), stt); await snap("policy");
    await click("mnApp"); await sleep(800); await click("mnConfirm"); await sleep(1500); check("limited allowance 0.2", /allowance: 0\.2 WIF/.test(await text("mnStatus")), await text("mnStatus"));
    const me = cfg.accounts[0]; await type("mnCmd", `send 0.1 WIF to ${me}`); await click("mnPrev"); await sleep(1000);
    check("transfer preview within policy, real principal wording", /Within policy/.test(await text("mnStaged")) && /real/.test(await text("mnStaged")), await text("mnStaged"));
    await click("mnConfirm"); await sleep(1500); check("transfer 0.1 mined, spent 0.1", /spent 0\.1/.test(await text("mnStatus")), await text("mnStatus")); await snap("transferred");
    // account switch mid-state: epoch invalidation drops staged UI
    await click("mnRev"); await sleep(800); check("revoke staged and policy-only wording", /Revoke policy/.test(await text("mnStaged")), await text("mnStaged"));
    await exec("window.ethereum.setAccount('0x" + "b2".repeat(20) + "')"); await sleep(1500);
    check("account change drops the staged action and reloads for the new account", (await text("mnStaged")).trim() === "" && /b2b2b2/i.test(await text("mnStatus")), await text("mnStaged") + await text("mnStatus"));
    await exec("window.ethereum.setAccount('" + me + "')"); await sleep(1500);
    check("back on the first account: its own state is shown", /spent 0\.1/.test(await text("mnStatus")), await text("mnStatus"));
    await click("mnRev"); await sleep(800); await click("mnConfirm"); await sleep(1500); await click("mnZero"); await sleep(800); await click("mnConfirm"); await sleep(1500);
    check("revoke + reset both done: active=false, allowance 0", /active=false/.test(await text("mnStatus")) && /allowance: 0 WIF/.test(await text("mnStatus")), await text("mnStatus")); await snap("revoked");
    await exec("window.ethereum.setChain(1)"); await sleep(1200);
    check("wrong chain => signing disabled, no auto-switch", /wrong network/i.test(await text("mnStatus")) && !(await enabled("mnPol")), await text("mnStatus"));
    check("every mainnet-mode signature was the MOCK (no real wallet used)", (await exec("return window.ethereum.isMock")) === true, "");
    await click("bDemo"); await sleep(500); check("switch back to Demo keeps working", /DEMO/.test(await text("badge")), await text("badge"));
    writeFileSync(`${out}/frontend-ui-result.json`, JSON.stringify({ at: new Date().toISOString(), base, note: "MOCK provider only; fresh temp Firefox profile; no real wallet/chain", results }, null, 2));
  } catch (e) { check("script error", false, String(e)); try { await snap("error"); } catch {} }
  finally { try { await WD("DELETE", ""); } catch {} gd.kill(); }
  const failed = results.filter((r) => !r.ok).length; console.log(`\n${results.length - failed}/${results.length} checks passed (MOCK)`); process.exit(failed ? 1 : 0);
}
