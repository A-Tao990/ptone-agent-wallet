import { Policy, TransferIntent, checkPolicy, formatAmount } from "./core";

export interface Receipt { status: "success" | "failed" | "unknown"; id: string; simulated: boolean; explorerUrl?: string; note?: string; rejected?: boolean /* wallet refused before any tx was created */ }

/** Common interface. Simulated and chain adapters are separate implementations. */
export interface Adapter {
  readonly mode: "DEMO" | "TESTNET";
  onboard(feeWif: bigint): Promise<Receipt>;
  setPolicy(p: Omit<Policy, "spent" | "active">): Promise<Receipt>;
  execute(i: TransferIntent, nonce: string): Promise<Receipt>;
  readonly decimals: number;
  revoke(): Promise<Receipt>;
  state(): Policy | null;
  balances(): { wif: bigint; gasEth: bigint; token: bigint };
}

/** DEMO adapter: in-memory only. Every receipt is flagged simulated, ids prefixed "demo-", no explorer links. */
export class SimulatedAdapter implements Adapter {
  readonly mode = "DEMO" as const;
  private registered = false; private pol: Policy | null = null; private seen = new Set<string>(); private n = 0;
  private bal: { wif: bigint; gasEth: bigint; token: bigint };
  constructor(private now: () => number = () => Math.floor(Date.now() / 1000), readonly decimals = 18) {
    this.bal = { wif: 100n * 10n ** 18n, gasEth: 10n ** 16n, token: 1000n * 10n ** BigInt(decimals) };
  }
  private rid(kind: string): string { return `demo-${kind}-${++this.n}`; }
  async onboard(fee: bigint): Promise<Receipt> {
    if (this.registered) return { status: "failed", id: this.rid("onboard"), simulated: true, note: "Already registered" };
    if (this.bal.wif < fee) return { status: "failed", id: this.rid("onboard"), simulated: true, note: "Insufficient WIF for onboarding fee" };
    this.bal.wif -= fee; this.registered = true;
    return { status: "success", id: this.rid("onboard"), simulated: true };
  }
  async setPolicy(p: Omit<Policy, "spent" | "active">): Promise<Receipt> {
    if (!this.registered) return { status: "failed", id: this.rid("policy"), simulated: true, note: "Not onboarded" };
    if (p.perTxCap <= 0n || p.perTxCap > p.totalCap) return { status: "failed", id: this.rid("policy"), simulated: true, note: "Invalid caps" };
    if (p.expiry <= this.now()) return { status: "failed", id: this.rid("policy"), simulated: true, note: "Expiry in the past" };
    this.pol = { ...p, spent: 0n, active: true };
    return { status: "success", id: this.rid("policy"), simulated: true };
  }
  async execute(i: TransferIntent, nonce: string): Promise<Receipt> {
    if (!this.pol) return { status: "failed", id: this.rid("tx"), simulated: true, note: "No policy" };
    const key = nonce; // replay guard on nonce only (matches contract); same nonce = same request retry
    if (this.seen.has(key)) return { status: "failed", id: this.rid("tx"), simulated: true, note: "Duplicate request blocked (nonce already used)" };
    const errs = checkPolicy(i, this.pol, this.now(), this.decimals);
    if (errs.length) return { status: "failed", id: this.rid("tx"), simulated: true, note: errs.join("; ") };
    if (this.bal.token < i.amount) return { status: "failed", id: this.rid("tx"), simulated: true, note: "Insufficient token balance" };
    this.seen.add(key); this.bal.token -= i.amount; this.pol.spent += i.amount;
    return { status: "success", id: this.rid("tx"), simulated: true, note: `Simulated transfer of ${formatAmount(i.amount, this.decimals)} ${i.symbol}` };
  }
  async revoke(): Promise<Receipt> {
    if (this.pol) this.pol.active = false;
    return { status: "success", id: this.rid("revoke"), simulated: true };
  }
  state() { return this.pol ? { ...this.pol } : null; }
  balances() { return { ...this.bal }; }
}
