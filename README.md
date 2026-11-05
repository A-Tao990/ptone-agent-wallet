# PTone Agent Wallet

**[Live demo](https://a-tao990.github.io/ptone-agent-wallet/)** · **[Narrated demo video](https://youtu.be/qIpUldMDLdQ)**

**A WIF-gated, user-confirm agent wallet for Robinhood Chain.** The agent proposes a transfer; *you* sign every transaction in your own wallet; an on-chain registry enforces your caps (per-tx, total, expiry, recipient allow-list). You can revoke at any time.

> **Status: unaudited prototype by one developer.** Small amounts only. Not affiliated with Robinhood, Binance, OKX or the World is Flat team.
> Built for the World is Flat × Robinhood Chain build contest. Author: **John Tao**. License: MIT.

## What is real and what is simulated

| Part | Status |
|---|---|
| `AgentRegistry` contract on **Robinhood Chain mainnet (chain 4663)** at `0x92ad0E8D7d48334b9f9535dd9109C8A37271f45D`, creating accounts for a **1 WIF** fee | **Real**, deployed and used with real funds |
| Flow A: 8 mainnet transactions (deploy → approve 1 WIF → register → policy → limited approve → 0.1 WIF self-transfer → revoke → approve 0) driven through the Binance Agentic Wallet CLI | **Real**, all receipts `success` ([EVIDENCE.md](EVIDENCE.md)) |
| Flow B: a second wallet on the **OKX mobile app** connected to the web UI over the official OKX Connect SDK; approve 1 WIF + `register()` signed on the phone | **Real** (2 txs by the phone, plus 2 funding txs from wallet A) |
| Rest of flow B (policy, limited approve, transfer, revoke, approve 0) in the web UI with the phone | **Not executed yet** — no tx hash exists |
| Browser **DEMO** mode (default; what a public page runs) | **Simulated**. In-memory balances, receipts start with `demo-`, a permanent `DEMO — SIMULATED` badge. No chain, no wallet |
| MAINNET mode in the browser | Real funds. Only after ticking a risk box, connecting a wallet you control, and passing the pinned-contract checks. Each tx is confirmed by you in your wallet |

### What it is **not**
- Not an autonomous / always-running AI. There is no session key, ERC-4337 or EIP-7702 delegate. The "agent" parses `send <amount> WIF to <0x…>` and prepares a transaction; a human signs it.
- No new wallet address is created for the agent; it uses the wallet you already have.
- No custody. Funds stay in your wallet; the registry can only pull a **finite ERC-20 allowance** you grant, and only through `execute()` within your policy.
- No swaps, no bridging, no unlimited approvals, no trading strategy.
- No audit, no external users, no revenue. The 1 WIF onboarding fee in the tests was paid by the author from one wallet to another of the author's own wallets.

## How WIF is used
1. **Onboarding gate** — opening an agent account costs a fixed **1 WIF** (`register()` pulls it with `transferFrom` to `feeSink`).
2. **Policy token** — the policy (per-tx cap, total cap, expiry, allowed recipients) is expressed in WIF, and transfers go through `Registry.execute()`.

Design intent (a hypothesis, **not measured retention or revenue**): the account gate makes WIF a prerequisite for using the agent, and because spending rights expire and are capped, a user who wants the agent to keep working re-opens/re-sets a policy, which means holding and moving WIF again. No claim is made that this works at scale.

## Costs (real flow, so far)
- Gas: ≈ 0.0000352 ETH in total for the 12 mainnet txs of flows A and B (~0.0000314 for A's 8, ~0.0000038 for B's 4).
- Principal: the 1 WIF fee goes to `feeSink`, which in this deployment is the author's own wallet A; 0.1 WIF was self-transferred. The author also bridged a budget of about 1.5 USDT to obtain gas ETH and WIF (owner-stated, not part of the hashes here).

## Quick start (no wallet, no key, no gas)
```bash
npm ci
npm run dev            # http://127.0.0.1:5179 — DEMO mode works with no wallet
npm test               # compiles the contract first (hardhat downloads solc 0.8.24 once), then vitest + hardhat contract tests
npm run typecheck
npm run build          # static site in dist/ (vite base './' → works from a GitHub Pages sub-path)
```

### Re-check the mainnet evidence yourself (read-only)
```bash
npm run verify:public            # reads chain 4663 over public RPC; PASS / FAIL / INCONCLUSIVE; never signs, never sends
npm run compile && npm run verify:bytecode   # rebuilds the runtime bytecode from this source + the 3 immutables and compares byte-for-byte with mainnet
npm run test:bytecode            # offline negative tests of that comparison
```
Some historical-block checks report `INCONCLUSIVE` on non-archive RPCs; that is reported honestly and is never counted as a pass.

## Safety checks kept in the UI
Fixed chain 4663, registry, WIF and runtime **codehash** are hard-coded and re-read before every signature; the 1 WIF fee is approved exactly (never unlimited); policy recipients are limited to your own address in this version, with caps of 1 WIF per tx / 2 WIF total / ≤24 h; the amount allowance equals the remaining cap; a request nonce is persisted before the wallet is asked to sign and is **never re-signed** while its outcome is unknown (only a read-only chain check can release it). `revoke()` does not clear an ERC-20 allowance, so the UI has a second explicit step `approve(0)`.

## Layout
`src/` web app (TypeScript + Vite + viem) · `contracts/AgentRegistry.sol` (deployed source, byte-identical) · `test/` · `scripts/` public verifiers · `config/public-verify-manifest.json` public facts · `source-verify/` standard-JSON inputs for explorer verification · `evidence/mainnet-receipts.json`.

Note: the NatSpec comment on `AgentRegistry` still says "local/testnet only". It is left untouched because any byte change alters the deployed codehash that this repo pins; the contract is deployed on mainnet and unaudited.

See [SUBMISSION.md](SUBMISSION.md) and [EVIDENCE.md](EVIDENCE.md). Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
