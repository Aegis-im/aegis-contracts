import { expect } from "chai";
import { fhevm } from "hardhat";

import {
  fhevmEnabled,
  Fixture,
  ONE_CYUSD,
  ONE_YUSD,
  balanceAs,
  decryptAs,
  deployFixture,
  mintYusd,
  transferConfidential,
  transferredHandleOf,
  unwrapAndFinalize,
  wrapAs,
} from "./helpers/confidential";

describe("cYUSD auditor visibility (the 'Aegis knows' model)", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevmEnabled || !fhevm.isMock) {
      this.skip();
    }
    f = await deployFixture();
    await mintYusd(f, f.alice, 1_000n * ONE_YUSD);
    await wrapAs(f.cYusd, f.yusd, f.alice, 100n * ONE_YUSD);
  });

  it("lets the auditor decrypt any holder's balance without a grant from them", async function () {
    await transferConfidential(f.cYusd, f.alice, f.bob.address, 30n * ONE_CYUSD);

    expect(await balanceAs(f.cYusd, f.alice, f.auditor)).to.equal(70n * ONE_CYUSD);
    expect(await balanceAs(f.cYusd, f.bob, f.auditor)).to.equal(30n * ONE_CYUSD);
  });

  it("lets the auditor decrypt every transfer amount, including silent zeros", async function () {
    const tx1 = await transferConfidential(f.cYusd, f.alice, f.bob.address, 30n * ONE_CYUSD);
    const tx2 = await transferConfidential(f.cYusd, f.alice, f.bob.address, 500n * ONE_CYUSD); // over balance

    const handle1 = await transferredHandleOf(f.cYusd, tx1);
    const handle2 = await transferredHandleOf(f.cYusd, tx2);

    expect(await decryptAs(handle1, f.cYusd.target as string, f.auditor)).to.equal(30n * ONE_CYUSD);
    expect(await decryptAs(handle2, f.cYusd.target as string, f.auditor)).to.equal(0n);
  });

  it("lets the auditor see wrap and unwrap movements", async function () {
    expect(await balanceAs(f.cYusd, f.alice, f.auditor)).to.equal(100n * ONE_CYUSD);

    await unwrapAndFinalize(f.cYusd, f.alice, f.alice.address, 40n * ONE_CYUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.auditor)).to.equal(60n * ONE_CYUSD);
  });

  it("denies balance and amount decryption to third parties", async function () {
    const tx = await transferConfidential(f.cYusd, f.alice, f.bob.address, 30n * ONE_CYUSD);
    const amountHandle = await transferredHandleOf(f.cYusd, tx);

    await expect(balanceAs(f.cYusd, f.alice, f.eve)).to.be.rejected;
    await expect(balanceAs(f.cYusd, f.bob, f.eve)).to.be.rejected;
    await expect(decryptAs(amountHandle, f.cYusd.target as string, f.eve)).to.be.rejected;
  });

  it("scopes auditor rotation to future handles until refreshAuditorAccess backfills", async function () {
    await f.cYusd.connect(f.deployer).setAuditor(f.eve.address);

    // The new auditor cannot see handles created under the old auditor...
    await expect(balanceAs(f.cYusd, f.alice, f.eve)).to.be.rejected;

    // ...until a permissionless backfill grants them.
    await f.cYusd.connect(f.bob).refreshAuditorAccess([f.alice.address]);
    expect(await balanceAs(f.cYusd, f.alice, f.eve)).to.equal(100n * ONE_CYUSD);

    // Per-handle ACL grants are irrevocable: the OLD auditor still reads the OLD handle.
    expect(await balanceAs(f.cYusd, f.alice, f.auditor)).to.equal(100n * ONE_CYUSD);

    // New activity is visible to the new auditor and NOT to the old one.
    await transferConfidential(f.cYusd, f.alice, f.bob.address, 10n * ONE_CYUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.eve)).to.equal(90n * ONE_CYUSD);
    await expect(balanceAs(f.cYusd, f.alice, f.auditor)).to.be.rejected;
  });

  it("restricts setAuditor to the owner", async function () {
    await expect(f.cYusd.connect(f.eve).setAuditor(f.eve.address)).to.be.revertedWithCustomError(
      f.cYusd,
      "OwnableUnauthorizedAccount",
    );
  });

  it("reverts refreshAuditorAccess when no auditor is set", async function () {
    await f.cYusd.connect(f.deployer).setAuditor(f.deployer.address);
    await f.cYusd.connect(f.deployer).setAuditor("0x0000000000000000000000000000000000000000");
    await expect(f.cYusd.refreshAuditorAccess([f.alice.address])).to.be.revertedWith(
      "AegisConfidentialWrapper: no auditor",
    );
  });
});
