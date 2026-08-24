import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";

/**
 * Confidential (ERC-7984 / Zama FHEVM) specs run only with the FHEVM plugin loaded:
 *   FHEVM=1 npx hardhat test test/3*_confidential_*.spec.ts
 * Without it (regular `yarn test`), every confidential spec self-skips.
 */
export const fhevmEnabled = !!process.env.FHEVM && !!(fhevm as unknown);


import { ConfidentialStakedYUSD, ConfidentialYUSD, SimSYUSD, YUSD } from "../../typechain-types";

export const RATE = 10n ** 12n; // 18-dec underlying -> 6-dec wrapper
export const ONE_YUSD = 10n ** 18n;
export const ONE_CYUSD = 10n ** 6n;

export interface Fixture {
  deployer: HardhatEthersSigner;
  auditor: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  eve: HardhatEthersSigner;
  yusd: YUSD;
  sYusd: SimSYUSD;
  cYusd: ConfidentialYUSD;
  csYusd: ConfidentialStakedYUSD;
}

export async function deployFixture(): Promise<Fixture> {
  const [deployer, auditor, alice, bob, eve] = await ethers.getSigners();

  const yusd = (await ethers.deployContract("YUSD", [deployer.address])) as unknown as YUSD;
  await yusd.setMinter(deployer.address);

  const sYusd = (await ethers.deployContract("SimSYUSD", [yusd.target])) as unknown as SimSYUSD;

  const cYusd = (await ethers.deployContract("ConfidentialYUSD", [
    yusd.target,
    auditor.address,
    deployer.address,
  ])) as unknown as ConfidentialYUSD;

  const csYusd = (await ethers.deployContract("ConfidentialStakedYUSD", [
    sYusd.target,
    yusd.target,
    auditor.address,
    deployer.address,
  ])) as unknown as ConfidentialStakedYUSD;

  return { deployer, auditor, alice, bob, eve, yusd, sYusd, cYusd, csYusd };
}

/** Mints plain YUSD (deployer is the local minter). */
export async function mintYusd(f: Fixture, to: HardhatEthersSigner, amount: bigint) {
  await f.yusd.connect(f.deployer).mint(to.address, amount);
}

/** Approves and wraps `amount` of the wrapper's underlying for `user`. */
export async function wrapAs(
  wrapper: ConfidentialYUSD | ConfidentialStakedYUSD,
  underlying: YUSD | SimSYUSD,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  await underlying.connect(user).approve(wrapper.target, amount);
  await wrapper.connect(user).wrap(user.address, amount);
}

/** Encrypts `amount` as an external euint64 input for (`contract`, `user`). */
export async function encryptAmount(contractAddress: string, user: HardhatEthersSigner, amount: bigint) {
  const input = fhevm.createEncryptedInput(contractAddress, user.address);
  input.add64(amount);
  return input.encrypt();
}

/** Decrypts an euint64 handle as `user` (throws if the ACL does not allow it). */
export async function decryptAs(
  handle: string,
  contractAddress: string,
  user: HardhatEthersSigner,
): Promise<bigint> {
  // Lazy require: importing the plugin package at module load registers provider hooks
  // and breaks non-FHEVM test runs. Under FHEVM=1 the module is already loaded (cached).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { FhevmType } = require("@fhevm/hardhat-plugin");
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddress, user);
}

/** Decrypts `user`'s confidential balance as `viewer`. */
export async function balanceAs(
  wrapper: ConfidentialYUSD | ConfidentialStakedYUSD,
  user: HardhatEthersSigner,
  viewer: HardhatEthersSigner,
): Promise<bigint> {
  const handle = await wrapper.confidentialBalanceOf(user.address);
  return decryptAs(handle, wrapper.target as string, viewer);
}

/** Confidential transfer of `amount` from `from` to `to`. */
export async function transferConfidential(
  wrapper: ConfidentialYUSD | ConfidentialStakedYUSD,
  from: HardhatEthersSigner,
  to: string,
  amount: bigint,
) {
  const enc = await encryptAmount(wrapper.target as string, from, amount);
  return wrapper.connect(from)["confidentialTransfer(address,bytes32,bytes)"](to, enc.handles[0], enc.inputProof);
}

/** Runs the full two-phase unwrap: request, public decryption, finalize. */
export async function unwrapAndFinalize(
  wrapper: ConfidentialYUSD | ConfidentialStakedYUSD,
  user: HardhatEthersSigner,
  to: string,
  amount: bigint,
) {
  const enc = await encryptAmount(wrapper.target as string, user, amount);
  const tx = await wrapper
    .connect(user)
    ["unwrap(address,address,bytes32,bytes)"](user.address, to, enc.handles[0], enc.inputProof);
  const receipt = (await tx.wait())!;

  const requestedLog = receipt.logs
    .map((log) => {
      try {
        return wrapper.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "UnwrapRequested");
  if (!requestedLog) throw new Error("UnwrapRequested event not found");
  const unwrapRequestId = requestedLog.args.unwrapRequestId as string;

  const { clearValues, decryptionProof } = await fhevm.publicDecrypt([unwrapRequestId]);
  const cleartext = clearValues[unwrapRequestId] as bigint;

  await wrapper.finalizeUnwrap(unwrapRequestId, cleartext, decryptionProof);
  return { unwrapRequestId, cleartext };
}

/** Extracts the transferred-amount handle from a confidential transfer receipt. */
export async function transferredHandleOf(
  wrapper: ConfidentialYUSD | ConfidentialStakedYUSD,
  txResponse: Awaited<ReturnType<typeof transferConfidential>>,
): Promise<string> {
  const receipt = (await txResponse.wait())!;
  const parsed = receipt.logs
    .map((log) => {
      try {
        return wrapper.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "ConfidentialTransfer");
  if (!parsed) throw new Error("ConfidentialTransfer event not found");
  return parsed.args.amount as string;
}
