// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MintBurnOFTAdapter } from "@layerzerolabs/oft-evm/contracts/MintBurnOFTAdapter.sol";
import { IMintableBurnable } from "@layerzerolabs/oft-evm/contracts/interfaces/IMintableBurnable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

interface IYUSD {
    function mint(address account, uint256 value) external;
    function burnFrom(address account, uint256 value) external;
}

/**
 * @title YUSDMintBurnOFTAdapter
 * @dev MintBurn OFT Adapter that directly interfaces with YUSD
 * This adapter directly calls mint/burn functions on YUSD token
 */
contract YUSDMintBurnOFTAdapter is MintBurnOFTAdapter, IMintableBurnable {
    
    IYUSD public immutable yusdToken;
    
    event YUSDCrossChainTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint32 chainId
    );

    error UnauthorizedCaller();

    /**
     * @dev Constructor for YUSDMintBurnOFTAdapter
     * @param _yusdToken Address of the existing YUSD token contract
     * @param _lzEndpoint Address of the LayerZero endpoint
     * @param _owner Address of the contract owner
     */
    constructor(
        address _yusdToken,
        address _lzEndpoint,
        address _owner
    ) MintBurnOFTAdapter(_yusdToken, IMintableBurnable(address(this)), _lzEndpoint, _owner) Ownable(_owner) {
        yusdToken = IYUSD(_yusdToken);
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) {
            revert UnauthorizedCaller();
        }
        _;
    }

    /**
     * @dev Burn tokens from a specific address
     * @param _from Address to burn tokens from
     * @param _amount Amount of tokens to burn
     * @return success True if burn was successful
     */
    function burn(address _from, uint256 _amount) external override onlySelf returns (bool) {
        yusdToken.burnFrom(_from, _amount);
        return true;
    }

    /**
     * @dev Mint tokens to a specific address
     * @param _to Address to mint tokens to
     * @param _amount Amount of tokens to mint
     * @return success True if mint was successful
     */
    function mint(address _to, uint256 _amount) external override onlySelf returns (bool) {
        yusdToken.mint(_to, _amount);
        return true;
    }

    /**
     * @dev Override _debit to add custom logic and events
     * @param _from Address to debit tokens from
     * @param _amountLD Amount to debit in local decimals
     * @param _minAmountLD Minimum amount in local decimals
     * @param _dstEid Destination endpoint ID
     * @return amountSentLD Amount sent in local decimals
     * @return amountReceivedLD Amount received in local decimals
     */
    function _debit(
        address _from,
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    ) internal override returns (uint256 amountSentLD, uint256 amountReceivedLD) {
        (amountSentLD, amountReceivedLD) = super._debit(_from, _amountLD, _minAmountLD, _dstEid);
        
        // Emit custom event for tracking
        emit YUSDCrossChainTransfer(_from, address(0), amountSentLD, _dstEid);
        
        return (amountSentLD, amountReceivedLD);
    }

    /**
     * @dev Override _credit to add custom logic and events
     * @param _to Address to credit tokens to
     * @param _amountLD Amount to credit in local decimals
     * @param _srcEid Source endpoint ID
     * @return amountReceivedLD Amount received in local decimals
     */
    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 _srcEid
    ) internal override returns (uint256 amountReceivedLD) {
        amountReceivedLD = super._credit(_to, _amountLD, _srcEid);
        
        // Emit custom event for tracking
        emit YUSDCrossChainTransfer(address(0), _to, amountReceivedLD, _srcEid);
        
        return amountReceivedLD;
    }
} 