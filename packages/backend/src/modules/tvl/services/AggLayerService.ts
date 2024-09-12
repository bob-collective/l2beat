import { AmountRecord } from '@l2beat/database'
import {
  AggLayerL2Token,
  AggLayerNativeEtherPreminted,
  AggLayerNativeEtherWrapped,
  Bytes,
  EthereumAddress,
  UnixTime,
} from '@l2beat/shared-pure'
import { BigNumber, utils } from 'ethers'
import { MulticallClient } from '../../../peripherals/multicall/MulticallClient'
import { MulticallRequest } from '../../../peripherals/multicall/types'
import { RpcClient } from '../../../peripherals/rpcclient/RpcClient'

export const erc20Interface = new utils.Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
])

export const bridgeInterface = new utils.Interface([
  'function getTokenWrappedAddress(uint32 originNetwork, address originTokenAddress) view returns (address)',
])

type AggLayerAmountConfig =
  | AggLayerL2Token
  | AggLayerNativeEtherPreminted
  | AggLayerNativeEtherWrapped

export type Config<T extends AggLayerAmountConfig['type']> =
  AggLayerAmountConfig & { type: T } & { id: string }

export interface AggLayerServiceDependencies {
  readonly rpcClient: RpcClient
  readonly multicallClient: MulticallClient
  readonly bridgeAddress: EthereumAddress
}

export class AggLayerService {
  constructor(private readonly $: AggLayerServiceDependencies) {}

  async fetchAmounts(
    timestamp: UnixTime,
    blockNumber: number,
    tokens: Config<'aggLayerL2Token'>[],
    nativeToken:
      | Config<'aggLayerNativeEtherPreminted' | 'aggLayerNativeEtherWrapped'>
      | undefined,
  ): Promise<AmountRecord[]> {
    const l2TokensAmounts = await this.getL2TokensAmounts(
      timestamp,
      blockNumber,
      tokens,
    )

    const nativeTokenAmount = nativeToken
      ? nativeToken.type === 'aggLayerNativeEtherPreminted'
        ? await this.getNativeEtherPremintedAmount(
            timestamp,
            blockNumber,
            nativeToken,
          )
        : await this.getNativeEtherWrappedAmount(
            timestamp,
            blockNumber,
            nativeToken,
          )
      : undefined

    return [
      ...l2TokensAmounts,
      ...(nativeTokenAmount ? [nativeTokenAmount] : []),
    ]
  }

  async getL2TokensAmounts(
    timestamp: UnixTime,
    blockNumber: number,
    tokens: Config<'aggLayerL2Token'>[],
  ) {
    const tokensWithL2Addresses = await this.getL2TokensAddresses(
      blockNumber,
      tokens,
    )

    return await this.getL2TokensTotalSupply(
      timestamp,
      blockNumber,
      tokensWithL2Addresses,
    )
  }

  async getL2TokensTotalSupply(
    timestamp: UnixTime,
    blockNumber: number,
    tokens: (Config<'aggLayerL2Token'> & { address: EthereumAddress })[],
  ): Promise<AmountRecord[]> {
    const encoded: MulticallRequest[] = tokens.map((token) => ({
      address: token.address,
      data: Bytes.fromHex(erc20Interface.encodeFunctionData('totalSupply', [])),
    }))

    const responses = await this.$.multicallClient.multicall(
      encoded,
      blockNumber,
    )

    return responses.map((response, index) => {
      const token = tokens[index]
      const [value] = erc20Interface.decodeFunctionResult(
        'totalSupply',
        response.data.toString(),
      )
      return {
        configId: token.id,
        timestamp,
        amount: (value as BigNumber).toBigInt(),
      }
    })
  }

  async getL2TokensAddresses(
    blockNumber: number,
    tokens: Config<'aggLayerL2Token'>[],
  ): Promise<(AggLayerL2Token & { address: EthereumAddress; id: string })[]> {
    const encoded: MulticallRequest[] = tokens.map((token) => ({
      address: this.$.bridgeAddress,
      data: Bytes.fromHex(
        bridgeInterface.encodeFunctionData('getTokenWrappedAddress', [
          token.originNetwork,
          token.l1Address,
        ]),
      ),
    }))

    const responses = await this.$.multicallClient.multicall(
      encoded,
      blockNumber,
    )

    return responses.map((response, index) => {
      const token = tokens[index]
      const [address] = bridgeInterface.decodeFunctionResult(
        'getTokenWrappedAddress',
        response.data.toString(),
      )
      return {
        ...token,
        address: address as EthereumAddress,
      }
    })
  }

  async getNativeEtherPremintedAmount(
    timestamp: UnixTime,
    blockNumber: number,
    token: Config<'aggLayerNativeEtherPreminted'>,
  ): Promise<AmountRecord> {
    const bridgeBalance = await this.$.rpcClient.getBalance(
      token.l2BridgeAddress,
      blockNumber,
    )
    const amount = token.premintedAmount - bridgeBalance.toBigInt()
    return {
      configId: token.id,
      amount,
      timestamp,
    }
  }

  async getNativeEtherWrappedAmount(
    timestamp: UnixTime,
    blockNumber: number,
    token: Config<'aggLayerNativeEtherWrapped'>,
  ): Promise<AmountRecord> {
    const response = await this.$.rpcClient.call(
      {
        to: token.wethAddress,
        data: Bytes.fromHex(
          erc20Interface.encodeFunctionData('totalSupply', []),
        ),
      },
      blockNumber,
    )

    const [totalSupply] = erc20Interface.decodeFunctionResult(
      'totalSupply',
      response.toString(),
    )

    return {
      configId: token.id,
      amount: (totalSupply as BigNumber).toBigInt(),
      timestamp,
    }
  }
}