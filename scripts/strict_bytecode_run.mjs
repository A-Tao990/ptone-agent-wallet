// One-shot strict re-check of Registry runtime only (eth_getCode + 3 eth_call). No signing, no tx.
// Usage: node scripts/strict_bytecode_run_20261105.mjs <out.json> [<chaincode.hex out>]
import fs from "node:fs";
import { createPublicClient, http, parseAbi, getAddress, keccak256 } from "viem";
import { loadBuild, strictCompare } from "./strict_bytecode.mjs";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ transport: http(RPC, { retryCount: 3 }) });
const R = getAddress("0x92ad0E8D7d48334b9f9535dd9109C8A37271f45D");
const EXP = { wif: "0x5173b8eA6923c2d40267890D45C46a3480954773", onboardingFee: 10n ** 18n, feeSink: "0xFC51A000e7E0B48f271BE023f494E8c46a5f660f" };
const PIN = "0x1539ae84f0c9440ce6eb8f44f4ecf493d39ca8cb823998aca722b4ea2b25c5cf";
const RA = parseAbi(["function wif() view returns (address)", "function onboardingFee() view returns (uint256)", "function feeSink() view returns (address)"]);
const head = await c.getBlockNumber();
const code = await c.getCode({ address: R, blockNumber: head });
const [w, f, s] = await Promise.all(["wif", "onboardingFee", "feeSink"].map((fn) => c.readContract({ address: R, abi: RA, functionName: fn, blockNumber: head })));
const b = loadBuild(".");
const cmp = strictCompare(b, code, EXP);
const getterMatch = getAddress(w) === getAddress(EXP.wif) && f === EXP.onboardingFee && getAddress(s) === getAddress(EXP.feeSink);
const pass = b.sourceMatches && cmp.pass && getterMatch && keccak256(code) === PIN;
const out = { at: new Date().toISOString(), rpc: RPC, block: head.toString(), registry: R, codeHash: keccak256(code), codeHashPinned: keccak256(code) === PIN,
  build: { buildInfo: b.buildInfo, solc: b.solc, optimizer: b.settings.optimizer, evmVersion: b.settings.evmVersion, sourceMatchesBuildInput: b.sourceMatches, sourceSha256: b.sourceSha256 },
  immutableRefs: Object.fromEntries(Object.entries(b.refs).map(([id, rs]) => [`${id}:${b.idToName[id]}`, rs.map((r) => r.start)])),
  expected: { ...EXP, onboardingFee: EXP.onboardingFee.toString() }, getters: { wif: w, onboardingFee: f.toString(), feeSink: s }, getterMatch,
  strict: cmp, result: pass ? "PASS" : "FAIL" };
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2), { mode: 0o600 });
if (process.argv[3]) fs.writeFileSync(process.argv[3], code, { mode: 0o600 });
console.log(out.result, JSON.stringify({ block: out.block, diffBytes: cmp.diffBytes, slots: cmp.slots.length, slotsOk: cmp.slots.every((x) => x.ok), getterMatch, src: b.sourceMatches }));
