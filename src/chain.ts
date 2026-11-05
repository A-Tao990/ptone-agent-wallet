// TESTNET adapter (user-confirm mode: the user signs every execute tx): every tx is signed by the user's own injected wallet.
// Refuses any chain other than Robinhood Chain Testnet (46630). Never auto-switches chains.
import { createPublicClient, createWalletClient, custom, http, parseAbi, type Address, type Hex } from "viem";
import { CHAINS, Policy, TransferIntent, checkPolicy } from "./core";
import type { Receipt } from "./adapters";
import type { ChainFacts, HashFacts } from "./pending";

export const REGISTRY_ABI = parseAbi([
  "function register()", "function registered(address) view returns (bool)",
  "function setPolicy(address token,uint128 perTxCap,uint128 totalCap,uint64 expiry,address executor,address[] recipients)",
  "function setRecipient(address to,bool ok)", "function revoke()", "function onboardingFee() view returns (uint256)",
  "function isAllowed(address owner,address to) view returns (bool)", "function used(address,bytes32) view returns (bool)",
  "function execute(address owner,bytes32 nonce,address token,address to,uint256 amount)",
  "function policies(address) view returns (address token,uint128 perTxCap,uint128 totalCap,uint128 spent,uint64 expiry,bool active,address executor)",
]);
export const ERC20_ABI = parseAbi([
  "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)",
]);

export interface ChainCfg { registry: Address; wif: Address; token: Address; tokenSymbol: string; tokenDecimals: number }

