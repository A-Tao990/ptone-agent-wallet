# Evidence — real transactions on Robinhood Chain mainnet (chain 4663)

All facts below are public and re-checkable. Machine-readable copy: [`evidence/mainnet-receipts.json`](evidence/mainnet-receipts.json); verifier: `npm run verify:public`.
Explorer: https://robinhoodchain.blockscout.com · RPC: https://rpc.mainnet.chain.robinhood.com

| Item | Value |
|---|---|
| AgentRegistry | `0x92ad0E8D7d48334b9f9535dd9109C8A37271f45D` |
| WIF token | `0x5173b8eA6923c2d40267890D45C46a3480954773` (18 decimals) |
| Runtime codehash | `0x1539ae84f0c9440ce6eb8f44f4ecf493d39ca8cb823998aca722b4ea2b25c5cf` |
| Onboarding fee / feeSink | 1 WIF / `0xFC51A000e7E0B48f271BE023f494E8c46a5f660f` (wallet A, the author's own) |
| Wallet A | `0xFC51A000e7E0B48f271BE023f494E8c46a5f660f` — author's wallet, used via Binance Agentic Wallet CLI |
| Wallet B | `0x159a75d1D3ef477C111776c017724Bc7CEfF2B64` — author's second wallet on the OKX mobile app |

## Flow A — 8 transactions through the CLI (user-confirm mode, all `success`)
| # | What | Tx hash | Fee (wei) |
|---|---|---|---|
| 1 | CREATE2 deploy of the registry | [`0xf0bd7b85…0a0f56`](https://robinhoodchain.blockscout.com/tx/0xf0bd7b8588384c376c4c3f1c9d781c3c26e5ac5810f6df19a429a6913a0a0f56) | 22334989248000 |
| 2 | `WIF.approve(registry, 1 WIF)` | [`0x1d28375b…4c773e`](https://robinhoodchain.blockscout.com/tx/0x1d28375bea19ac949dc3a1cdf80afab7f59b9686ebcdf8154cd78502014c773e) | 984227580000 |
| 3 | `register()` (1 WIF fee) | [`0x93ed4999…2d28c4`](https://robinhoodchain.blockscout.com/tx/0x93ed4999a357f6990a11b9dabaa61c9edd07601ee9c84112f76b7946a12d28c4) | 1160593056000 |
| 4 | `setPolicy` 0.1 / 0.2 WIF, 1 h, recipient = self | [`0xa64dc5df…c7c58d`](https://robinhoodchain.blockscout.com/tx/0xa64dc5df44fe331fcc6bc414c16bc64438c2eeec823efcd8835493d1b8c7c58d) | 3168379368000 |
| 5 | `WIF.approve(registry, 0.2)` | [`0xf1b6579d…c90102`](https://robinhoodchain.blockscout.com/tx/0xf1b6579dbefbeafc81d300e2dec4764d07b3077e5a4599f6322b7dda3dc90102) | 977335230000 |
| 6 | `execute()` 0.1 WIF self-transfer | [`0x23325b0a…daad10c`](https://robinhoodchain.blockscout.com/tx/0x23325b0a6462129f55b42e1f7116aea8fd4c0033f2b194bd42769946da0ad10c) | 1662131590000 |
| 7 | `revoke()` | [`0xfc3ec458…a4ccbd1`](https://robinhoodchain.blockscout.com/tx/0xfc3ec458471f85c16937067c032f59b8ec8598091e74015a5ecdce328a4ccbd1) | 591947232000 |
| 8 | `WIF.approve(registry, 0)` | [`0xdd9952c7…5b4236`](https://robinhoodchain.blockscout.com/tx/0xdd9952c7e7d7f2116a30566fca7160a4cb35d6c6bc0da1c4186773386d5b4236) | 526534920000 |

Total gas: 31,406,138,224,000 wei = 0.000031406 ETH. Final state read by the verifier: registered = true, policy inactive, spent 0.1 WIF, nonce used, allowance 0.

## Flow B — second wallet on a phone (OKX Connect), 9 transactions (full lifecycle)
| # | What | Tx hash | Signed by |
|---|---|---|---|
| 1 | A → B 0.000015 ETH for gas | [`0x1c1e7c1c…636283`](https://robinhoodchain.blockscout.com/tx/0x1c1e7c1ce06a4e6aae6aaa43e19dbb6575ed56d1f04125e58211c24c23636283) | A (CLI) |
| 2 | A → B 1.2 WIF | [`0x79a37a0e…b69038`](https://robinhoodchain.blockscout.com/tx/0x79a37a0e117cd3820d692ad5abeab533621ac217663c22345a650a0c4fb69038) | A (CLI) |
| 3 | B `WIF.approve(registry, 1 WIF)` | [`0xe8a17ae2…772c87`](https://robinhoodchain.blockscout.com/tx/0xe8a17ae259436e4ae4c597ad342557b9a593cda1f7f864ac61ec5f5d54772c87) | B, phone confirmation |
| 4 | B `register()` → `Registered(B)`, 1 WIF to feeSink | [`0x6e53bd15…1bea46`](https://robinhoodchain.blockscout.com/tx/0x6e53bd1583bf30577cf8951e623bb6f33b3abc76dd74b755f690ada64b1bea46) | B, phone confirmation |
| 5 | B `setPolicy` 0.1 / 0.2 WIF, 1 h, recipient = self | [`0xf15b164a…946197`](https://robinhoodchain.blockscout.com/tx/0xf15b164aa1f17e45acd7f25aacc260b6e0b8109a0c648ee42f16296049946197) | B, phone confirmation |
| 6 | B `WIF.approve(registry, 0.2)` | [`0x85ca68d6…7ff494`](https://robinhoodchain.blockscout.com/tx/0x85ca68d63e197769e9e60169ba196f381f63e5fc7082910ee43073f2ff7ff494) | B, phone confirmation |
| 7 | B `execute()` 0.1 WIF self-transfer (moves 0.1 WIF) | [`0xfbd612fb…abe779`](https://robinhoodchain.blockscout.com/tx/0xfbd612fb41620620903a3333217038f7c9ffdbc5ceb7c50afb036ab90cabe779) | B, phone confirmation |
| 8 | B `revoke()` | [`0x19b241b7…3474bf`](https://robinhoodchain.blockscout.com/tx/0x19b241b725cb3ffe8e50a6cdf4a7960601af7ec08ce1c6724fb7ae4c153474bf) | B, phone confirmation |
| 9 | B `WIF.approve(registry, 0)` | [`0x4d2890d9…a30e9a`](https://robinhoodchain.blockscout.com/tx/0x4d2890d9cea1326d660e5ef6d7e6f6584c9d3f0c35d6b675779d88ac48a30e9a) | B, phone confirmation |

Rows 5–9 were signed on the phone on 2026-11-10 through the public web UI ([live page](https://a-tao990.github.io/ptone-agent-wallet/), MAINNET mode over OKX Connect), one confirmation per transaction. Receipts re-read from the RPC: all `status = 1`; only row 7 moved WIF (0.1, B → B through `Registry.execute`); machine-readable copy in [`evidence/flow-b-receipts.json`](evidence/flow-b-receipts.json).

Total gas: 3,758,644,402,000 wei for rows 1–4 and 6,522,676,162,000 wei for rows 5–9. After flow B: B holds 0.2 WIF, allowance to the registry is 0, B's policy is inactive (spent 0.1), A is untouched by B's actions. Both wallets belong to the author; this is not an external user.

## How an independent party can reproduce
1. `npm ci && npm run verify:public` — decodes every flow-A tx against the expected ABI/arguments, requires the exact event sequence, and checks the current registry state.
2. `npm run compile && npm run verify:bytecode` — rebuilds expected runtime bytecode from `contracts/AgentRegistry.sol` (solc 0.8.24, optimizer 200 runs, cancun) with the immutables `wif`, `onboardingFee`, `feeSink` written into the exact `immutableReferences` slots, and requires byte equality with `eth_getCode`.
3. `source-verify/` holds the standard-JSON input and constructor args for explorer source verification The registry source was verified on Blockscout with exactly these inputs on 2026-11-10 (result: "Contract source code verified (exact match)", compiler v0.8.24+commit.e11b9ed9, optimizer 200 runs, evm cancun): https://robinhoodchain.blockscout.com/address/0x92ad0E8D7d48334b9f9535dd9109C8A37271f45D?tab=contract . Verified source is not an audit; the contract is still unaudited.

Limits of this evidence: it proves the transactions happened and the contract matches this source. It does not prove safety (no audit), usage by others, or retention/revenue.
