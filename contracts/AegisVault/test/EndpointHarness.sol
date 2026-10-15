// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import { MessagingParams, MessagingFee, MessagingReceipt, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
interface IMessageReceiver { function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData) external payable; }
/// @dev Test transport only; verifies the real OFT send/receive boundaries without a live DVN.
contract EndpointHarness {
    mapping(address => address) public delegates;
    uint64 public nonce;
    event Message(address sender, uint32 destination, bytes message);
    function setDelegate(address delegate) external { delegates[msg.sender] = delegate; }
    function lzToken() external pure returns (address) { return address(0); }
    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory) { return MessagingFee(0, 0); }
    function send(MessagingParams calldata params, address) external payable returns (MessagingReceipt memory) {
        emit Message(msg.sender, params.dstEid, params.message);
        return MessagingReceipt(keccak256(params.message), ++nonce, MessagingFee(0, 0));
    }
    function deliver(address receiver, Origin calldata origin, bytes calldata message) external {
        IMessageReceiver(receiver).lzReceive(origin, keccak256(message), message, msg.sender, "");
    }
}
