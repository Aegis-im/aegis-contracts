import { expect } from "chai";
import { fhevm } from "hardhat";

import {
  fhevmEnabled,
  Fixture,
  ONE_CYUSD,
  ONE_YUSD,
  balanceAs,
  deployFixture,
  mintYusd,
  unwrapAndFinalize,
  wrapAs,
} from "./helpers/confidential";

/**
 * The load-bearing design point of the PoC: csYUSD needs NO yield mechanics and NO backend
 * changes. Yield reaches confidential holders purely through the public sYUSD share price,
 * exactly as production distributes rewards (a plain YUSD transfer into the vault).
 */
describe("csYUSD yield accrual via public share price", function () {
  let f: Fixture;

  async function stakeAndWrap(user: (typeof f)["alice"], yusdAmount: bigint): Promise<bigint> {
    await f.yusd.connect(user).approve(f.sYusd.target, yusdAmount);
    await f.sYusd.connect(user).deposit(yusdAmount, user.address);
    const shares = await f.sYusd.balanceOf(user.address);
    await wrapAs(f.csYusd, f.sYusd, user, shares);
    return shares;
  }

  beforeEach(async function () {
    if (!fhevmEnabled || !fhevm.isMock) {
      this.skip();
    }
    f = await deployFixture();
    await mintYusd(f, f.alice, 2_000n * ONE_YUSD);
    await mintYusd(f, f.bob, 2_000n * ONE_YUSD);
    await mintYusd(f, f.deployer, 10_000n * ONE_YUSD); // rewards budget
  });

  it("keeps the encrypted balance constant while the unit value rises", async function () {
    await stakeAndWrap(f.alice, 1_000n * ONE_YUSD);
    expect(await balanceAs(f.csYusd, f.alice, f.alice)).to.equal(1_000n * ONE_CYUSD);

    const priceBefore = await f.sYusd.convertToAssets(ONE_YUSD);

    // Production rewards mechanics: AegisRewardsV2.sendToStaking == plain YUSD donation.
    await f.yusd.connect(f.deployer).transfer(f.sYusd.target, 100n * ONE_YUSD);

    const priceAfter = await f.sYusd.convertToAssets(ONE_YUSD);
    expect(priceAfter).to.be.greaterThan(priceBefore);

    // The confidential balance is untouched — the yield lives in the public share price.
    expect(await balanceAs(f.csYusd, f.alice, f.alice)).to.equal(1_000n * ONE_CYUSD);
  });

  it("realizes yield on unwrap + redeem", async function () {
    const shares = await stakeAndWrap(f.alice, 1_000n * ONE_YUSD);
    await f.yusd.connect(f.deployer).transfer(f.sYusd.target, 100n * ONE_YUSD);

    // Unwrap all csYUSD back to sYUSD shares (modulo sub-rate dust) and redeem.
    const wrapped = shares - (shares % (10n ** 12n));
    await unwrapAndFinalize(f.csYusd, f.alice, f.alice.address, wrapped / 10n ** 12n);
    const sharesBack = await f.sYusd.balanceOf(f.alice.address);
    await f.sYusd.connect(f.alice).redeem(sharesBack, f.alice.address, f.alice.address);

    // 1000 staked + ~100 donated (alice is the only staker; ERC4626 virtual-share offset
    // keeps a dust remainder in the vault).
    const finalYusd = await f.yusd.balanceOf(f.alice.address);
    expect(finalYusd).to.be.greaterThan(2_099n * ONE_YUSD);
    expect(finalYusd).to.be.lessThanOrEqual(2_100n * ONE_YUSD);
  });

  it("accrues proportionally for holders with different entry prices", async function () {
    await stakeAndWrap(f.alice, 1_000n * ONE_YUSD);
    await f.yusd.connect(f.deployer).transfer(f.sYusd.target, 100n * ONE_YUSD); // alice-only round

    const bobShares = await (async () => {
      await f.yusd.connect(f.bob).approve(f.sYusd.target, 1_000n * ONE_YUSD);
      await f.sYusd.connect(f.bob).deposit(1_000n * ONE_YUSD, f.bob.address);
      const s = await f.sYusd.balanceOf(f.bob.address);
      await wrapAs(f.csYusd, f.sYusd, f.bob, s);
      return s;
    })();

    // Bob entered at a higher share price, so his encrypted share count is lower.
    const bobBalance = await balanceAs(f.csYusd, f.bob, f.bob);
    const aliceBalance = await balanceAs(f.csYusd, f.alice, f.alice);
    expect(bobBalance).to.be.lessThan(aliceBalance);
    expect(bobBalance).to.equal(bobShares / 10n ** 12n);

    // A second donation accrues to both, proportional to share counts, without any
    // confidential-layer state change:
    await f.yusd.connect(f.deployer).transfer(f.sYusd.target, 200n * ONE_YUSD);
    expect(await balanceAs(f.csYusd, f.alice, f.alice)).to.equal(aliceBalance);
    expect(await balanceAs(f.csYusd, f.bob, f.bob)).to.equal(bobBalance);
  });
});
