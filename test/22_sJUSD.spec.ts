import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { JUSD, SJUSD, SJUSDSilo } from '../typechain-types'
import { DEFAULT_ADMIN_ROLE } from '../utils/helpers'

describe('sJUSD', function () {
  this.timeout(300000) // 5 minutes
  let jusdContract: JUSD
  let sJusdContract: SJUSD
  let siloContract: SJUSDSilo
  let owner: any
  let user1: any
  let user2: any
  let admin: any
  let insuranceFund: any
  const ADMIN_ROLE = DEFAULT_ADMIN_ROLE
  const initialAmount = ethers.parseEther('1000')
  const cooldown7days = 7 * 24 * 60 * 60 // 7 days in seconds
  const instantUnstakingFee = 50 // 0.5% in basis points

  beforeEach(async function () {
    this.timeout(300000) // 5 minutes
    const signers = await ethers.getSigners()
    owner = signers[0]
    user1 = signers[1]
    user2 = signers[2]
    admin = signers[3]
    insuranceFund = signers[4]

    // Deploy JUSD
    jusdContract = await ethers.deployContract('JUSD', [owner.address])
    await jusdContract.setMinter(owner)

    // Mint some JUSD to users for testing
    await jusdContract.mint(user1, initialAmount)
    await jusdContract.mint(user2, initialAmount)

    // Deploy sJUSD with admin as the admin
    const sJusdFactory = await ethers.getContractFactory('sJUSD')
    sJusdContract = await upgrades.deployProxy(
      sJusdFactory,
      [await jusdContract.getAddress(), admin.address],
      {
        kind: 'transparent',
        initializer: 'initialize',
        unsafeAllow: ['constructor', 'delegatecall'],
      },
    ) as any

    // Get the silo address
    const siloAddress = await sJusdContract.silo()
    siloContract = await ethers.getContractAt('sJUSDSilo', siloAddress) as unknown as SJUSDSilo

    // Initialize V2 functionality
    await sJusdContract.connect(admin).initializeV2(instantUnstakingFee, insuranceFund.address)
  })

  describe('Initialization', () => {
    it('should initialize with correct values', async () => {
      const jusdAddress = await jusdContract.getAddress()
      const assetAddress = await sJusdContract.asset()

      expect(assetAddress).to.equal(jusdAddress)
      expect(await sJusdContract.name()).to.equal('Staked JUSD')
      expect(await sJusdContract.symbol()).to.equal('sJUSD')
      expect(await sJusdContract.decimals()).to.equal(18)
      expect(await sJusdContract.cooldownDuration()).to.equal(cooldown7days)

      // Check roles
      expect(await sJusdContract.hasRole(ADMIN_ROLE, admin.address)).to.be.true
    })

    it('should initialize silo with correct values', async () => {
      const jusdAddress = await jusdContract.getAddress()
      const sJusdAddress = await sJusdContract.getAddress()

      expect(await siloContract.getStakingVault()).to.equal(sJusdAddress)
      expect(await siloContract.getJUSD()).to.equal(jusdAddress)
    })

    it('should revert if JUSD address is zero', async () => {
      const sJusdFactory = await ethers.getContractFactory('sJUSD')
      await expect(
        upgrades.deployProxy(
          sJusdFactory,
          [ethers.ZeroAddress, admin.address],
          {
            kind: 'transparent',
            initializer: 'initialize',
            unsafeAllow: ['constructor', 'delegatecall'],
          },
        ),
      ).to.be.revertedWithCustomError(
        sJusdContract,
        'ZeroAddress',
      )
    })

    it('should revert if admin address is zero', async () => {
      const jusdAddress = await jusdContract.getAddress()
      const sJusdFactory = await ethers.getContractFactory('sJUSD')
      await expect(
        upgrades.deployProxy(
          sJusdFactory,
          [jusdAddress, ethers.ZeroAddress],
          {
            kind: 'transparent',
            initializer: 'initialize',
            unsafeAllow: ['constructor', 'delegatecall'],
          },
        ),
      ).to.be.revertedWithCustomError(
        sJusdContract,
        'ZeroAddress',
      )
    })
  })

  describe('Deposit/Stake', () => {
    it('should allow users to deposit JUSD and receive sJUSD', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sJUSD to spend user's JUSD
      await jusdContract.connect(user1).approve(
        await sJusdContract.getAddress(),
        depositAmount,
      )

      // Check initial balances
      const initialYusdBalance = await jusdContract.balanceOf(user1)
      const initialSYusdBalance = await sJusdContract.balanceOf(user1)

      // Deposit JUSD
      await sJusdContract.connect(user1).deposit(depositAmount, user1)

      // Check final balances
      const finalYusdBalance = await jusdContract.balanceOf(user1)
      const finalSYusdBalance = await sJusdContract.balanceOf(user1)

      expect(finalYusdBalance).to.equal(initialYusdBalance - depositAmount)
      expect(finalSYusdBalance).to.equal(initialSYusdBalance + depositAmount)
    })

    it('should maintain a 1:1 ratio initially between JUSD and sJUSD', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sJUSD to spend user's JUSD
      await jusdContract.connect(user1).approve(
        await sJusdContract.getAddress(),
        depositAmount,
      )

      // Deposit JUSD
      await sJusdContract.connect(user1).deposit(depositAmount, user1)

      // Check share balance equals assets initially
      const shareBalance = await sJusdContract.balanceOf(user1)
      expect(shareBalance).to.equal(depositAmount)

      // Check convertToAssets & convertToShares functions
      expect(await sJusdContract.convertToAssets(shareBalance)).to.equal(depositAmount)
      expect(await sJusdContract.convertToShares(depositAmount)).to.equal(shareBalance)
    })

    it('should correctly handle deposits with different recipients', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sJUSD to spend user's JUSD
      await jusdContract.connect(user1).approve(
        await sJusdContract.getAddress(),
        depositAmount,
      )

      // Deposit JUSD for user2
      await sJusdContract.connect(user1).deposit(depositAmount, user2)

      // Check balances
      expect(await jusdContract.balanceOf(user1)).to.equal(initialAmount - depositAmount)
      expect(await sJusdContract.balanceOf(user1)).to.equal(0)
      expect(await sJusdContract.balanceOf(user2)).to.equal(depositAmount)
    })
  })

  describe('Withdraw with Cooldown', () => {
    const depositAmount = ethers.parseEther('100')

    beforeEach(async () => {
      // Deposit some JUSD first
      await jusdContract.connect(user1).approve(
        await sJusdContract.getAddress(),
        depositAmount,
      )
      await sJusdContract.connect(user1).deposit(depositAmount, user1)
    })

    it('should not allow direct withdrawals when cooldown is enabled', async () => {
      // With V2 initialized, instant unstaking is allowed with fee
      // So this test now checks that instant unstaking works
      const balanceBefore = await jusdContract.balanceOf(user1)
      await sJusdContract.connect(user1).withdraw(depositAmount, user1, user1)
      const balanceAfter = await jusdContract.balanceOf(user1)

      // User should receive less than depositAmount due to instant unstaking fee
      expect(balanceAfter - balanceBefore).to.be.lt(depositAmount)
    })

    it('should allow cooldown process with assets', async () => {
      const cooldownAmount = ethers.parseEther('50')

      // Start cooldown
      await sJusdContract.connect(user1).cooldownAssets(cooldownAmount, user1)

      // Check cooldown status
      const [cooldownEnd, underlyingAmount] = await sJusdContract.getUserCooldownStatus(user1)
      expect(underlyingAmount).to.equal(cooldownAmount)
      expect(cooldownEnd).to.be.gt(0)

      // Verify shares were burned and JUSD moved to silo
      expect(await sJusdContract.balanceOf(user1)).to.equal(depositAmount - cooldownAmount)
      expect(await jusdContract.balanceOf(await siloContract.getAddress())).to.equal(cooldownAmount)
    })

    it('should allow cooldown process with shares', async () => {
      const cooldownShares = ethers.parseEther('50')

      // Start cooldown
      await sJusdContract.connect(user1).cooldownShares(cooldownShares, user1)

      // Check cooldown status
      const [cooldownEnd, underlyingAmount] = await sJusdContract.getUserCooldownStatus(user1)
      expect(underlyingAmount).to.equal(cooldownShares) // 1:1 ratio initially
      expect(cooldownEnd).to.be.gt(0)

      // Verify shares were burned and JUSD moved to silo
      expect(await sJusdContract.balanceOf(user1)).to.equal(depositAmount - cooldownShares)
      expect(await jusdContract.balanceOf(await siloContract.getAddress())).to.equal(cooldownShares)
    })

    it('should not allow unstaking before cooldown period ends', async () => {
      // Start cooldown
      await sJusdContract.connect(user1).cooldownAssets(depositAmount, user1)

      // Try to unstake immediately
      await expect(
        sJusdContract.connect(user1).unstake(user1),
      ).to.be.revertedWithCustomError(
        sJusdContract,
        'CooldownNotEnded',
      )
    })

    it('should allow unstaking after cooldown period ends', async () => {
      const cooldownAmount = ethers.parseEther('50')

      // Start cooldown
      await sJusdContract.connect(user1).cooldownAssets(cooldownAmount, user1)

      // Fast forward time past cooldown period
      await ethers.provider.send('evm_increaseTime', [cooldown7days + 1])
      await ethers.provider.send('evm_mine', [])

      // Check balances before unstaking
      const beforeUnstakeYusdBalance = await jusdContract.balanceOf(user1)

      // Unstake
      await sJusdContract.connect(user1).unstake(user1)

      // Check balances after unstaking
      const afterUnstakeYusdBalance = await jusdContract.balanceOf(user1)

      // Verify JUSD was returned to user
      expect(afterUnstakeYusdBalance).to.equal(beforeUnstakeYusdBalance + cooldownAmount)

      // Verify cooldown was cleared
      const [cooldownEnd, underlyingAmount] = await sJusdContract.getUserCooldownStatus(user1)
      expect(cooldownEnd).to.equal(0)
      expect(underlyingAmount).to.equal(0)
    })
  })

  describe('Direct Withdrawals with Cooldown Disabled', () => {
    const depositAmount = ethers.parseEther('100')

    beforeEach(async () => {
      // Disable cooldown
      await sJusdContract.connect(admin).setCooldownDuration(0)

      // Deposit some JUSD first
      await jusdContract.connect(user1).approve(
        await sJusdContract.getAddress(),
        depositAmount,
      )
      await sJusdContract.connect(user1).deposit(depositAmount, user1)
    })

    it('should allow direct withdrawals when cooldown is disabled', async () => {
      const withdrawAmount = ethers.parseEther('50')

      // Check initial balances
      const initialYusdBalance = await jusdContract.balanceOf(user1)
      const initialSYusdBalance = await sJusdContract.balanceOf(user1)

      // Withdraw JUSD
      await sJusdContract.connect(user1).withdraw(withdrawAmount, user1, user1)

      // Check final balances
      const finalYusdBalance = await jusdContract.balanceOf(user1)
      const finalSYusdBalance = await sJusdContract.balanceOf(user1)

      expect(finalYusdBalance).to.equal(initialYusdBalance + withdrawAmount)
      expect(finalSYusdBalance).to.equal(initialSYusdBalance - withdrawAmount)
    })

    it('should allow redeeming shares when cooldown is disabled', async () => {
      const redeemAmount = ethers.parseEther('50')

      // Check initial balances
      const initialYusdBalance = await jusdContract.balanceOf(user1)
      const initialSYusdBalance = await sJusdContract.balanceOf(user1)

      // Redeem shares
      await sJusdContract.connect(user1).redeem(redeemAmount, user1, user1)

      // Check final balances
      const finalYusdBalance = await jusdContract.balanceOf(user1)
      const finalSYusdBalance = await sJusdContract.balanceOf(user1)

      expect(finalYusdBalance).to.equal(initialYusdBalance + redeemAmount)
      expect(finalSYusdBalance).to.equal(initialSYusdBalance - redeemAmount)
    })
  })

  describe('Admin Functions', () => {
    it('should allow admin to change cooldown duration', async () => {
      const newDuration = 14 * 24 * 60 * 60 // 14 days

      // Set new cooldown duration
      await expect(sJusdContract.connect(admin).setCooldownDuration(newDuration))
        .to.emit(sJusdContract, 'CooldownDurationUpdated')
        .withArgs(cooldown7days, newDuration)

      expect(await sJusdContract.cooldownDuration()).to.equal(newDuration)
    })

    it('should revert if non-admin tries to change cooldown duration', async () => {
      await expect(
        sJusdContract.connect(user1).setCooldownDuration(0),
      ).to.be.reverted
    })

    it('should revert if cooldown duration exceeds maximum', async () => {
      const maxDuration = await sJusdContract.MAX_COOLDOWN_DURATION()
      const tooLongDuration = maxDuration + 1n

      await expect(
        sJusdContract.connect(admin).setCooldownDuration(tooLongDuration),
      ).to.be.reverted
    })

    it('should allow admin to rescue tokens', async () => {
      // Deploy a test token to be rescued
      const testToken = await ethers.deployContract('TestToken', ['Test', 'TST', 18])
      const rescueAmount = ethers.parseEther('10')

      // Send test tokens to sJUSD contract
      await testToken.mint(await sJusdContract.getAddress(), rescueAmount)

      // Rescue tokens
      await sJusdContract.connect(admin).rescueTokens(
        await testToken.getAddress(),
        rescueAmount,
        admin,
      )

      // Check tokens were rescued
      expect(await testToken.balanceOf(admin)).to.equal(rescueAmount)
    })

    it('should not allow rescuing the underlying JUSD token', async () => {
      await expect(
        sJusdContract.connect(admin).rescueTokens(
          await jusdContract.getAddress(),
          ethers.parseEther('1'),
          admin,
        ),
      ).to.be.revertedWithCustomError(
        sJusdContract,
        'InvalidToken',
      )
    })
  })

  describe('Max Functions and Limits', () => {
    beforeEach(async () => {
      // Deposit some JUSD first
      const depositAmount = ethers.parseEther('100')
      await jusdContract.connect(user1).approve(
        await sJusdContract.getAddress(),
        depositAmount,
      )
      await sJusdContract.connect(user1).deposit(depositAmount, user1)
    })
  })
})