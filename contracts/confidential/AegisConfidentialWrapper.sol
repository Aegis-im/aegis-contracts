// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {ERC7984Restricted} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984Restricted.sol";

import {IBlacklistSource} from "./interfaces/IBlacklistSource.sol";

/**
 * @dev Confidential (ERC-7984) wrapper over an Aegis ERC-20 with two policy layers:
 *
 * 1. Auditor visibility ("Aegis knows" model): a protocol-controlled auditor address is
 *    granted FHE ACL access to every transfer amount and every touched balance handle, so
 *    Aegis can reconstruct the confidential ledger off-chain. The public learns nothing.
 *    ACL grants are per-handle and irrevocable: rotating the auditor only affects future
 *    handles.
 *
 * 2. Blocklist mirror: anyone can copy the canonical YUSD blacklist status of an account
 *    into this wrapper via {syncRestriction}. The confidential layer can therefore never be
 *    permanently more permissive than canonical YUSD, without trusting an operator to sync.
 */
abstract contract AegisConfidentialWrapper is ZamaEthereumConfig, ERC7984ERC20Wrapper, ERC7984Restricted, Ownable2Step {
    IBlacklistSource public immutable blacklistSource;
    address public auditor;

    event AuditorChanged(address indexed oldAuditor, address indexed newAuditor);
    event RestrictionSynced(address indexed account, bool blocked);

    constructor(
        IERC20 underlying_,
        IBlacklistSource blacklistSource_,
        address auditor_,
        address owner_,
        string memory name_,
        string memory symbol_,
        string memory uri_
    ) ERC7984(name_, symbol_, uri_) ERC7984ERC20Wrapper(underlying_) Ownable(owner_) {
        blacklistSource = blacklistSource_;
        auditor = auditor_;
        emit AuditorChanged(address(0), auditor_);
    }

    /// @dev Sets the auditor. `address(0)` disables auditor visibility for future handles.
    function setAuditor(address newAuditor) external onlyOwner {
        emit AuditorChanged(auditor, newAuditor);
        auditor = newAuditor;
    }

    /**
     * @dev Grants the current auditor ACL access to the current balance handles of `accounts`
     * and the total supply handle. Permissionless: needed so a newly appointed auditor can be
     * backfilled on handles that predate its appointment.
     */
    function refreshAuditorAccess(address[] calldata accounts) external {
        address currentAuditor = auditor;
        require(currentAuditor != address(0), "AegisConfidentialWrapper: no auditor");
        for (uint256 i = 0; i < accounts.length; i++) {
            euint64 balance = confidentialBalanceOf(accounts[i]);
            if (FHE.isInitialized(balance)) {
                FHE.allow(balance, currentAuditor);
            }
        }
        euint64 supply = confidentialTotalSupply();
        if (FHE.isInitialized(supply)) {
            FHE.allow(supply, currentAuditor);
        }
    }

    /**
     * @dev Mirrors the canonical blacklist status of `account` into this wrapper.
     * Permissionless by design; the wrapper follows the canonical blacklist in both
     * directions (block and unblock).
     */
    function syncRestriction(address account) external {
        bool blocked = blacklistSource.isBlackListed(account);
        if (blocked) {
            _blockUser(account);
        } else {
            _resetUser(account);
        }
        emit RestrictionSynced(account, blocked);
    }

    /// @inheritdoc ERC7984ERC20Wrapper
    function decimals() public view virtual override(ERC7984, ERC7984ERC20Wrapper) returns (uint8) {
        return super.decimals();
    }

    /// @inheritdoc ERC7984ERC20Wrapper
    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC7984, ERC7984ERC20Wrapper) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /**
     * @dev Restriction checks run first (via ERC7984Restricted), then the wrapper supply
     * check and the actual balance update. Afterwards the auditor is granted access to the
     * transferred amount and every touched handle.
     */
    function _update(
        address from,
        address to,
        euint64 amount
    ) internal virtual override(ERC7984ERC20Wrapper, ERC7984Restricted) returns (euint64 transferred) {
        transferred = super._update(from, to, amount);

        address currentAuditor = auditor;
        if (currentAuditor != address(0)) {
            FHE.allow(transferred, currentAuditor);
            if (from != address(0)) {
                FHE.allow(confidentialBalanceOf(from), currentAuditor);
            }
            if (to != address(0)) {
                FHE.allow(confidentialBalanceOf(to), currentAuditor);
            }
            euint64 supply = confidentialTotalSupply();
            if (FHE.isInitialized(supply)) {
                FHE.allow(supply, currentAuditor);
            }
        }
    }
}
