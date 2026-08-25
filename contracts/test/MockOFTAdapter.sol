// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IOFT, SendParam, OFTLimit, OFTFeeDetail, OFTReceipt } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { MessagingReceipt, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockOFTAdapter is IOFT {
    address public immutable _token;
    uint256 public mockNativeFee = 0.01 ether;

    struct BridgeCall {
        uint32 dstEid;
        bytes32 to;
        uint256 amountLD;
        uint256 minAmountLD;
        bytes extraOptions;
        uint256 nativeFee;
    }

    BridgeCall[] public bridgeCalls;

    constructor(address token_) {
        _token = token_;
    }

    function setMockNativeFee(uint256 fee) external {
        mockNativeFee = fee;
    }

    function getBridgeCall(uint256 index) external view returns (BridgeCall memory) {
        return bridgeCalls[index];
    }

    function oftVersion() external pure override returns (bytes4, uint64) {
        return (bytes4(0x02e49c2c), 1);
    }

    function token() external view override returns (address) {
        return _token;
    }

    function approvalRequired() external pure override returns (bool) {
        return false;
    }

    function sharedDecimals() external pure override returns (uint8) {
        return 6;
    }

    function quoteOFT(
        SendParam calldata
    ) external pure override returns (OFTLimit memory limit, OFTFeeDetail[] memory feeDetails, OFTReceipt memory receipt) {
        limit = OFTLimit(0, type(uint256).max);
        feeDetails = new OFTFeeDetail[](0);
        receipt = OFTReceipt(0, 0);
    }

    function quoteSend(
        SendParam calldata,
        bool
    ) external view override returns (MessagingFee memory) {
        return MessagingFee(mockNativeFee, 0);
    }

    function send(
        SendParam calldata _sendParam,
        MessagingFee calldata _fee,
        address _refundAddress
    ) external payable override returns (MessagingReceipt memory receipt, OFTReceipt memory oftReceipt) {
        // Record the bridge call
        bridgeCalls.push(BridgeCall({
            dstEid: _sendParam.dstEid,
            to: _sendParam.to,
            amountLD: _sendParam.amountLD,
            minAmountLD: _sendParam.minAmountLD,
            extraOptions: _sendParam.extraOptions,
            nativeFee: msg.value
        }));

        // Transfer tokens from sender to this contract (simulating bridge lock)
        IERC20(_token).transferFrom(msg.sender, address(this), _sendParam.amountLD);

        // Refund excess ETH
        uint256 excess = msg.value - mockNativeFee;
        if (excess > 0) {
            (bool success, ) = _refundAddress.call{value: excess}("");
            require(success, "Refund failed");
        }

        receipt = MessagingReceipt(bytes32(0), 0, MessagingFee(mockNativeFee, 0));
        oftReceipt = OFTReceipt(_sendParam.amountLD, _sendParam.amountLD);
    }

    receive() external payable {}
}
