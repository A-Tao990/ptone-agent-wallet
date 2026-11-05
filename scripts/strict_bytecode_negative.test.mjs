// Negative/positive tests for strict_bytecode.mjs. Offline: builds a synthetic "on-chain" runtime
// from the compiled artifact + fixed immutables, then tampers 1 byte. No RPC, no signing.
// Usage: node scripts/strict_bytecode_negative.test.mjs [chainCodeHexFile]
import fs from "node:fs";
import assert from "node:assert/strict";
import { loadBuild, strictCompare } from "./strict_bytecode.mjs";

const EXP = { wif: "0x5173b8eA6923c2d40267890D45C46a3480954773", onboardingFee: 10n ** 18n, feeSink: "0xFC51A000e7E0B48f271BE023f494E8c46a5f660f" };
const b = loadBuild(".");
assert.equal(b.sourceMatches, true, "build-info source != current contracts/AgentRegistry.sol");

// base: real on-chain code if provided, else synthesized from artifact (independent of strictCompare)
let base;
if (process.argv[2]) base = fs.readFileSync(process.argv[2], "utf8").trim().toLowerCase().replace(/^0x/, "");
else {
  const a = b.runtime.slice(2).split("");
  const val = { wif: EXP.wif.slice(2).toLowerCase().padStart(64, "0"), onboardingFee: EXP.onboardingFee.toString(16).padStart(64, "0"), feeSink: EXP.feeSink.slice(2).toLowerCase().padStart(64, "0") };
  for (const [id, rs] of Object.entries(b.refs)) for (const r of rs) for (let i = 0; i < 64; i++) a[r.start * 2 + i] = val[b.idToName[id]][i];
  base = a.join("");
}
const flip = (hex, byteIdx) => { const s = byteIdx * 2; const v = (parseInt(hex.slice(s, s + 2), 16) ^ 0x01).toString(16).padStart(2, "0"); return hex.slice(0, s) + v + hex.slice(s + 2); };
const inRef = new Set(); for (const rs of Object.values(b.refs)) for (const r of rs) for (let i = 0; i < 32; i++) inRef.add(r.start + i);

const results = {};
results.baseline = strictCompare(b, "0x" + base, EXP);
assert.equal(results.baseline.pass, true, "baseline must PASS");

// 1) non-immutable byte tampered (pick first opcode byte and a mid-code byte not in any ref)
const mid = [...Array(base.length / 2).keys()].find((i) => i > 300 && !inRef.has(i));
for (const [k, idx] of [["nonImmutable_byte0", 0], ["nonImmutable_mid", mid]]) {
  assert.ok(!inRef.has(idx));
  results[k] = strictCompare(b, "0x" + flip(base, idx), EXP);
  assert.equal(results[k].pass, false, k + " must FAIL");
  assert.equal(results[k].firstDiff, idx);
}
// 2) one byte inside each immutable variable's first slot tampered (last byte of the word = value LSB)
for (const [id, rs] of Object.entries(b.refs)) {
  const k = "immutable_" + b.idToName[id];
  results[k] = strictCompare(b, "0x" + flip(base, rs[0].start + 31), EXP);
  assert.equal(results[k].pass, false, k + " must FAIL");
  assert.ok(results[k].slots.some((s) => !s.ok));
}
// 3) old heuristic (sameLength && differingBytes<=96) vs. tampers it cannot see. Baseline diff count is
// value-dependent (nonzero bytes of wif/fee/sink across 7 refs), so the heuristic is accidental, not a proof.
const oldHeuristic = (local, chain) => { let d = 0; for (let i = 0; i < local.length; i += 2) if (local.slice(i, i + 2) !== chain.slice(i, i + 2)) d++; return { pass: local.length === chain.length && d <= 96, d }; };
const L = b.runtime.slice(2);
results.oldBaselineDiffBytes = oldHeuristic(L, base).d;
const wifRef2 = b.refs[Object.keys(b.idToName).find((k) => b.idToName[k] === "wif")][1].start; // 2nd wif ref (getter may read the other)
const tA = flip(base, wifRef2 + 31);                                   // wrong wif value in one ref, count unchanged
const zeroIdx = [...inRef].find((i) => base.slice(i * 2, i * 2 + 2) !== "00");
const tB0 = base.slice(0, zeroIdx * 2) + "00" + base.slice(zeroIdx * 2 + 2); // one immutable byte zeroed (-1 diff)
const tB = flip(tB0, mid);                                             // + one non-immutable byte tampered (+1 diff)
results.old_on_wrongImmutableValue = oldHeuristic(L, tA).pass;
results.old_on_nonImmutableTamperCompensated = oldHeuristic(L, tB).pass;
results.strict_on_wrongImmutableValue = strictCompare(b, "0x" + tA, EXP);
results.strict_on_nonImmutableTamperCompensated = strictCompare(b, "0x" + tB, EXP);
assert.equal(results.old_on_wrongImmutableValue, true, "old heuristic should wrongly PASS wrong immutable");
assert.equal(results.old_on_nonImmutableTamperCompensated, true, "old heuristic should wrongly PASS code tamper");
assert.equal(results.strict_on_wrongImmutableValue.pass, false);
assert.equal(results.strict_on_nonImmutableTamperCompensated.pass, false);
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, typeof v !== "object" ? v : { pass: v.pass, diffBytes: v.diffBytes, firstDiff: v.firstDiff, badSlots: v.slots?.filter((s) => !s.ok).map((s) => s.name + "@" + s.start) }])), null, 1));
console.log("ALL NEGATIVE TESTS OK");
