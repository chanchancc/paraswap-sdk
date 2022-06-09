// @TODO getOrder, getOrders from API
// onchain from contract can't distinguish between filled or cancelled
import BigNumber from 'bignumber.js';
import { BigNumber as EthersBigNumber } from 'ethers';
import { assert } from 'ts-essentials';
import { API_URL } from '../../constants';
import { ExtractAbiMethodNames, gatherObjectsByProp } from '../../helpers/misc';
import type {
  Address,
  ConstructProviderFetchInput,
  StaticCallOverrides,
} from '../../types';
import {
  chainId2BlockContractDeployedAt,
  chainId2verifyingContract,
  constructBaseFetchUrlGetter,
} from './helpers/misc';
import type {
  AnyLimitOrder,
  LimitOrderExtra,
  LimitOrdersApiResponse,
  LimitOrderStatus,
  OrderType,
  RawLimitOrder,
  UnknownLimitOrder,
} from './helpers/types';

//                     get orders by `maker` or `taker`
export type LimitOrdersUserParams =
  | { maker: Address; type: OrderType }
  | { taker: Address; type: OrderType };
type GetLimitOrderByHash = (
  orderHash: string,
  signal?: AbortSignal
) => Promise<RawLimitOrder>;
type GetLimitOrders = (
  userParams: LimitOrdersUserParams,
  signal?: AbortSignal
) => Promise<AnyLimitOrder[] | UnknownLimitOrder[]>;
type GetRawLimitOrders = (
  userParams: LimitOrdersUserParams,
  signal?: AbortSignal
) => Promise<RawLimitOrder[]>;

type MinOrderForStatus = Pick<
  RawLimitOrder,
  'expiry' | 'makerAmount' | 'orderHash' | 'taker' | 'maker'
>;

type GetOrderExtraData = (
  order: MinOrderForStatus,
  overrides?: StaticCallOverrides
) => Promise<LimitOrderExtra>;
type GetOrdersExtraData = (
  orders: MinOrderForStatus[],
  overrides?: StaticCallOverrides
) => Promise<LimitOrderExtra[]>;

export type GetLimitOrdersFunctions = {
  /** @deprecated use getRawLimitOrders for now*/
  getLimitOrders: GetLimitOrders;
  getRawLimitOrders: GetRawLimitOrders;
  getLimitOrderByHash: GetLimitOrderByHash;
  /** @deprecated */
  getLimitOrderStatusAndAmountFilled: GetOrderExtraData;
  /** @deprecated */
  getLimitOrdersStatusAndAmountFilled: GetOrdersExtraData;
};

const MinAugustusRFQAbi = [
  {
    inputs: [
      {
        internalType: 'address',
        name: 'maker',
        type: 'address',
      },
      {
        internalType: 'bytes32[]',
        name: 'orderHashes',
        type: 'bytes32[]',
      },
    ],
    name: 'getRemainingOrderBalance',
    outputs: [
      {
        internalType: 'uint256[]',
        name: 'remainingBalances',
        type: 'uint256[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Without OrderFilledNFT event for now
const AugustusRFQEventsAbi = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'maker',
        type: 'address',
      },
    ],
    name: 'OrderCancelled',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'maker',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'makerAsset',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'makerAmount',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'taker',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'takerAsset',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'takerAmount',
        type: 'uint256',
      },
    ],
    name: 'OrderFilled',
    type: 'event',
  },
] as const;

type AvailableMethods = ExtractAbiMethodNames<typeof MinAugustusRFQAbi>;

const OrderFilledSig =
  '0x6621486d9c28838df4a87d2cca5007bc2aaf6a5b5de083b1db8faf709302c473';
// @TODO change when contract is redeployed
const OrderCancelledSig =
  '0xa6eb7cdc219e1518ced964e9a34e61d68a94e4f1569db3e84256ba981ba52753';

