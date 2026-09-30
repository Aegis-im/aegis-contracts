import { expect } from 'chai'
import { ethers } from 'hardhat'
const e = ethers.parseEther, b32 = (a: string) => ethers.zeroPadValue(a, 32)
describe('AegisVault OFT transport integration', () => {
  it('burns on the home chain, credits remote tokens, returns them and rejects a forged peer', async () => {
    const [admin, user] = await ethers.getSigners()
    const token: any = await ethers.deployContract('VaultToken', ['Bank Dollar', 'BD', admin.address])
    const asset: any = await ethers.deployContract('TestToken', ['Cash', 'CASH', 6])
    const config: any = await ethers.deployContract('VaultConfig', [admin.address, [], admin.address])
    const oracle: any = await ethers.deployContract('VaultChainlinkOracleV3', ['BD / USD', 8, [], admin.address])
    const minting: any = await ethers.deployContract('VaultMinting', ['Bridge Test', token.target, config.target, ethers.ZeroAddress, oracle.target, ethers.ZeroAddress, admin.address, [asset.target], [86400], [admin.address], admin.address, 0, 86400])
    await token.setMinter(admin.address); await token.mint(user.address, e('10')); await token.setMinter(minting.target)
    const endpoint: any = await ethers.deployContract('EndpointHarness')
    const adapter: any = await ethers.deployContract('VaultMintBurnOFTAdapter', [token.target, minting.target, endpoint.target, admin.address])
    const remote: any = await ethers.deployContract('VaultOFT', ['Bank Dollar', 'BD', endpoint.target, admin.address])
    await minting.setCrossChainOperator(adapter.target)
    await adapter.setPeer(2, b32(remote.target)); await remote.setPeer(1, b32(adapter.target))
    await token.connect(user).approve(adapter.target, e('10'))
    const params = { dstEid: 2, to: b32(user.address), amountLD: e('10'), minAmountLD: e('10'), extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' }
    await adapter.connect(user).send(params, { nativeFee: 0, lzTokenFee: 0 }, user.address)
    expect(await token.totalSupply()).eq(0)
    const message = ethers.solidityPacked(['bytes32', 'uint64'], [b32(user.address), 10000000n])
    await expect(endpoint.deliver(remote.target, { srcEid: 1, sender: b32(user.address), nonce: 1 }, message)).reverted
    await endpoint.deliver(remote.target, { srcEid: 1, sender: b32(adapter.target), nonce: 1 }, message)
    expect(await remote.balanceOf(user.address)).eq(e('10'))
    await remote.connect(user).send({ ...params, dstEid: 1 }, { nativeFee: 0, lzTokenFee: 0 }, user.address)
    await endpoint.deliver(adapter.target, { srcEid: 2, sender: b32(remote.target), nonce: 2 }, message)
    expect(await remote.totalSupply()).eq(0); expect(await token.balanceOf(user.address)).eq(e('10'))
  })
})
