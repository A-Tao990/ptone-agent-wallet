// Pure, deterministic core: amounts, intent parsing, policy checks. No network, no randomness.
export type Mode = "DEMO" | "TESTNET" | "LIVE";

export const CHAINS = {
  testnet: { id: 46630, name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com", gas: "ETH" },
  // Mainnet is listed for display only; app refuses to transact on it in this version.
  mainnet: { id: 4663, name: "Robinhood Chain Mainnet", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com", gas: "ETH" },
} as const;

/** Parse a decimal string to base units. Strict: no exponent, no sign, no excess precision. */
export function parseAmount(s: string, decimals = 18): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount format");
  const [i, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`Too many decimals (max ${decimals})`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
export function formatAmount(v: bigint, decimals = 18): string {
  const base = 10n ** BigInt(decimals);
  const f = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (v / base).toString() + (f ? "." + f : "");
}

/** Parse "valid for hours" input. Rejects empty/NaN/zero/negative/exponent; max 30 days. Returns seconds. */
export const MAX_HOURS = 720;
export function parseHours(s: string): number {
  const t = (s ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Validity (hours) must be a positive number");
  const h = Number(t);
  if (!Number.isFinite(h) || h <= 0) throw new Error("Validity (hours) must be greater than 0");
  if (h > MAX_HOURS) throw new Error(`Validity too long (max ${MAX_HOURS} hours)`);
  return Math.floor(h * 3600);
}

export interface TransferIntent { type: "transfer"; symbol: string; amount: bigint; to: string }
export interface Policy {
  symbol: string; perTxCap: bigint; totalCap: bigint; spent: bigint;
  expiry: number; // unix seconds
  active: boolean; allowlist: string[]; // lowercase 0x addresses
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
/** Only grammar: "send <amount> <SYMBOL> to <0xaddress>". Anything else is rejected, never guessed. */
export function parseIntent(text: string, supported: string[], decimals: number): TransferIntent {
  const m = /^\s*send\s+(\S+)\s+([A-Za-z0-9]+)\s+to\s+(0x[0-9a-fA-F]{40})\s*$/i.exec(text);
  if (!m) throw new Error('Unsupported instruction. Only: "send <amount> <TOKEN> to <0x address>" (swaps and other actions are not supported)');
  const sym = supported.find((s) => s.toLowerCase() === m[2].toLowerCase());
  if (!sym) throw new Error(`Token ${m[2]} not supported (supported: ${supported.join(", ")})`);
  if (!ADDR.test(m[3])) throw new Error("Invalid address");
  const amount = parseAmount(m[1], decimals);
  if (amount <= 0n) throw new Error("Amount must be positive");
  return { type: "transfer", symbol: sym, amount, to: m[3].toLowerCase() };
}

/** Returns list of violations; empty = allowed. Mirrors the checks in AgentRegistry.execute (UX preview only; the contract enforces). */
export function checkPolicy(i: TransferIntent, p: Policy, now: number, decimals = 18): string[] {
  const e: string[] = [];
  if (!p.active) e.push("Agent permission is revoked/inactive");
  if (now > p.expiry) e.push("Permission expired");
  if (i.symbol !== p.symbol) e.push("Token not covered by permission");
  if (!p.allowlist.includes(i.to)) e.push("Recipient not on allowlist");
  if (i.amount > p.perTxCap) e.push(`Exceeds per-transaction cap (${formatAmount(p.perTxCap, decimals)})`);
  if (p.spent + i.amount > p.totalCap) e.push(`Exceeds total cap (remaining ${formatAmount(p.totalCap - p.spent > 0n ? p.totalCap - p.spent : 0n, decimals)})`);
  return e;
}

/** Fresh bytes32 nonce for a NEW independent request. A retry of the same request must reuse the same nonce
 *  (the contract/demo then rejects it if the first attempt already succeeded). Identical amount/recipient with a new nonce is allowed. */
export function newNonce(): string {
  const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
