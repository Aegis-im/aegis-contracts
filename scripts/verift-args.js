// TimelockController constructor args
// minDelay, proposers, executors, admin
module.exports = [
  60,
  ['0x84fE172c15bb030BAA0dD497D30DD436c6b750E9'],
  ['0x84fE172c15bb030BAA0dD497D30DD436c6b750E9'],
  '0x84fE172c15bb030BAA0dD497D30DD436c6b750E9'
]

/*
// YUSD constructor args
// admin
module.exports = [
  '0x84fE172c15bb030BAA0dD497D30DD436c6b750E9'
]

// sYUSDSilo constructor args
// stakingVault, yusdAddress
module.exports = [
  '0x...', // sYUSD proxy address
  '0x...' // YUSD token address
]

// To verify proxy implementation, no constructor args needed since
// initialization is handled through the proxy
module.exports = []
*/