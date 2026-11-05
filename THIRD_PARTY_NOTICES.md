# Third-party notices

The MIT license in `LICENSE` covers the original code in this repository, written by John Tao
(`src/`, `contracts/`, `test/`, `scripts/`, docs).

This repository **does not vendor or copy any third-party source code**. Third-party packages are
installed from npm via `package.json` / `package-lock.json` and keep their own licenses and copyright
notices (found in each package under `node_modules/<pkg>/` after `npm ci`; the lockfile pins exact versions).
Direct dependencies: `viem`, `vite`, `vitest`, `typescript`, `hardhat` + `@nomicfoundation/hardhat-toolbox`,
`@okxconnect/ui`, `@okxconnect/universal-provider`. Run `npm ls --all` for the full tree.

`contracts/MockERC20.sol` is a small local test token written for this project; it is never deployed publicly.

Names such as Robinhood, Binance, OKX and WIF belong to their respective owners. This project is independent and
not affiliated with or endorsed by them.
