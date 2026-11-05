// Strict runtime-bytecode comparison (2026-11-05, Claude Opus; replaces diff-count heuristic).
// Pure functions: no network, no signing. Rebuilds expected runtime by writing the fixed immutable
// values into the exact solc immutableReferences slots, then requires byte-for-byte equality.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export function loadBuild(root = ".", srcPath = "contracts/AgentRegistry.sol", name = "AgentRegistry") {
  const dbgFile = path.join(root, "artifacts", srcPath, `${name}.dbg.json`);
  const dbg = JSON.parse(fs.readFileSync(dbgFile, "utf8"));
  const biFile = path.resolve(path.dirname(dbgFile), dbg.buildInfo);
  const bi = JSON.parse(fs.readFileSync(biFile, "utf8"));
  const out = bi.output.contracts[srcPath][name];
  const ids = {};
  (function walk(n) {
    if (n && typeof n === "object") {
      if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable") ids[String(n.id)] = n.name;
      for (const v of Object.values(n)) walk(v);
    }
  })(bi.output.sources[srcPath].ast);
  const srcNow = fs.readFileSync(path.join(root, srcPath), "utf8");
  const srcBuilt = bi.input.sources[srcPath].content;
  return {
    buildInfo: path.relative(root, biFile), solc: bi.solcLongVersion, settings: bi.input.settings,
    sourceMatches: srcNow === srcBuilt,
    sourceSha256: crypto.createHash("sha256").update(srcNow).digest("hex"),
    runtime: "0x" + out.evm.deployedBytecode.object.toLowerCase(),
    refs: out.evm.deployedBytecode.immutableReferences, idToName: ids,
  };
}

const word = (v) => {
  if (typeof v === "bigint") return v.toString(16).padStart(64, "0");
  const h = String(v).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error("bad immutable value " + v);
  return h.padStart(64, "0");
};

// expected: { wif: address, onboardingFee: bigint, feeSink: address }
export function strictCompare({ runtime, refs, idToName }, chainCode, expected) {
  const fail = (reason, extra = {}) => ({ pass: false, reason, ...extra });
  const loc = runtime.replace(/^0x/, "");
  const chn = String(chainCode).toLowerCase().replace(/^0x/, "");
  if (loc.length !== chn.length) return fail("length mismatch", { localBytes: loc.length / 2, chainBytes: chn.length / 2 });
  const refIds = Object.keys(refs);
  const names = refIds.map((id) => idToName[id]);
  if (names.some((n) => !n)) return fail("unmapped immutable AST id", { refIds, idToName });
  const want = Object.keys(expected).sort().join(","), have = [...names].sort().join(",");
  if (want !== have) return fail("immutable set mismatch", { want, have });
  const buf = loc.split("");
  const slots = [];
  for (const id of refIds) {
    const name = idToName[id], w = word(expected[name]);
    for (const { start, length } of refs[id]) {
      if (length !== 32) return fail("unexpected ref length", { name, start, length });
      const s = start * 2, e = s + 64;
      if (loc.slice(s, e) !== "0".repeat(64)) return fail("compiled placeholder not zero", { name, start });
      const onchain = chn.slice(s, e);
      slots.push({ name, start, ok: onchain === w });
      for (let i = 0; i < 64; i++) buf[s + i] = w[i];
    }
  }
  const expectedRuntime = buf.join("");
  let firstDiff = -1, diffBytes = 0;
  for (let i = 0; i < chn.length; i += 2) if (chn.slice(i, i + 2) !== expectedRuntime.slice(i, i + 2)) { diffBytes++; if (firstDiff < 0) firstDiff = i / 2; }
  const pass = diffBytes === 0 && slots.every((x) => x.ok);
  return { pass, reason: pass ? "rebuilt runtime == on-chain byte-for-byte" : "byte mismatch", diffBytes, firstDiff, slots, runtimeBytes: chn.length / 2 };
}