export const constructGetLimitOrders = ({
  apiURL = API_URL,
  chainId,
  fetcher,
  contractCaller,
}: ConstructProviderFetchInput<
  any,
  'staticCall' | 'getLogsCall'
>): GetLimitOrdersFunctions => {
  const getBaseFetchURLByOrderType = constructBaseFetchUrlGetter({
    apiURL,
    chainId,
  });

  const verifyingContract = chainId2verifyingContract[chainId];
  const verifyingContractDeployedBlock =
    chainId2BlockContractDeployedAt[chainId];

  const getLimitOrdersStatusAndAmountFilled: GetOrdersExtraData = async (
    orders,
    overrides = {}
  ) => {
    // @TODO allow to pass {ordderHash} only, fetch everything else
    assert(
      verifyingContract,
      `AugustusRFQ contract for Limit Orders not available on chain ${chainId}`
    );

    const orderHashes = orders.map((order) => order.orderHash);

    const remainingBalances: EthersBigNumber[] = [];

    // can't fetch all balances onchain for orders if asking for orders with different makers
    // which happens when fetching orders by taker
    const orderHashesByMaker = gatherObjectsByProp<
      MinOrderForStatus,
      { orderHash: string; index: number }[]
    >(
      orders,
      (order) => order.maker,
      ({ orderHash }, accumElem = [], index) => {
        accumElem.push({ orderHash, index });
        return accumElem;
      }
    );

    // make AugustusRFQ.getRemainingOrderBalance(maker, orderHashes) for each maker
    const executePromises = Object.entries(orderHashesByMaker).map(
      async ([maker, orderHashObjects]) => {
        const orderHashes = orderHashObjects.map((o) => o.orderHash);

        const remainingBalancesForGroup = await contractCaller.staticCall<
          EthersBigNumber[],
          AvailableMethods
        >({
          address: verifyingContract,
          abi: MinAugustusRFQAbi,
          contractMethod: 'getRemainingOrderBalance',
          args: [maker, orderHashes],
          overrides,
        });

        remainingBalancesForGroup.forEach((balance, index) => {
          const orderIndex = orderHashObjects[index]?.index!;

          remainingBalances[orderIndex] = balance;
        });
      }
    );

    await Promise.all(executePromises);
    // at this point remainingBalances are filled in at correct order indices

    // @TODO check what the return is for web3, probably string[]
    // const remainingBalances = await contractCaller.staticCall<
    //   EthersBigNumber[],
    //   AvailableMethods
    // >({
    //   address: verifyingContract,
    //   abi: MinAugustusRFQAbi,
    //   contractMethod: 'getRemainingOrderBalance',
    //   args: [orderMaker, orderHashes],
    //   overrides,
    // });

    const logs = (await contractCaller.getLogsCall({
      address: verifyingContract,
      abi: AugustusRFQEventsAbi,
      filter: {
        address: verifyingContract,
        topics: [[OrderFilledSig, OrderCancelledSig], orderHashes],
        fromBlock: verifyingContractDeployedBlock, // if not available will default to 0
        // and then depending on node will either count from 0 or from the earlies available block or break or hang
      },
    })) as OrderLog[]; // @TODO adapt for web3 too

    // const cancelledOrders = new Set(
    //   logs
    //     .filter((log) => log.topic === OrderCancelledSig)
    //     .map((log) => log.args.orderHash)
    // );

    const order2EventsMap = gatherObjectsByProp<OrderLog, OrderLog[]>(
      logs,
      (log) => log.args.orderHash.toLowerCase(),
      (log, accumElem = []) => {
        accumElem.push(log);
        return accumElem;
      }
    );

    const orderStatusesAndAmountsFilled = orders.map((order, index) => {
      const remainingBalance = remainingBalances[index];
      assert(
        remainingBalance,
        `Failed to get remainingBalance for order ${order.orderHash}`
      );

      //  can have none, can have OrderFilled*n + OrderCancelled
      const orderEvents = order2EventsMap[order.orderHash.toLowerCase()];

      const wasCancelled = !!orderEvents?.some(
        (log) => log.topic === OrderCancelledSig
      );
      // const wasCancelled = cancelledOrders.has(order.orderHash);

      const filledEvents = !wasCancelled
        ? []
        : orderEvents?.filter<OrderFilledDecodedLog>(
            (log): log is OrderFilledDecodedLog =>
              log.args.orderHash.toLowerCase() ===
                order.orderHash.toLowerCase() && log.topic === OrderFilledSig
          ) || [];

      // @TODO check this is even correct
      const _amountFilled =
        filledEvents.length === 0
          ? undefined
          : // sum up all takerAmount across OrderFilled event for this orderHash
            filledEvents.reduce<BigNumber>(
              (accum, curr) => accum.plus(curr.args.takerAmount.toString()),
              new BigNumber(0)
            );

      const amountFilled = !_amountFilled
        ? undefined
        : _amountFilled.isZero()
        ? undefined
        : _amountFilled.toString();

      const extraData = _getLimitOrderStatusAndAmountFilled(order, {
        remainingBalance: remainingBalance.toString(),
        wasCancelled,
        amountFilled,
        orderEvents,
      });

      return extraData;
    });

    return orderStatusesAndAmountsFilled;
  };

  const getLimitOrderStatusAndAmountFilled: GetOrderExtraData = async (
    order,
    overrides = {}
  ) => {
    const [orderStatus] = await getLimitOrdersStatusAndAmountFilled(
      [order],
      overrides
    );

    assert(orderStatus, `Failed to get status for order ${order.orderHash}`);

    return orderStatus;
  };

  const getRawLimitOrders: GetRawLimitOrders = async (userParams, signal) => {
    const baseFetchURL = getBaseFetchURLByOrderType(userParams.type);
    const userURL =
      'maker' in userParams
        ? `maker/${userParams.maker}`
        : `taker/${userParams.taker}`;
    const fetchURL = `${baseFetchURL}/${userURL}`;

    const { orders } = await fetcher<LimitOrdersApiResponse>({
      url: fetchURL,
      method: 'GET',
      signal,
    });

    console.log('🚀 getRawLimitOrders', orders);
    // without any extra calls, return  what API returns
    return orders;
  };

  const getLimitOrderByHash: GetLimitOrderByHash = async (
    orderHash,
    signal
  ) => {
    const fetchURL = `${apiURL}/limit/order/${chainId}/${orderHash}`;

    const order = await fetcher<RawLimitOrder>({
      url: fetchURL,
      method: 'GET',
      signal,
    });

    return order;
  };

  const getLimitOrders: GetLimitOrders = async (userParams, signal) => {
    const orders = await getRawLimitOrders(userParams, signal);

    try {
      const orderExtras = await getLimitOrdersStatusAndAmountFilled(orders);

      const ordersWithEtras = orders.map<AnyLimitOrder>((order, index) => {
        const extras = orderExtras[index];
        assert(extras, `Failed to get status for order ${order.orderHash}`);

        return {
          ...order,
          ...extras,
        };
      });

      return ordersWithEtras;
    } catch (error) {
      console.warn('Error fetching Orders status onchain', error);

      const ordersWithUnknownStatus = orders.map<UnknownLimitOrder>(
        (order) => ({
          ...order,
          status: 'unknown',
        })
      );
      return ordersWithUnknownStatus;
    }
  };

  return {
    getLimitOrders,
    getRawLimitOrders,
    getLimitOrderByHash,
    getLimitOrderStatusAndAmountFilled,
    getLimitOrdersStatusAndAmountFilled,
  };
};

