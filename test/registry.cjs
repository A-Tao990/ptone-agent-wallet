const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const E = (n) => ethers.parseEther(String(n));

describe("AgentRegistry (atomic execute)", () => {
  let wif, tok, reg, owner, sink, bob, eve, exec;
  const id = (s) => ethers.id(s);
  beforeEach(async () => {
    [owner, sink, bob, eve, exec] = await ethers.getSigners();
    const M = await ethers.getContractFactory("MockERC20");
    wif = await M.deploy("MockWIF", "mWIF", 18); tok = await M.deploy("MockUSD", "mUSD", 18);
    reg = await (await ethers.getContractFactory("AgentRegistry")).deploy(await wif.getAddress(), E(10), sink.address);
    await wif.mint(owner.address, E(100)); await tok.mint(owner.address, E(100));
  });
  async function policy(recipients, { executor = ethers.ZeroAddress, expiryOff = 3600, approve = 8 } = {}) {
    await reg.setPolicy(await tok.getAddress(), E(5), E(8), (await time.latest()) + expiryOff, executor, recipients);
    await tok.approve(await reg.getAddress(), E(approve));
  }
  async function onboard(opts) {
    await wif.approve(await reg.getAddress(), E(10)); await reg.register();
    await policy([bob.address], opts);
  }
  const T = () => tok.getAddress();
  it("charges exact WIF fee, fee separate from principal", async () => {
    await onboard();
    expect(await wif.balanceOf(sink.address)).to.equal(E(10));
    expect(await wif.balanceOf(owner.address)).to.equal(E(90));
    expect(await tok.balanceOf(owner.address)).to.equal(E(100)); // principal untouched until execute
  });
  it("fails to register without allowance / twice", async () => {
    await expect(reg.register()).to.be.revertedWith("transfer");
    await onboard();
    await expect(reg.register()).to.be.revertedWith("registered");
  });
  it("execute moves exactly the bound amount to the bound recipient atomically", async () => {
    await onboard();
    await expect(reg.execute(owner.address, id("a"), await T(), bob.address, E(5))).to.emit(reg, "Executed");
    expect(await tok.balanceOf(bob.address)).to.equal(E(5));
    expect(await tok.balanceOf(owner.address)).to.equal(E(95));
    expect((await reg.policies(owner.address)).spent).to.equal(E(5));
  });
  it("blocks over per-tx, over total, non-allowlisted; no funds move on revert", async () => {
    await onboard(); const t = await T();
    await expect(reg.execute(owner.address, id("b"), t, bob.address, E(6))).to.be.revertedWith("perTx");
    await expect(reg.execute(owner.address, id("e"), t, eve.address, E(1))).to.be.revertedWith("recipient");
    await reg.execute(owner.address, id("c1"), t, bob.address, E(5));
    await expect(reg.execute(owner.address, id("c2"), t, bob.address, E(4))).to.be.revertedWith("total");
    await reg.execute(owner.address, id("c3"), t, bob.address, E(3));
    expect(await tok.balanceOf(eve.address)).to.equal(0n);
    expect(await tok.balanceOf(bob.address)).to.equal(E(8));
  });
  it("same nonce replay blocked (even with different amount/recipient); new nonce with same amount allowed", async () => {
    await onboard(); const t = await T();
    await reg.execute(owner.address, id("n1"), t, bob.address, E(2));
    await expect(reg.execute(owner.address, id("n1"), t, bob.address, E(2))).to.be.revertedWith("replay");
    await expect(reg.execute(owner.address, id("n1"), t, bob.address, E(1))).to.be.revertedWith("replay");
    await reg.execute(owner.address, id("n2"), t, bob.address, E(2)); // independent identical transfer
    expect(await tok.balanceOf(bob.address)).to.equal(E(4));
  });
  it("token transfer failure reverts everything: spent and nonce unchanged, retry with SAME nonce works after fix", async () => {
    await onboard({ approve: 1 }); const t = await T(); // allowance only 1 < amount
    await expect(reg.execute(owner.address, id("f1"), t, bob.address, E(3))).to.be.revertedWith("transfer");
    expect((await reg.policies(owner.address)).spent).to.equal(0n);
    expect(await reg.used(owner.address, id("f1"))).to.equal(false);
    expect(await tok.balanceOf(bob.address)).to.equal(0n);
    await tok.approve(await reg.getAddress(), E(8));
    await reg.execute(owner.address, id("f1"), t, bob.address, E(3)); // same nonce now ok
    expect((await reg.policies(owner.address)).spent).to.equal(E(3));
    // insufficient balance also reverts atomically
    await tok.transfer(eve.address, E(97));
    await expect(reg.execute(owner.address, id("f2"), t, bob.address, E(3))).to.be.revertedWith("transfer");
    expect((await reg.policies(owner.address)).spent).to.equal(E(3));
  });
  it("wrong token / expiry / stranger caller / revoke blocked", async () => {
    await onboard(); const t = await T();
    await expect(reg.execute(owner.address, id("x"), await wif.getAddress(), bob.address, E(1))).to.be.revertedWith("token");
    await expect(reg.connect(eve).execute(owner.address, id("x"), t, bob.address, E(1))).to.be.revertedWith("caller");
    await reg.revoke();
    await expect(reg.execute(owner.address, id("y"), t, bob.address, E(1))).to.be.revertedWith("inactive");
  });
  it("expired policy blocks", async () => {
    await onboard(); await time.increase(4000);
    await expect(reg.execute(owner.address, id("x"), await T(), bob.address, E(1))).to.be.revertedWith("expired");
  });
  it("old policy allowlist is cleared by a new policy (versioned)", async () => {
    await onboard(); const t = await T();
    expect(await reg.isAllowed(owner.address, bob.address)).to.equal(true);
    await policy([eve.address]); // new version, bob not included
    expect(await reg.isAllowed(owner.address, bob.address)).to.equal(false);
    await expect(reg.execute(owner.address, id("o1"), t, bob.address, E(1))).to.be.revertedWith("recipient");
    await reg.execute(owner.address, id("o2"), t, eve.address, E(1));
    // revoke then re-set with empty list: nobody allowed
    await reg.revoke(); await policy([]);
    expect(await reg.isAllowed(owner.address, eve.address)).to.equal(false);
    // setRecipient only edits the current version
    await reg.setRecipient(bob.address, true);
    await reg.execute(owner.address, id("o3"), t, bob.address, E(1));
  });
  it("executor is bound by the same policy; revoke stops it", async () => {
    await onboard({ executor: exec.address }); const t = await T();
    await reg.connect(exec).execute(owner.address, id("e1"), t, bob.address, E(2));
    await expect(reg.connect(exec).execute(owner.address, id("e2"), t, eve.address, E(1))).to.be.revertedWith("recipient");
    await expect(reg.connect(exec).execute(owner.address, id("e3"), t, bob.address, E(9))).to.be.revertedWith("perTx");
    await reg.revoke();
    await expect(reg.connect(exec).execute(owner.address, id("e4"), t, bob.address, E(1))).to.be.revertedWith("inactive");
  });
  it("non-18-decimals token works with base-unit caps", async () => {
    const M = await ethers.getContractFactory("MockERC20");
    const t6 = await M.deploy("U6", "U6", 6);
    expect(await t6.decimals()).to.equal(6n); // what the frontend reads via decimals()
    await t6.mint(owner.address, 1_000_000_000n);
    await wif.approve(await reg.getAddress(), E(10)); await reg.register();
    await reg.setPolicy(await t6.getAddress(), 5_000_000n, 8_000_000n, (await time.latest()) + 100, ethers.ZeroAddress, [bob.address]);
    await t6.approve(await reg.getAddress(), 8_000_000n);
    await reg.execute(owner.address, id("d"), await t6.getAddress(), bob.address, 5_000_000n);
    await expect(reg.execute(owner.address, id("d2"), await t6.getAddress(), bob.address, 5_000_001n)).to.be.revertedWith("perTx");
  });
  it("rejects bad policy params", async () => {
    await wif.approve(await reg.getAddress(), E(10)); await reg.register();
    const exp = (await time.latest()) + 100, z = ethers.ZeroAddress;
    await expect(reg.setPolicy(wif.target, 0, E(1), exp, z, [])).to.be.revertedWith("caps");
    await expect(reg.setPolicy(wif.target, E(2), E(1), exp, z, [])).to.be.revertedWith("caps");
    await expect(reg.setPolicy(wif.target, E(1), E(1), 1, z, [])).to.be.revertedWith("expiry");
    await expect(reg.setPolicy(bob.address, E(1), E(1), exp, z, [])).to.be.revertedWith("token");
  });

  describe("ERC20 optional-return compatibility (SafeERC20-style)", () => {
    it("register(): token returning false reverts 'transfer', registered stays false", async () => {
      const bad = await (await ethers.getContractFactory("MockFalseToken")).deploy();
      const r = await (await ethers.getContractFactory("AgentRegistry")).deploy(await bad.getAddress(), E(1), sink.address);
      await expect(r.register()).to.be.revertedWith("transfer");
      expect(await r.registered(owner.address)).to.equal(false);
    });
    it("execute(): token returning false reverts atomically (nonce + spent untouched)", async () => {
      const bad = await (await ethers.getContractFactory("MockFalseToken")).deploy();
      await wif.approve(await reg.getAddress(), E(10)); await reg.register();
      await reg.setPolicy(await bad.getAddress(), E(5), E(8), (await time.latest()) + 3600, ethers.ZeroAddress, [bob.address]);
      await expect(reg.execute(owner.address, id("f"), await bad.getAddress(), bob.address, E(1))).to.be.revertedWith("transfer");
      expect(await reg.used(owner.address, id("f"))).to.equal(false);
      expect((await reg.policies(owner.address))[3]).to.equal(0n);
    });
    it("no-return token (USDT-style) works for register and execute", async () => {
      const nr = await (await ethers.getContractFactory("MockNoReturnToken")).deploy();
      const r = await (await ethers.getContractFactory("AgentRegistry")).deploy(await nr.getAddress(), 5n, sink.address);
      await nr.mint(owner.address, 100n); await nr.approve(await r.getAddress(), 50n);
      await r.register(); expect(await nr.balanceOf(sink.address)).to.equal(5n);
      await r.setPolicy(await nr.getAddress(), 10n, 20n, (await time.latest()) + 3600, ethers.ZeroAddress, [bob.address]);
      await r.execute(owner.address, id("n"), await nr.getAddress(), bob.address, 10n);
      expect(await nr.balanceOf(bob.address)).to.equal(10n);
    });
    it("constructor rejects EOA/zero-code WIF and zero feeSink; EOA token cannot silently 'succeed'", async () => {
      const F = await ethers.getContractFactory("AgentRegistry");
      await expect(F.deploy(bob.address, 1n, sink.address)).to.be.revertedWith("wif code");
      await expect(F.deploy(await wif.getAddress(), 1n, ethers.ZeroAddress)).to.be.revertedWith("sink");
    });
  });
});
