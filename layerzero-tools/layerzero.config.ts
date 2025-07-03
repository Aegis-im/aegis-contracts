import { ExecutorOptionType } from '@layerzerolabs/lz-v2-utilities'
import { OAppEnforcedOption, OmniPointHardhat } from '@layerzerolabs/toolbox-hardhat'
import { EndpointId } from '@layerzerolabs/lz-definitions'
import { generateConnectionsConfig } from '@layerzerolabs/metadata-tools'

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

const EVM_ENFORCED_OPTIONS: OAppEnforcedOption[] = [
  {
    msgType: 1,
    optionType: ExecutorOptionType.LZ_RECEIVE,
    gas: 80000,
    value: 0,
  },
]

export default async function () {
  // note: pathways declared here are automatically bidirectional
  // if you declare A,B there's no need to declare B,A
  const connections = await generateConnectionsConfig([
    // [
    //   sepoliaContract, // Chain A contract
    //   fujiContract, // Chain B contract
    //   [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    //   [15, 20], // [A to B confirmations, B to A confirmations]
    //   [EVM_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    // ],
    // [
    //   bnbTestnetContract, // Chain A contract
    //   fujiContract, // Chain B contract
    //   [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
    //   [15, 20], // [A to B confirmations, B to A confirmations]
    //   [EVM_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    // ],
    [
      bnbTestnetContract, // Chain A contract
      optimismSepoliaContract, // Chain B contract
      [['LayerZero Labs'], []], // [ requiredDVN[], [ optionalDVN[], threshold ] ]
      [15, 20], // [A to B confirmations, B to A confirmations]
      [EVM_ENFORCED_OPTIONS, EVM_ENFORCED_OPTIONS], // Chain B enforcedOptions, Chain A enforcedOptions
    ],
  ])

  return {
    contracts: [
      // { contract: sepoliaContract },
      // { contract: fujiContract },
      { contract: bnbTestnetContract },
      { contract: optimismSepoliaContract },
    ],
    connections,
  }
}
