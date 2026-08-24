import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  fhevmEnabled,
  Fixture,
  ONE_CYUSD,
  ONE_YUSD,
  balanceAs,
  deployFixture,
  encryptAmount,
  mintYusd,
  transferConfidential,
  wrapAs,
} from "./helpers/confidential";

describe("cYUSD blocklist mirror", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevmEnabled || !fhevm.isMock) {
      this.skip();
    }
    f = await deployFixture();
    await mintYusd(f, f.alice, 1_000n * ONE_YUSD);
    await mintYusd(f, f.bob, 1_000n * ONE_YUSD);
    await wrapAs(f.cYusd, f.yusd, f.alice, 100n * ONE_YUSD);
    await wrapAs(f.cYusd, f.yusd, f.bob, 100n * ONE_YUSD);
  });

  it("blocks a synced blacklisted account from sending and receiving", async function () {
    await f.yusd.connect(f.deployer).addBlackList(f.bob.address);
    await f.cYusd.connect(f.eve).syncRestriction(f.bob.address); // permissionless

    await expect(transferConfidential(f.cYusd, f.bob, f.alice.address, ONE_CYUSD)).to.be.revertedWithCustomError(
      f.cYusd,
      "UserRestricted",
    );
    await expect(transferConfidential(f.cYusd, f.alice, f.bob.address, ONE_CYUSD)).to.be.revertedWithCustomError(
      f.cYusd,
      "UserRestricted",
    );
  });

  it("blocks wrap and unwrap for a synced blacklisted account", async function () {
    await f.yusd.connect(f.deployer).addBlackList(f.bob.address);
    await f.cYusd.syncRestriction(f.bob.address);

    // Wrap reverts on the canonical side first: YUSD itself refuses to move bob's tokens
    // into the wrapper (the wrapper's own mint restriction is a second line of defense).
    await f.yusd.connect(f.bob).approve(f.cYusd.target, ONE_YUSD);
    await expect(f.cYusd.connect(f.bob).wrap(f.bob.address, ONE_YUSD)).to.be.revertedWithCustomError(
      f.yusd,
      "Blacklisted",
    );

    // Unwrap reverts at the burn:
    const enc = await encryptAmount(f.cYusd.target as string, f.bob, ONE_CYUSD);
    await expect(
      f.cYusd
        .connect(f.bob)
        ["unwrap(address,address,bytes32,bytes)"](f.bob.address, f.bob.address, enc.handles[0], enc.inputProof),
    ).to.be.revertedWithCustomError(f.cYusd, "UserRestricted");
  });

  it("unblocks after removal from the canonical blacklist plus sync", async function () {
    await f.yusd.connect(f.deployer).addBlackList(f.bob.address);
    await f.cYusd.syncRestriction(f.bob.address);
    await f.yusd.connect(f.deployer).removeBlackList(f.bob.address);
    await f.cYusd.syncRestriction(f.bob.address);

    await transferConfidential(f.cYusd, f.bob, f.alice.address, 10n * ONE_CYUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(110n * ONE_CYUSD);
  });

  it("documents the lazy-mirror window: an unsynced blacklisted account can still move cYUSD", async function () {
    await f.yusd.connect(f.deployer).addBlackList(f.bob.address);
    // No syncRestriction call: canonical YUSD blocks bob, but the wrapper does not know yet.
    await transferConfidential(f.cYusd, f.bob, f.alice.address, 10n * ONE_CYUSD);
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(110n * ONE_CYUSD);
    // Production mitigation: a bot syncs on the canonical AddedBlackList event.
  });

  it("freezes the whole confidential layer when canonical YUSD blacklists the wrapper itself", async function () {
    await f.yusd.connect(f.deployer).addBlackList(f.cYusd.target);

    // Wrapping is blocked: the underlying transfer INTO the wrapper reverts on YUSD's side.
    await f.yusd.connect(f.alice).approve(f.cYusd.target, ONE_YUSD);
    await expect(f.cYusd.connect(f.alice).wrap(f.alice.address, ONE_YUSD)).to.be.revertedWithCustomError(
      f.yusd,
      "Blacklisted",
    );

    // Unwrap request succeeds (burn is internal), but finalize cannot pay out...
    const enc = await encryptAmount(f.cYusd.target as string, f.alice, 40n * ONE_CYUSD);
    const tx = await f.cYusd
      .connect(f.alice)
      ["unwrap(address,address,bytes32,bytes)"](f.alice.address, f.alice.address, enc.handles[0], enc.inputProof);
    const receipt = (await tx.wait())!;
    const parsed = receipt.logs
      .map((log) => {
        try {
          return f.cYusd.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "UnwrapRequested")!;
    const requestId = parsed.args.unwrapRequestId as string;

    const { clearValues, decryptionProof } = await fhevm.publicDecrypt([requestId]);
    const cleartext = clearValues[requestId as `0x${string}`] as bigint;
    await expect(f.cYusd.finalizeUnwrap(requestId, cleartext, decryptionProof)).to.be.revertedWithCustomError(
      f.yusd,
      "Blacklisted",
    );

    // ...while internal confidential transfers still work:
    await transferConfidential(f.cYusd, f.alice, f.bob.address, ONE_CYUSD);

    // Un-blacklisting makes the SAME pending finalize succeed: the flow is retriable,
    // so funds in the two-phase gap are delayed, not lost.
    await f.yusd.connect(f.deployer).removeBlackList(f.cYusd.target);
    await f.cYusd.finalizeUnwrap(requestId, cleartext, decryptionProof);
    expect(await f.yusd.balanceOf(f.alice.address)).to.equal(940n * ONE_YUSD);
  });

  it("emits RestrictionSynced with the mirrored status", async function () {
    await f.yusd.connect(f.deployer).addBlackList(f.bob.address);
    await expect(f.cYusd.syncRestriction(f.bob.address))
      .to.emit(f.cYusd, "RestrictionSynced")
      .withArgs(f.bob.address, true);
    await expect(f.cYusd.syncRestriction(f.alice.address))
      .to.emit(f.cYusd, "RestrictionSynced")
      .withArgs(f.alice.address, false);
  });
});
