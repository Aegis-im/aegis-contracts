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
  transferredHandleOf,
  decryptAs,
  wrapAs,
} from "./helpers/confidential";

describe("cYUSD confidential transfers", function () {
  let f: Fixture;

  beforeEach(async function () {
    if (!fhevmEnabled || !fhevm.isMock) {
      this.skip();
    }
    f = await deployFixture();
    await mintYusd(f, f.alice, 1_000n * ONE_YUSD);
    await wrapAs(f.cYusd, f.yusd, f.alice, 100n * ONE_YUSD);
  });

  it("transfers between holders; the event carries a handle, not an amount", async function () {
    const tx = await transferConfidential(f.cYusd, f.alice, f.bob.address, 30n * ONE_CYUSD);

    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(70n * ONE_CYUSD);
    expect(await balanceAs(f.cYusd, f.bob, f.bob)).to.equal(30n * ONE_CYUSD);

    const handle = await transferredHandleOf(f.cYusd, tx);
    expect(ethers.dataLength(handle)).to.equal(32); // a ciphertext handle, not a cleartext amount
  });

  it("silently transfers zero when the amount exceeds the balance", async function () {
    const tx = await transferConfidential(f.cYusd, f.alice, f.bob.address, 500n * ONE_CYUSD);

    // Transaction succeeds — balances are unchanged, and only the handle reveals the 0.
    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(100n * ONE_CYUSD);
    const handle = await transferredHandleOf(f.cYusd, tx);
    expect(await decryptAs(handle, f.cYusd.target as string, f.alice)).to.equal(0n);
  });

  it("supports time-boxed operators", async function () {
    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    await f.cYusd.connect(f.alice).setOperator(f.bob.address, until);
    expect(await f.cYusd.isOperator(f.alice.address, f.bob.address)).to.equal(true);

    const enc = await encryptAmount(f.cYusd.target as string, f.bob, 25n * ONE_CYUSD);
    await f.cYusd
      .connect(f.bob)
      ["confidentialTransferFrom(address,address,bytes32,bytes)"](
        f.alice.address,
        f.bob.address,
        enc.handles[0],
        enc.inputProof,
      );

    expect(await balanceAs(f.cYusd, f.alice, f.alice)).to.equal(75n * ONE_CYUSD);
    expect(await balanceAs(f.cYusd, f.bob, f.bob)).to.equal(25n * ONE_CYUSD);
  });

  it("rejects a non-operator transferFrom", async function () {
    const enc = await encryptAmount(f.cYusd.target as string, f.eve, ONE_CYUSD);
    await expect(
      f.cYusd
        .connect(f.eve)
        ["confidentialTransferFrom(address,address,bytes32,bytes)"](
          f.alice.address,
          f.eve.address,
          enc.handles[0],
          enc.inputProof,
        ),
    ).to.be.revertedWithCustomError(f.cYusd, "ERC7984UnauthorizedSpender");
  });
});
