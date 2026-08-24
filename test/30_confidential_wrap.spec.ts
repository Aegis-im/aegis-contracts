import { expect } from "chai";
import { fhevm } from "hardhat";

import {
  fhevmEnabled,
  Fixture,
  ONE_CYUSD,
  ONE_YUSD,
  RATE,
  balanceAs,
  deployFixture,
  mintYusd,
  unwrapAndFinalize,
  wrapAs,
} from "./helpers/confidential";

describe("cYUSD wrap/unwrap", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevmEnabled || !fhevm.isMock) {
      this.skip(); // requires FHEVM=1 (plugin + chainId 31337); mock environments only
    }
    f = await deployFixture();
    await mintYusd(f, f.alice, 1_000n * ONE_YUSD);
  });

  it("has 6 decimals and rate 1e12 over the 18-dec underlying", async function () {
    expect(await f.cYusd.decimals()).to.equal(6);
    expect(await f.cYusd.rate()).to.equal(RATE);
    expect(await f.cYusd.underlying()).to.equal(f.yusd.target);
  });

  it("wraps YUSD into a confidential balance", async function () {
    await wrapAs(f.cYusd, f.yusd, f.alice, 100n * ONE_YUSD);

    expect(await f.yusd.balanceOf(f.alice.address)).to.equal(900n * ONE_YUSD);
    expect(await f.yusd.balanceOf(f.cYusd.target)).to.equal(100n * ONE_YUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(100n * ONE_CYUSD);
  });

  it("rounds wrap amounts down to the nearest rate multiple, leaving dust with the user", async function () {
    const dust = 5n * 10n ** 11n; // half a rate unit
    await wrapAs(f.cYusd, f.yusd, f.alice, 100n * ONE_YUSD + dust);

    // Only the rounded amount is pulled: the sub-rate dust never leaves alice's wallet,
    // so she keeps exactly 1000 - 100 = 900 YUSD (not 900 minus dust).
    expect(await f.yusd.balanceOf(f.cYusd.target)).to.equal(100n * ONE_YUSD);
    expect(await f.yusd.balanceOf(f.alice.address)).to.equal(900n * ONE_YUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(100n * ONE_CYUSD);
  });

  it("mints zero for a wrap below the rate", async function () {
    await f.yusd.connect(f.alice).approve(f.cYusd.target, RATE - 1n);
    await f.cYusd.connect(f.alice).wrap(f.alice.address, RATE - 1n);

    expect(await f.yusd.balanceOf(f.cYusd.target)).to.equal(0n);
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(0n);
  });

  it("unwraps via the two-phase decryption flow", async function () {
    await wrapAs(f.cYusd, f.yusd, f.alice, 100n * ONE_YUSD);

    const { cleartext } = await unwrapAndFinalize(f.cYusd, f.alice, f.alice.address, 40n * ONE_CYUSD);

    expect(cleartext).to.equal(40n * ONE_CYUSD);
    expect(await f.yusd.balanceOf(f.alice.address)).to.equal(940n * ONE_YUSD);
    expect(await f.yusd.balanceOf(f.cYusd.target)).to.equal(60n * ONE_YUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(60n * ONE_CYUSD);
  });

  it("silently burns zero when unwrapping more than the balance", async function () {
    await wrapAs(f.cYusd, f.yusd, f.alice, 100n * ONE_YUSD);

    const { cleartext } = await unwrapAndFinalize(f.cYusd, f.alice, f.alice.address, 500n * ONE_CYUSD);

    // The over-balance burn moved 0; finalize pays out 0 — no value is created.
    expect(cleartext).to.equal(0n);
    expect(await f.yusd.balanceOf(f.alice.address)).to.equal(900n * ONE_YUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(100n * ONE_CYUSD);
  });
});
