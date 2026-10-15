// Constructor args for manual verification fallback:
//   npx hardhat verify --network sepolia \
//     --contract contracts/JUSDAssetGuard.sol:JUSDAssetGuard \
//     --constructor-args jusd-asset-guard-args-sepolia.js <GUARD_ADDRESS>
// Keep in sync with config/JUSDGuard/sepolia.json.
module.exports = [
  "0x1FE05C75a8affb3889a3078dA7EcCc0805Dc727A", // _mintingAddress (AegisMintingJUSD)
  "0x8aF05B6Df31035aeBA506e7aFC40AF348cBE4AE1", // _admin (DEFAULT_ADMIN_ROLE)
  0,   // _initialDelay      (admin handover, seconds; changeable later)
  [],  // _destinations      (initial whitelist)
  [],  // _labels
  [],  // _assets            (address[][], per-destination asset lists)
  0,   // _whitelistCooldown (immutable)
  0,   // _mintingChangeDelay (immutable)
]
