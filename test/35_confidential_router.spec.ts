import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { Fixture, ONE_CYUSD, ONE_YUSD, RATE, balanceAs, deployFixture, fhevmEnabled, mintYusd } from "./helpers/confidential";
import { StakeAndWrapRouter } from "../typechain-types";

describe("StakeAndWrapRouter", function () {
  let f: Fixture;
  let router: StakeAndWrapRouter;

  beforeEach(async function () {
    if (!fhevmEnabled || !fhevm.isMock) {
      this.skip();
    }
    f = await deployFixture();
    router = (await ethers.deployContract("StakeAndWrapRouter", [
      f.yusd.target,
      f.sYusd.target,
      f.csYusd.target,
    ])) as unknown as StakeAndWrapRouter;
    await mintYusd(f, f.alice, 2_000n * ONE_YUSD);
  });

  it("stakes and wraps in one transaction, matching the manual three-step result", async function () {
    await f.yusd.connect(f.alice).approve(router.target, 1_000n * ONE_YUSD);
    await router.connect(f.alice).stakeAndWrap(1_000n * ONE_YUSD, f.alice.address);

    expect(await balanceAs(f.csYusd, f.alice, f.alice)).to.equal(1_000n * ONE_CYUSD);
    expect(await f.yusd.balanceOf(f.alice.address)).to.equal(1_000n * ONE_YUSD);
    // No assets stranded on the router:
    expect(await f.yusd.balanceOf(router.target)).to.equal(0n);
    expect(await f.sYusd.balanceOf(router.target)).to.equal(0n);
  });

  it("returns sub-rate share dust to the receiver as plain sYUSD", async function () {
    // Donate to skew the share price so deposits produce non-round share amounts.
    await mintYusd(f, f.deployer, 100n * ONE_YUSD);
    await f.yusd.connect(f.deployer).approve(f.sYusd.target, 1n);
    await f.sYusd.connect(f.deployer).deposit(1n, f.deployer.address);
    await f.yusd.connect(f.deployer).transfer(f.sYusd.target, 7n * ONE_YUSD);

    await f.yusd.connect(f.alice).approve(router.target, 1_000n * ONE_YUSD);
    await router.connect(f.alice).stakeAndWrap(1_000n * ONE_YUSD, f.alice.address);

    const wrapped = await balanceAs(f.csYusd, f.alice, f.alice);
    const dust = await f.sYusd.balanceOf(f.alice.address);
    expect(dust).to.be.lessThan(RATE);
    // Wrapped shares + dust == everything the deposit produced; router keeps nothing.
    expect(await f.sYusd.balanceOf(f.csYusd.target)).to.equal(wrapped * RATE);
    expect(await f.sYusd.balanceOf(router.target)).to.equal(0n);
  });
});
