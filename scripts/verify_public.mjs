#!/usr/bin/env node
// THIRD-PARTY READ-ONLY VERIFIER for the 2026-11-05 Robinhood Chain (4663) PTone Agent Registry self-test.
// Needs: node + `npm install` (viem is used ONLY for pure ABI encode/decode/hash helpers). No wallet CLI, no key, no login, no gas.
// Safety: all network access goes through rpcCall() below, which allow-lists READ methods. Any other method (eth_sendTransaction,
// eth_sendRawTransaction, eth_sign*, personal_*, ...) throws before a request is made. No wallet/signing code is imported.
// Result semantics: PASS / FAIL / INCONCLUSIVE (a failed read, e.g. no archive state, is NEVER a pass) / SKIP (not run, not a pass).
// Exit code: 0 = every executed check PASS (and none INCONCLUSIVE); 1 = at least one FAIL; 2 = no FAIL but at least one INCONCLUSIVE.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeFunctionData, decodeEventLog, encodeFunctionData, encodeAbiParameters, getContractAddress, getAddress, keccak256, parseAbi, stringToHex, decodeFunctionResult } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const READ_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getCode", "eth_call"]);

export class RpcError extends Error {}
let rpcId = 1;
export async function rpcCall(url, method, params, fetchImpl = fetch) {
  if (!READ_METHODS.has(method)) throw new Error(`BLOCKED: JSON-RPC method "${method}" is not on the read-only allow-list`);
  let res;
  try { res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }), signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new RpcError(`RPC request failed (${method}): ${e.message}`); }
  if (!res.ok) throw new RpcError(`RPC HTTP ${res.status} (${method})`);
  let j; try { j = await res.json(); } catch { throw new RpcError(`RPC returned non-JSON (${method})`); }
  if (j.error) throw new RpcError(`RPC error (${method}): ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

class Fail extends Error {}
const must = (c, m) => { if (!c) throw new Fail(m); };
const eqAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const lc = (s) => String(s).toLowerCase();

const REG_ABI = parseAbi([
  "function register()", "function revoke()",
  "function setPolicy(address token,uint128 perTxCap,uint128 totalCap,uint64 expiry,address executor,address[] recipients)",
  "function execute(address owner,bytes32 nonce,address token,address to,uint256 amount)",
  "function wif() view returns (address)", "function onboardingFee() view returns (uint256)", "function feeSink() view returns (address)",
  "function registered(address) view returns (bool)", "function used(address,bytes32) view returns (bool)",
  "function policies(address) view returns (address token,uint128 perTxCap,uint128 totalCap,uint128 spent,uint64 expiry,bool active,address executor)",
  "event Registered(address indexed owner, uint256 fee)",
  "event PolicySet(address indexed owner, uint256 version, address token, uint128 perTxCap, uint128 totalCap, uint64 expiry, address executor)",
  "event RecipientSet(address indexed owner, uint256 version, address indexed to, bool ok)",
  "event Revoked(address indexed owner)",
  "event Executed(address indexed owner, bytes32 indexed nonce, address indexed to, address token, uint256 amount, uint128 spentTotal)",
]);
const ERC_ABI = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)", "event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

export function loadManifest(path = resolve(ROOT, "config/public-verify-manifest.json")) { return JSON.parse(readFileSync(path, "utf8")); }
const mask = (hex, refs) => { const b = Buffer.from(hex.slice(2), "hex"); for (const r of refs) b.fill(0, r.start, r.start + r.length); return "0x" + b.toString("hex"); };

/** Decode a log against an ABI; returns {eventName,args} or null when it does not decode. */
function dec(abi, log) { try { return decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { return null; } }

/** What each step must contain. `logs` is the EXACT ordered list of events the receipt must hold. */
function stepSpecs(m) {
  const { registry: R, owner: O, wif: W } = m, fee = BigInt(m.onboardingFeeRaw), per = BigInt(m.policy.perTxRaw), tot = BigInt(m.policy.totalRaw), amt = BigInt(m.transferRaw);
  const T = (from, to, v) => ({ addr: W, abi: ERC_ABI, name: "Transfer", args: { from, to, value: v } });
  const A = (o, s, v) => ({ addr: W, abi: ERC_ABI, name: "Approval", args: { owner: o, spender: s, value: v } });
  return {
    "01-deploy": { to: m.factory, check: "deploy", logs: [] },
    "02-approve": { to: W, fn: "approve", abi: ERC_ABI, args: [R, fee], logs: [A(O, R, fee)] },
    "03-register": { to: R, fn: "register", abi: REG_ABI, args: [], logs: [T(O, m.feeSink, fee), { addr: R, abi: REG_ABI, name: "Registered", args: { owner: O, fee } }] },
    "04-policy": { to: R, fn: "setPolicy", abi: REG_ABI, args: [W, per, tot, "EXPIRY", ZERO, m.policy.recipients], logs: [{ addr: R, abi: REG_ABI, name: "PolicySet", args: { owner: O, token: W, perTxCap: per, totalCap: tot, executor: ZERO, expiry: "EXPIRY" } }, { addr: R, abi: REG_ABI, name: "RecipientSet", args: { owner: O, to: m.policy.recipients[0], ok: true } }] },
    "05-token-approve": { to: W, fn: "approve", abi: ERC_ABI, args: [R, tot], logs: [A(O, R, tot)] },
    "06-transfer": { to: R, fn: "execute", abi: REG_ABI, args: [O, m.requestNonce, W, m.policy.recipients[0], amt], logs: [T(O, m.policy.recipients[0], amt), { addr: R, abi: REG_ABI, name: "Executed", args: { owner: O, nonce: m.requestNonce, to: m.policy.recipients[0], token: W, amount: amt, spentTotal: amt } }] },
    "07-revoke": { to: R, fn: "revoke", abi: REG_ABI, args: [], logs: [{ addr: R, abi: REG_ABI, name: "Revoked", args: { owner: O } }] },
    "08-reset": { to: W, fn: "approve", abi: ERC_ABI, args: [R, 0n], logs: [A(O, R, 0n)] },
  };
}

const sameVal = (a, b) => (typeof a === "string" && /^0x[0-9a-fA-F]*$/.test(a) ? lc(a) === lc(b) : a === b);

/** Verify one tx: receipt success, chain, from/to/value, input decodes to the expected call, exact event list. Returns {block, feeWei}. */
export async function verifyTx(rpc, m, step, hash, spec, call = rpcCall) {
  const [tx, rc] = await Promise.all([call(rpc, "eth_getTransactionByHash", [hash]), call(rpc, "eth_getTransactionReceipt", [hash])]);
  must(tx && rc, `tx or receipt not found for ${hash}`);
  must(lc(tx.hash) === lc(hash) && lc(rc.transactionHash) === lc(hash), "returned tx/receipt hash differs from the requested hash");
  must(rc.status === "0x1", `receipt status is ${rc.status}, expected success (0x1)`);
  if (tx.chainId !== undefined) must(BigInt(tx.chainId) === BigInt(m.chainId), `tx.chainId ${tx.chainId} != ${m.chainId}`);
  must(eqAddr(tx.from, m.owner), `from ${tx.from} != owner`);
  must(eqAddr(tx.to, spec.to), `to ${tx.to} != expected ${spec.to}`);
  must(BigInt(tx.value) === 0n, "native value must be 0");
  must(lc(tx.blockHash) === lc(rc.blockHash) && tx.blockNumber === rc.blockNumber, "tx and receipt are in different blocks");
  let expiry = null;
  if (spec.check === "deploy") {
    const salt = keccak256(stringToHex(m.salt));
    must(lc(tx.input).startsWith(lc(salt)), "deploy input does not start with the pinned salt keccak(" + m.salt + ")");
    const init = "0x" + tx.input.slice(2 + 64);
    must(keccak256(init) === lc(m.initcodeHash), `initcode hash ${keccak256(init)} != pinned ${m.initcodeHash}`);
    const args = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [m.wif, BigInt(m.onboardingFeeRaw), m.feeSink]);
    must(lc(init).endsWith(lc(args.slice(2))), "initcode constructor args are not (wif, fee, feeSink) from the manifest");
    must(getContractAddress({ opcode: "CREATE2", from: m.factory, salt, bytecode: init }) === getAddress(m.registry), "CREATE2 address of this initcode != registry");
  } else {
    let d; try { d = decodeFunctionData({ abi: spec.abi, data: tx.input }); } catch { throw new Fail("input does not decode against the expected ABI"); }
    must(d.functionName === spec.fn, `function ${d.functionName} != expected ${spec.fn}`);
    const dargs = d.args ?? [];
    must(dargs.length === spec.args.length, "argument count differs");
    const blk = await call(rpc, "eth_getBlockByNumber", [tx.blockNumber, false]);
    const ts = BigInt(blk.timestamp);
    spec.args.forEach((want, i) => {
      if (want === "EXPIRY") { // expiry = block time + ~1h (policy duration chosen at signing time)
        expiry = dargs[i]; const lo = ts, hi = ts + BigInt(m.policy.durationSeconds + m.policy.durationToleranceSeconds);
        must(expiry > lo && expiry <= hi, `policy expiry ${expiry} not within (${lo}, ${hi}]`); return;
      }
      const got = dargs[i];
      if (Array.isArray(want)) must(Array.isArray(got) && got.length === want.length && want.every((w, k) => eqAddr(w, got[k])), `argument ${i} (list) differs`);
      else must(sameVal(got, want) || (typeof want === "string" && eqAddr(got, want)), `argument ${i}: ${got} != ${want}`);
    });
  }
  must(rc.logs.length === spec.logs.length, `receipt has ${rc.logs.length} logs, expected exactly ${spec.logs.length}`);
  spec.logs.forEach((w, i) => {
    const l = rc.logs[i]; must(eqAddr(l.address, w.addr), `log ${i} emitted by ${l.address}, expected ${w.addr}`);
    const e = dec(w.abi, l); must(e && e.eventName === w.name, `log ${i} is not ${w.name}`);
    for (const [k, v] of Object.entries(w.args)) { const want = v === "EXPIRY" ? expiry : v; must(typeof want === "bigint" || typeof want === "boolean" ? e.args[k] === want : eqAddr(e.args[k], want) || lc(e.args[k]) === lc(want), `${w.name}.${k}: ${e.args[k]} != ${want}`); }
  });
  return { block: BigInt(tx.blockNumber), feeWei: BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice) };
}

const enc = (fn, args, abi = REG_ABI) => encodeFunctionData({ abi, functionName: fn, args });
async function ethCall(rpc, to, abi, fn, args, tag, call) {
  const out = await call(rpc, "eth_call", [{ to, data: enc(fn, args, abi) }, tag]);
  return decodeFunctionResult({ abi, functionName: fn, data: out });
}

/** Final-state checks at a block tag ("latest" or a hex block). Returns array of {id,status,detail}. */
export async function stateChecks(rpc, m, tag, call = rpcCall) {
  const R = m.registry, O = m.owner;
  const [registered, pol, nonceUsed, allow] = await Promise.all([
    ethCall(rpc, R, REG_ABI, "registered", [O], tag, call), ethCall(rpc, R, REG_ABI, "policies", [O], tag, call),
    ethCall(rpc, R, REG_ABI, "used", [O, m.requestNonce], tag, call), ethCall(rpc, m.wif, ERC_ABI, "allowance", [O, R], tag, call)]);
  const [token, perTx, total, spent, , active] = pol;
  const o = [];
  const add = (id, ok, detail) => o.push({ id, status: ok ? "PASS" : "FAIL", detail });
  add("registered == true", registered === true, String(registered));
  add("policy token == WIF, perTx/total caps as recorded", eqAddr(token, m.wif) && perTx === BigInt(m.policy.perTxRaw) && total === BigInt(m.policy.totalRaw), `${token} ${perTx}/${total}`);
  add("policy.active == false (revoked)", active === false, String(active));
  add("policy.spent == 0.1 WIF", spent === BigInt(m.transferRaw), String(spent));
  add("used(owner, requestNonce) == true", nonceUsed === true, String(nonceUsed));
  add("WIF.allowance(owner, registry) == 0", allow === 0n, String(allow));
  return o;
}

/** Runtime code / immutables checks. localArtifact (optional) is a hardhat artifact for an independent source-compile comparison. */
export async function codeChecks(rpc, m, call = rpcCall, localArtifact = null) {
  const o = []; const R = m.registry;
  const code = await call(rpc, "eth_getCode", [R, "latest"]);
  const add = (id, ok, detail) => o.push({ id, status: ok ? "PASS" : "FAIL", detail });
  add("registry has code", !!code && code !== "0x", `${code ? (code.length - 2) / 2 : 0} bytes`);
  if (!code || code === "0x") return o;
  add("runtime codeHash == pinned", keccak256(code) === lc(m.runtime.codeHash), keccak256(code));
  add("runtime with immutables masked == pinned maskedCodeHash", keccak256(mask(code, m.runtime.immutableRefs)) === lc(m.runtime.maskedCodeHash), keccak256(mask(code, m.runtime.immutableRefs)));
  const [w, fee, sink] = await Promise.all([ethCall(rpc, R, REG_ABI, "wif", [], "latest", call), ethCall(rpc, R, REG_ABI, "onboardingFee", [], "latest", call), ethCall(rpc, R, REG_ABI, "feeSink", [], "latest", call)]);
  add("immutables wif/onboardingFee/feeSink == manifest", eqAddr(w, m.wif) && fee === BigInt(m.onboardingFeeRaw) && eqAddr(sink, m.feeSink), `${w} ${fee} ${sink}`);
  const cb = Buffer.from(code.slice(2), "hex"); const allowed = new Set([w, sink].map((x) => lc(x).slice(2).padStart(64, "0")).concat(fee.toString(16).padStart(64, "0")));
  add("every immutable slot holds one of those three values", m.runtime.immutableRefs.every((r) => allowed.has(cb.subarray(r.start, r.start + r.length).toString("hex"))), `${m.runtime.immutableRefs.length} slots`);
  if (localArtifact) {
    const dep = localArtifact.deployedBytecode;
    add("LOCAL source compile: masked runtime == on-chain masked runtime", dep.length === code.length && keccak256(mask(dep, m.runtime.immutableRefs)) === keccak256(mask(code, m.runtime.immutableRefs)), "compiled from contracts/AgentRegistry.sol with this repo's hardhat config");
  }
  return o;
}

function wrap(id, fn) { return fn().then((r) => (Array.isArray(r) ? r : [{ id, status: "PASS", detail: r ?? "" }]), (e) => [{ id, status: e instanceof Fail ? "FAIL" : e instanceof RpcError ? "INCONCLUSIVE" : "FAIL", detail: e.message }]); }

export async function runAll({ rpc, archiveRpc, skipHistorical, manifest, localArtifact, call = rpcCall }) {
  const m = manifest; const rows = [];
  const push = (section, rs) => rows.push(...rs.map((r) => ({ section, ...r })));
  push("chain", await wrap("chainId == 4663", async () => { const c = BigInt(await call(rpc, "eth_chainId", [])); must(c === BigInt(m.chainId), `chainId ${c}`); return String(c); }));
  const specs = stepSpecs(m); let fee = 0n; let allTx = true;
  for (const t of m.txs) {
    const r = await wrap(`${t.step} ${t.hash.slice(0, 12)}…`, async () => { const v = await verifyTx(rpc, m, t.step, t.hash, specs[t.step], call); fee += v.feeWei; return `receipt success, block ${v.block}, input/from/to/events as expected`; });
    if (r[0].status !== "PASS") allTx = false; push("transactions", r);
  }
  if (allTx) push("transactions", [{ id: "sum of 8 gas fees == pinned", status: fee === BigInt(m.expectedTotalFeeWei) ? "PASS" : "FAIL", detail: `${fee} wei` }]);
  push("code", await wrap("code checks", () => codeChecks(rpc, m, call, localArtifact)));
  if (!localArtifact) push("code", [{ id: "LOCAL source compile comparison", status: "SKIP", detail: "no artifacts/ found (run `npm run compile` to enable); NOT a pass" }]);
  push("current state (latest block; may legitimately change if the owner acts again)", await wrap("state latest", () => stateChecks(rpc, m, "latest", call)));
  if (skipHistorical) push("historical state at finalBlock", [{ id: "state at finalBlock", status: "SKIP", detail: "--skip-historical given; NOT a pass" }]);
  else push(`historical state at finalBlock ${m.finalBlock} (may need an archive RPC)`, await wrap(`state @${m.finalBlock}`, () => stateChecks(archiveRpc ?? rpc, m, "0x" + m.finalBlock.toString(16), call)).then((rs) => rs.map((r) => (r.status === "INCONCLUSIVE" ? { ...r, detail: r.detail + " — historical state unavailable on this RPC; pass --archive-rpc <url>. NOT a pass." } : r))));
  return rows;
}

export const exitCode = (rows) => (rows.some((r) => r.status === "FAIL") ? 1 : rows.some((r) => r.status === "INCONCLUSIVE") ? 2 : 0);

function args(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { if (argv[i] === "--skip-historical") o.skipHistorical = true; else if (argv[i] === "--json") o.json = true; else if (argv[i] === "--rpc") o.rpc = argv[++i]; else if (argv[i] === "--archive-rpc") o.archiveRpc = argv[++i]; else if (argv[i] === "--manifest") o.manifest = argv[++i]; else { console.error(`unknown argument ${argv[i]}\nusage: verify_public.mjs [--rpc URL] [--archive-rpc URL] [--skip-historical] [--manifest FILE] [--json]`); process.exit(64); } } return o; }

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const a = args(process.argv.slice(2)); const manifest = loadManifest(a.manifest);
  const rpc = a.rpc ?? process.env.WIF_VERIFY_RPC ?? manifest.defaultRpc, archiveRpc = a.archiveRpc ?? process.env.WIF_VERIFY_ARCHIVE_RPC;
  for (const u of [rpc, archiveRpc].filter(Boolean)) if (!/^https:\/\//.test(u)) { console.error("RPC URL must be https://"); process.exit(64); }
  const artPath = resolve(ROOT, "artifacts/contracts/AgentRegistry.sol/AgentRegistry.json");
  const localArtifact = existsSync(artPath) ? JSON.parse(readFileSync(artPath, "utf8")) : null;
  const rows = await runAll({ rpc, archiveRpc, skipHistorical: a.skipHistorical, manifest, localArtifact });
  const code = exitCode(rows);
  if (a.json) console.log(JSON.stringify({ at: new Date().toISOString(), rpc, exit: code, rows }, null, 2));
  else {
    console.log(`PTone Agent Registry — third-party READ-ONLY verification (chain ${manifest.chainId}, registry ${manifest.registry})\nRPC: ${rpc}${archiveRpc ? `  archive: ${archiveRpc}` : ""}\n`);
    let sec = ""; for (const r of rows) { if (r.section !== sec) { sec = r.section; console.log(`\n== ${sec}`); } console.log(`  [${r.status.padEnd(12)}] ${r.id}${r.detail ? `  — ${r.detail}` : ""}`); }
    const c = (s) => rows.filter((r) => r.status === s).length;
    console.log(`\nSUMMARY: ${c("PASS")} PASS, ${c("FAIL")} FAIL, ${c("INCONCLUSIVE")} INCONCLUSIVE, ${c("SKIP")} SKIP  => exit ${code}`);
    console.log("Scope: the Codex-run mainnet self-transfer test (user-confirm mode). Trusts the RPC you chose; for independence compare with a second RPC / your own node. Not a statement about any public product.");
  }
  process.exit(code);
}