export class ChainAdapter {
  readonly mode = "TESTNET" as const;
  pub = createPublicClient({ transport: http(CHAINS.testnet.rpc) });
  constructor(private eth: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }, private cfg: ChainCfg, public account: Address) {}
  private wallet() { return createWalletClient({ account: this.account, transport: custom(this.eth as never) }); }
  static async chainIdOf(eth: { request: (a: { method: string }) => Promise<unknown> }): Promise<number> {
    return parseInt((await eth.request({ method: "eth_chainId" })) as string, 16);
  }
  private chain() { return { id: CHAINS.testnet.id, name: CHAINS.testnet.name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [CHAINS.testnet.rpc] } } } as const; }
  /** Submit + wait. If wait fails/times out we report "unknown" (never fake success). */
  private async send(req: Parameters<ReturnType<ChainAdapter["wallet"]>["writeContract"]>[0], onHash?: (h: string) => void): Promise<Receipt> {
    let hash: Hex;
    try { hash = await this.wallet().writeContract({ ...req, chain: this.chain() } as never); }
    catch (e) {
      const err = e as { code?: number; message: string };
      return { status: "failed", id: "", simulated: false, rejected: err.code === 4001 || /user (rejected|denied)/i.test(err.message), note: err.message.split("\n")[0] };
    }
    onHash?.(hash); // persisted by caller immediately, before waiting
    const url = `${CHAINS.testnet.explorer}/tx/${hash}`;
    try {
      const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      return { status: r.status === "success" ? "success" : "failed", id: hash, simulated: false, explorerUrl: url };
    } catch { return { status: "unknown", id: hash, simulated: false, explorerUrl: url, note: "Result unknown — use Check status (no new Preview, no re-sign while unresolved); verify in explorer" }; }
  }
  async onboard(fee: bigint): Promise<Receipt> {
    const a = await this.send({ address: this.cfg.wif, abi: ERC20_ABI, functionName: "approve", args: [this.cfg.registry, fee] } as never);
    if (a.status !== "success") return a;
    return this.send({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "register" } as never);
  }
  /** One tx: sets policy AND recipients under a new policy version (older allowlists become invalid). */
  setPolicy(p: { perTxCap: bigint; totalCap: bigint; expiry: number; allowlist: string[] }): Promise<Receipt> {
    return this.send({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "setPolicy", args: [this.cfg.token, p.perTxCap, p.totalCap, BigInt(p.expiry), "0x0000000000000000000000000000000000000000", p.allowlist as Address[]] } as never);
  }
  /** Reads decimals() from the token contract (never hard-coded). Throws if unreadable or not 0..36. */
  static async readDecimals(token: Address): Promise<number> {
    const pub = createPublicClient({ transport: http(CHAINS.testnet.rpc) });
    const d = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" });
    if (d > 36) throw new Error("Unreasonable token decimals");
    return Number(d);
  }
  async fee(): Promise<bigint> { return this.pub.readContract({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "onboardingFee" }); }
  async isAllowed(to: string): Promise<boolean> { return this.pub.readContract({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "isAllowed", args: [this.account, to as Address] }); }
  async isNonceUsed(nonce: string): Promise<boolean> { return this.pub.readContract({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "used", args: [this.account, nonce as Hex] }); }
  /** Gas estimate in wei, or null when it cannot be estimated (reported as "not estimated", never 0). */
  async estimateExecute(i: TransferIntent, nonce: string): Promise<bigint | null> {
    try {
      const [gas, price] = await Promise.all([
        this.pub.estimateContractGas({ account: this.account, address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "execute", args: [this.account, nonce as Hex, this.cfg.token, i.to as Address, i.amount] }),
        this.pub.getGasPrice(),
      ]);
      return gas * price;
    } catch { return null; }
  }
  async readPolicy(): Promise<Policy | null> {
    const p = await this.pub.readContract({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "policies", args: [this.account] });
    if (p[4] === 0n) return null;
    return { symbol: this.cfg.tokenSymbol, perTxCap: p[1], totalCap: p[2], spent: p[3], expiry: Number(p[4]), active: p[5], allowlist: [] };
  }
  /** ONE user-signed tx: Registry.execute checks policy and does token.transferFrom(owner,to,amount) atomically
   *  (needs a finite token allowance to the Registry, see approveToken). The caller supplies a stable nonce:
   *  the request nonce stays locked after an unknown result (no re-sign); the contract rejects a replay if the first attempt succeeded. */
  async execute(i: TransferIntent, nonce: string, onHash?: (h: string) => void): Promise<Receipt> {
    return this.send({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "execute", args: [this.account, nonce as Hex, this.cfg.token, i.to as Address, i.amount] } as never, onHash);
  }
  /** Chain facts for resolving an unresolved request; each read failure becomes null (unknown), never a guess.
   *  ONE snapshot block B: sender tx count and Registry.used are both read AT B (consistent under load-balanced RPCs).
   *  Per-hash receipt/getTransaction are read at latest (a reverted receipt is a standalone proof; the sender nonce is only evidence). */
  async facts(nonce: string | null, hashes: string[] = []): Promise<ChainFacts> {
    const block = await this.pub.getBlockNumber().catch(() => null);
    const accountCount = block === null ? null : await this.pub.getTransactionCount({ address: this.account, blockNumber: block }).then(BigInt, () => null);
    const nonceUsed = block === null || nonce === null ? null
      : await this.pub.readContract({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "used", args: [this.account, nonce as Hex], blockNumber: block }).catch(() => null);
    const hf: Record<string, HashFacts> = {};
    for (const hash of hashes) {
      let receipt: HashFacts["receipt"] = null, txNonce: bigint | null = null, from: string | null = null;
      try { const r = await this.pub.getTransactionReceipt({ hash: hash as Hex }); receipt = r.status === "success" ? "success" : "reverted"; }
      catch (e) { receipt = /not.?found/i.test((e as Error).name + (e as Error).message) ? "notfound" : null; }
      try { const t = await this.pub.getTransaction({ hash: hash as Hex }); txNonce = BigInt(t.nonce); from = t.from ?? null; } catch { /* unknown stays null: never inferred */ }
      hf[hash] = { receipt, txNonce, from: txNonce === null ? null : from };
    }
    return { nonceUsed, accountCount, accountOwner: this.account, block, hashes: hf };
  }
  /** Sender tx count incl. pending pool (evidence recorded before signing); null on RPC failure. */
  async pendingCount(): Promise<bigint | null> { return this.pub.getTransactionCount({ address: this.account, blockTag: "pending" }).then(BigInt, () => null); }
  /** Current token allowance owner->Registry (null when the RPC read fails). */
  async allowance(): Promise<bigint | null> {
    try { return await this.pub.readContract({ address: this.cfg.token, abi: ERC20_ABI, functionName: "allowance", args: [this.account, this.cfg.registry] }); } catch { return null; }
  }
  /** Finite allowance (= total cap) for the Registry on the spend token. Never unlimited. */
  approveToken(amount: bigint): Promise<Receipt> {
    return this.send({ address: this.cfg.token, abi: ERC20_ABI, functionName: "approve", args: [this.cfg.registry, amount] } as never);
  }
  revoke(): Promise<Receipt> { return this.send({ address: this.cfg.registry, abi: REGISTRY_ABI, functionName: "revoke" } as never); }
  async gasEth(): Promise<bigint> { return this.pub.getBalance({ address: this.account }); }
  async tokenBal(t: Address): Promise<bigint> { return this.pub.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [this.account] }); }
}
export { checkPolicy };
