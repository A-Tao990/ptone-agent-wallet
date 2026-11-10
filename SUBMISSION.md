# Submission — PTone Agent Wallet

- **Team:** John Tao (solo)
- **Project:** PTone Agent Wallet
- **Categories:** Agents & AI (primary) · Tools & Infra (secondary)
- **Repo / Live demo / Video:** see `delivery` fields filled at submission time (repo URL, GitHub Pages URL, video URL).

## One-line description
A WIF-gated, user-confirm agent wallet on Robinhood Chain: the agent proposes a transfer, you sign each transaction, and an on-chain registry enforces your per-tx cap, total cap, expiry and recipient allow-list; revoke any time.

## Description
PTone lets a user open an "agent account" on Robinhood Chain by paying a 1 WIF onboarding fee into `AgentRegistry`. The user then sets a spending policy (token, per-tx cap, total cap, expiry, allowed recipients) and grants a finite ERC-20 allowance equal to the remaining cap. An instruction such as `send 0.1 WIF to 0x…` is parsed, previewed (policy check, allowance check, gas estimate or "not estimated"), and only executed after the user confirms and signs in their own wallet. `execute()` checks the policy, burns a nonce and calls `transferFrom` atomically, so a failed transfer reverts everything. Funds never leave the user's wallet except through that bounded path. The web app works in a simulated DEMO mode with no wallet, and in a MAINNET mode that connects a browser wallet or an OKX mobile wallet over QR, verifies the pinned chain/contract/codehash before every signature, and refuses unknown or unresolved states instead of re-signing.

## How WIF is used
1. 1 WIF is the **gate** to open an agent account (paid by `register()` through `transferFrom`, exactly-approved, never unlimited).
2. Policies and agent transfers are denominated in WIF and flow through the registry.

## Flywheel (design intent, not measured)
WIF is required to open an account → the policy (cap + expiry) is bounded, so staying useful means re-setting policies and moving WIF again → more WIF movement/holding per active user. This is a design hypothesis only. There is no measured retention, revenue or external user so far, and none is claimed.

## Real transactions (Robinhood Chain 4663)
Registry `0x92ad0E8D7d48334b9f9535dd9109C8A37271f45D`, WIF `0x5173b8eA6923c2d40267890D45C46a3480954773`.

| Flow | Tx | Hash |
|---|---|---|
| A 1 | deploy | 0xf0bd7b8588384c376c4c3f1c9d781c3c26e5ac5810f6df19a429a6913a0a0f56 |
| A 2 | approve 1 WIF | 0x1d28375bea19ac949dc3a1cdf80afab7f59b9686ebcdf8154cd78502014c773e |
| A 3 | register (1 WIF fee) | 0x93ed4999a357f6990a11b9dabaa61c9edd07601ee9c84112f76b7946a12d28c4 |
| A 4 | setPolicy | 0xa64dc5df44fe331fcc6bc414c16bc64438c2eeec823efcd8835493d1b8c7c58d |
| A 5 | approve 0.2 WIF | 0xf1b6579dbefbeafc81d300e2dec4764d07b3077e5a4599f6322b7dda3dc90102 |
| A 6 | execute 0.1 WIF self-transfer | 0x23325b0a6462129f55b42e1f7116aea8fd4c0033f2b194bd42769946da0ad10c |
| A 7 | revoke | 0xfc3ec458471f85c16937067c032f59b8ec8598091e74015a5ecdce328a4ccbd1 |
| A 8 | approve 0 | 0xdd9952c7e7d7f2116a30566fca7160a4cb35d6c6bc0da1c4186773386d5b4236 |
| B 1 | fund ETH (A→B) | 0x1c1e7c1ce06a4e6aae6aaa43e19dbb6575ed56d1f04125e58211c24c23636283 |
| B 2 | fund WIF (A→B) | 0x79a37a0e117cd3820d692ad5abeab533621ac217663c22345a650a0c4fb69038 |
| B 3 | approve 1 WIF (phone) | 0xe8a17ae259436e4ae4c597ad342557b9a593cda1f7f864ac61ec5f5d54772c87 |
| B 4 | register (phone) | 0x6e53bd1583bf30577cf8951e623bb6f33b3abc76dd74b755f690ada64b1bea46 |

## Honest scope
- User-confirm mode only. No continuously running autonomous AI, no session key/4337/7702, no new independent wallet address, no custody, no swaps.
- Flow B is now complete: the second wallet ran policy, limited approve, a 0.1 WIF self-transfer, revoke and approve 0 from the public web UI, each confirmed on the phone (2026-11-10). Both wallets are the author's; there are still no external users.
- Contract is **unaudited**. Costs so far: ≈0.0000417 ETH gas for 17 txs; 1 WIF fee per account paid to the author's own wallet; about 1.5 USDT bridged (owner-stated).
- No private-repo or commercial customers exist; none are claimed.
- The browser DEMO is simulated and labelled so; mainnet receipts are shown only from real hashes above.

See [EVIDENCE.md](EVIDENCE.md) and the README for re-verification commands.
