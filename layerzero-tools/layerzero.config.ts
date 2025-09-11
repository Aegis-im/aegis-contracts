import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { OAppEnforcedOption, OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'
import { EndpointId } from '@layerzerolabs/lz-definitions'
import { generateConnectionsConfig } from '@layerzerolabs/metadata-tools'

const mainnetContract: OmniPointHardhat = {
  eid: EndpointId.ETHEREUM_V2_MAINNET,
  contractName: 'YUSDMintBurnOFTAdapter',
}

const bnbMainnetContract: OmniPointHardhat = {
  eid: EndpointId.BSC_V2_MAINNET,
  contractName: 'YUSDMintBurnOFTAdapter',
}

const avalancheContract: OmniPointHardhat = {
  eid: EndpointId.AVALANCHE_V2_MAINNET,
  contractName: 'YUSDOFT',
}

const arbitrumContract: OmniPointHardhat = {
  eid: EndpointId.ARBITRUM_V2_MAINNET,
  contractName: 'YUSDOFT',
}

const katanaContract: OmniPointHardhat = {
  eid: EndpointId.KATANA_V2_MAINNET,
  contractName: 'YUSDOFT',
}


const baseContract: OmniPointHardhat = {
  eid: EndpointId.BASE_V2_MAINNET,
  contractName: 'YUSDOFT',
}


const mainnetsYUSDContract: OmniPointHardhat = {
  eid: EndpointId.ETHEREUM_V2_MAINNET,
  contractName: 'sYUSDOFTAdapter',
}

const katanasYUSDContract: OmniPointHardhat = {
  eid: EndpointId.KATANA_V2_MAINNET,
  contractName: 'sYUSDOFT',
}

const avalanchesYUSDContract: OmniPointHardhat = {
  eid: EndpointId.AVALANCHE_V2_MAINNET,
  contractName: 'sYUSDOFT',
}
// UNCOMMENT FOR TESTNETS
/*
const sepoliaContract: OmniPointHardhat = {
  eid: EndpointId.SEPOLIA_V2_TESTNET,
  contractName: 'YUSDMintBurnOFTAdapter',
}

const optimismSepoliaContract: OmniPointHardhat = {
  eid: EndpointId.OPTSEP_V2_TESTNET,
  contractName: 'YUSDOFT',
}

const fujiContract: OmniPointHardhat = {
  eid: EndpointId.AVALANCHE_V2_TESTNET,
  contractName: 'YUSDMintBurnOFTAdapter',
}

const bnbTestnetContract: OmniPointHardhat = {
  eid: EndpointId.BSC_V2_TESTNET,
  contractName: 'YUSDMintBurnOFTAdapter',
}
*/

// Network-specific enforced options
const MAINNET_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 100000, // Higher gas for mainnet due to higher complexity
    value: 0,
  },
]

const BNB_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 80000, // Standard gas for BNB
    value: 0,
  },
]

const AVALANCHE_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 120000, // Higher gas for Avalanche operations
    value: 0,
  },
]

const ARBITRUM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [

  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 80000,
    value: 0,
  },
]

const KATANA_ENFORCED_OPTIONS: OAppEnforcedOption[] = [

  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 80000,
    value: 0,
  },
]

const BASE_ENFORCED_OPTIONS: OAppEnforcedOption[] = [

  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 80000,
    value: 0,
  },
]

// Testnet enforced options (lower gas limits for testing)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TESTNET_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 60000, // Lower gas for testnets
    value: 0,
  },
]

export default async function () {
  // note: pathways declared here are automatically bidirectional
  // if you declare A,B there's no need to declare B,A
  const connections = await generateConnectionsConfig([
    [
      mainnetContract, // Chain A contract
      bnbMainnetContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [BNB_ENFORCED_OPTIONS, MAINNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      mainnetContract, // Chain A contract
      avalancheContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [AVALANCHE_ENFORCED_OPTIONS, MAINNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      bnbMainnetContract, // Chain A contract
      avalancheContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [AVALANCHE_ENFORCED_OPTIONS, BNB_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      mainnetContract, // Chain A contract
      arbitrumContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [ARBITRUM_ENFORCED_OPTIONS, MAINNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      bnbMainnetContract, // Chain A contract
      arbitrumContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [ARBITRUM_ENFORCED_OPTIONS, BNB_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      avalancheContract, // Chain A contract
      arbitrumContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [ARBITRUM_ENFORCED_OPTIONS, AVALANCHE_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      mainnetContract, // Chain A contract
      katanaContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [KATANA_ENFORCED_OPTIONS, MAINNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      bnbMainnetContract, // Chain A contract
      katanaContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [KATANA_ENFORCED_OPTIONS, BNB_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      avalancheContract, // Chain A contract
      katanaContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [KATANA_ENFORCED_OPTIONS, AVALANCHE_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      arbitrumContract, // Chain B contract
      katanaContract, // Chain A contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [KATANA_ENFORCED_OPTIONS, ARBITRUM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      baseContract, // Chain A contract
      katanaContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [KATANA_ENFORCED_OPTIONS, BASE_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      mainnetContract, // Chain A contract
      baseContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [BASE_ENFORCED_OPTIONS, MAINNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      bnbMainnetContract, // Chain A contract
      baseContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [BASE_ENFORCED_OPTIONS, BNB_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      avalancheContract, // Chain A contract
      baseContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [BASE_ENFORCED_OPTIONS, AVALANCHE_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      arbitrumContract, // Chain A contract
      baseContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [BASE_ENFORCED_OPTIONS, ARBITRUM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      mainnetsYUSDContract, // Chain A contract
      katanasYUSDContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [KATANA_ENFORCED_OPTIONS, MAINNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      mainnetsYUSDContract, // Chain A contract
      avalanchesYUSDContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [AVALANCHE_ENFORCED_OPTIONS, MAINNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    [
      katanasYUSDContract, // Chain A contract
      avalanchesYUSDContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [AVALANCHE_ENFORCED_OPTIONS, KATANA_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
    // UNCOMMENT FOR TESTNETS
    // [
    //   sepoliaContract, // Chain A contract
    //   fujiContract, // Chain B contract
    //   [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    //   [15, 20], // [A to B confirmations, B to A confirmations]
    //   [TESTNET_ENFORCED_OPTIONS, TESTNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    // ],
    // [
    //   bnbTestnetContract, // Chain A contract
    //   fujiContract, // Chain B contract
    //   [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    //   [15, 20], // [A to B confirmations, B to A confirmations]
    //   [TESTNET_ENFORCED_OPTIONS, TESTNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    // ],
    // [
    //   bnbTestnetContract, // Chain A contract
    //   optimismSepoliaContract, // Chain B contract
    //   [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    //   [15, 20], // [A to B confirmations, B to A confirmations]
    //   [TESTNET_ENFORCED_OPTIONS, TESTNET_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    // ],
  ])

  return {
    contracts: [
      // { contract: sepoliaContract },
      // { contract: fujiContract },
      // { contract: bnbTestnetContract },
      // { contract: optimismSepoliaContract },
      { contract: mainnetContract },
      { contract: bnbMainnetContract },
      { contract: avalancheContract },
      { contract: arbitrumContract },
      { contract: katanaContract },
      { contract: baseContract },
      { contract: mainnetsYUSDContract },
      { contract: katanasYUSDContract },
      { contract: avalanchesYUSDContract },
    ],
    connections,
  }
}