interface StatusAndAmountFilledOptions {
  remainingBalance: string;
  wasCancelled: boolean;
  amountFilled?: string;
  orderEvents?: OrderLog[];
}

// RemainingBalance keeps track of remaining amounts of each Order
// 0 -> order unfilled / not exists
// 1 -> order filled / cancelled
// other number -> remaining balance
function _getLimitOrderStatusAndAmountFilled(
  { expiry, makerAmount }: Pick<RawLimitOrder, 'expiry' | 'makerAmount'>,
  {
    remainingBalance,
    wasCancelled,
    amountFilled,
    orderEvents,
  }: StatusAndAmountFilledOptions
): LimitOrderExtra {
  console.log('🚀 ~ remainingBalance', remainingBalance.toString());
  const remainingBalanceBN = new BigNumber(remainingBalance);
  // order exists since we got it from API
  if (remainingBalanceBN.isZero()) {
    const status: LimitOrderStatus =
      Date.now() / 1000 > expiry ? 'expired' : 'open';
    // `expired` status means the Order expired without being filled (even partially)

    return {
      status,
      amountFilled: '0',
    };
  }

  // never return {..., transactionHashes: undefined}
  // to avoid false positive typeguards `'transactionHashes' in order => order is Cancelled | Filled | PartiallyFilled`
  assert(
    orderEvents && orderEvents[0],
    'there should be events for cancelled, filled and partiallyFilled orders'
  );

  const transactionHashes = orderEvents.map((log) => log.transactionHash) as [
    string,
    ...string[]
  ];

  // filled or cancelled
  if (remainingBalanceBN.eq(1)) {
    return {
      status: wasCancelled ? 'canceled' : 'filled',
      // `cancelled` order can be partiallyFilled first
      amountFilled: wasCancelled && amountFilled ? amountFilled : makerAmount,
      transactionHashes,
    };
  }

  // partially filled
  return {
    status: 'partiallyFilled',
    amountFilled: remainingBalanceBN.minus(makerAmount).negated().toString(),
    transactionHashes,
  };
}

type OrderCancelledDecodedArgs = readonly [
  orderHash: string,
  maker: Address
] & {
  orderHash: string;
  maker: Address;
};
interface OrderCancelleDecodedLog {
  topic: string;
  args: OrderCancelledDecodedArgs;
  transactionHash: string;
}
type OrderFilledDecodedArgs = readonly [
  orderHash: string,
  maker: Address,
  makerAsset: Address,
  makerAmount: EthersBigNumber, // @TODO see what works with web3, may need to just stick to string everywhere
  taker: Address,
  takerAsset: Address,
  takerAmount: EthersBigNumber
] & {
  orderHash: string;
  maker: Address;
  makerAsset: Address;
  makerAmount: EthersBigNumber;
  taker: Address;
  takerAsset: Address;
  takerAmount: EthersBigNumber;
};
interface OrderFilledDecodedLog {
  topic: string;
  args: OrderFilledDecodedArgs;
  transactionHash: string;
}

type OrderLog = OrderCancelleDecodedLog | OrderFilledDecodedLog;
