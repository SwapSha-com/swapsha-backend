import Logger from '../../../lib/Logger';
import { getRate } from '../../../lib/Utils';
import {
  chainLimitAmount,
  chainSwapRate,
} from '../../../lib/blake2b/ChainRate';
import { OrderSide, SwapType, SwapVersion } from '../../../lib/consts/Enums';
import ExtraFeeRepository from '../../../lib/db/repositories/ExtraFeeRepository';
import RateProviderTaproot from '../../../lib/rates/providers/RateProviderTaproot';
import Errors from '../../../lib/service/Errors';
import Renegotiator from '../../../lib/service/Renegotiator';
import OverpaymentProtector from '../../../lib/swap/OverpaymentProtector';

// SwapSha D5, D19: the BTC/SHA256 pair runs at an operator-set rate, the
// number of SHA-256 coins one BTC is worth. These tests use a rate of 2
const pairRate = 2;
const limits = { minimal: 50_000, maximal: 10_000_000 };

describe('ChainRate', () => {
  test('turns the pair rate per order side', () => {
    // Sell: the user locks BTC, the server locks SHA-256
    expect(chainSwapRate(pairRate, OrderSide.SELL)).toEqual(2);
    // Buy: the user locks SHA-256, the server locks BTC
    expect(chainSwapRate(pairRate, OrderSide.BUY)).toEqual(0.5);
    expect(chainSwapRate(pairRate, OrderSide.BUY)).toEqual(
      getRate(pairRate, OrderSide.BUY, true),
    );
  });

  test('puts the user lock amount in quote units for the limits', () => {
    expect(chainLimitAmount(30_000, pairRate, OrderSide.SELL)).toEqual(60_000);
    expect(chainLimitAmount(30_000, pairRate, OrderSide.BUY)).toEqual(30_000);
    expect(chainLimitAmount(33_333, 1.5, OrderSide.SELL)).toEqual(49_999);
  });

  describe('RateProviderTaproot with a hardcoded BTC/SHA256 pair', () => {
    const provider = new RateProviderTaproot(
      new Map<string, any>([
        ['BTC', { chainClient: {}, lndClients: new Map([['lnd-1', {}]]) }],
        ['SHA256', { chainClient: {}, lndClients: new Map() }],
      ]),
      {
        getPercentageFee: jest.fn().mockReturnValue(0.5),
        getBaseFee: jest.fn().mockReturnValue(10_000),
        getSwapBaseFees: jest.fn().mockReturnValue(0),
      } as any,
      {
        [SwapType.Chain]: 6,
        [SwapType.Submarine]: 2,
        [SwapType.ReverseSubmarine]: 2,
      },
      new Map<string, any>([
        [
          'BTC/SHA256',
          {
            base: 'BTC',
            quote: 'SHA256',
            rate: pairRate,
            minSwapAmount: limits.minimal,
            maxSwapAmount: limits.maximal,
          },
        ],
      ]),
      new Map<string, number>([
        ['BTC', 0],
        ['SHA256', 0],
      ]),
      { defaultPaymentFeeRatio: 0.01 } as any,
    );

    beforeAll(() => {
      provider.setHardcodedPair(
        { base: 'BTC', quote: 'SHA256', rate: pairRate } as any,
        [SwapType.Chain, SwapType.Submarine, SwapType.ReverseSubmarine],
      );
    });

    test('keeps one rate for both chain swap directions', () => {
      const chain = provider.getChainPairs();
      expect(chain.get('BTC')!.get('SHA256')!.rate).toEqual(pairRate);
      expect(chain.get('SHA256')!.get('BTC')!.rate).toEqual(pairRate);
    });

    test('has submarine swaps only on the buy side', () => {
      // SHA-256 on chain, BTC over Lightning
      expect(
        provider.getSubmarinePairs().get('SHA256')!.get('BTC')!.rate,
      ).toEqual(pairRate);
      expect(
        provider.getRate('BTC/SHA256', SwapType.Submarine, OrderSide.BUY),
      ).toEqual(pairRate);
      // Upstream looks on the sell side, where this pair has no swaps
      expect(
        provider.getRate('BTC/SHA256', SwapType.Submarine),
      ).toBeUndefined();
    });

    test('raises the minimum to the miner fees in quote units', () => {
      // A miner fee of 10,000 sats times the chain multiplier of 6 is
      // 60,000 sats; on the BTC side that is 120,000 SHA-256 sats, above
      // the configured 50,000
      for (const [from, to] of [
        ['BTC', 'SHA256'],
        ['SHA256', 'BTC'],
      ]) {
        expect(
          provider.getChainPairs().get(from)!.get(to)!.limits.minimal,
        ).toEqual(120_000);
      }
    });
  });

  describe('Renegotiator quotes', () => {
    const feePercent = 0.01;
    const baseFee = 500;

    const pair = { rate: pairRate, limits };
    const rateProvider = {
      providers: {
        [SwapVersion.Taproot]: {
          getChainPairs: jest.fn().mockReturnValue(
            new Map<string, any>([
              ['BTC', new Map([['SHA256', pair]])],
              ['SHA256', new Map([['BTC', pair]])],
            ]),
          ),
        },
      },
      feeProvider: {
        getPercentageFee: jest.fn().mockReturnValue(feePercent),
        getSwapBaseFees: jest.fn().mockReturnValue({ server: baseFee }),
      },
    } as any;

    const negotiator = new Renegotiator(
      Logger.disabledLogger,
      new Map(),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      rateProvider,
      {} as any,
      new OverpaymentProtector(Logger.disabledLogger),
    );

    const swap = (orderSide: OrderSide, amount: number) =>
      ({
        id: 'swap',
        pair: 'BTC/SHA256',
        orderSide,
        chainSwap: {},
        receivingData: {
          symbol: orderSide === OrderSide.SELL ? 'BTC' : 'SHA256',
          amount,
        },
        sendingData: {
          symbol: orderSide === OrderSide.SELL ? 'SHA256' : 'BTC',
        },
      }) as any;

    beforeEach(() => {
      ExtraFeeRepository.get = jest.fn().mockResolvedValue(null);
    });

    test('quotes BTC to SHA-256 at the pair rate', async () => {
      await expect(
        negotiator['calculateNewQuote'](swap(OrderSide.SELL, 1_000_000)),
      ).resolves.toEqual({
        percentageFee: 20_000,
        serverLockAmount: 2_000_000 - 20_000 - baseFee,
      });
    });

    test('quotes SHA-256 to BTC at the inverse of the pair rate', async () => {
      // Before this fix: 1,979,500 BTC sats for 1,000,000 SHA-256 sats
      await expect(
        negotiator['calculateNewQuote'](swap(OrderSide.BUY, 1_000_000)),
      ).resolves.toEqual({
        percentageFee: 5_000,
        serverLockAmount: 500_000 - 5_000 - baseFee,
      });
    });

    test.each([OrderSide.BUY, OrderSide.SELL])(
      'quotes like a new swap would on side %s',
      async (side) => {
        const expected = negotiator.calculateServerLockAmount(
          getRate(pairRate, side, true),
          1_000_000,
          feePercent,
          baseFee,
        );

        await expect(
          negotiator['calculateNewQuote'](swap(side, 1_000_000)),
        ).resolves.toEqual(expected);
      },
    );

    test('checks the limits in quote units', async () => {
      // 30,000 BTC sats are 60,000 SHA-256 sats, above the minimum
      await expect(
        negotiator['calculateNewQuote'](swap(OrderSide.SELL, 30_000)),
      ).resolves.toEqual(expect.anything());

      // 30,000 SHA-256 sats are below it
      await expect(
        negotiator['calculateNewQuote'](swap(OrderSide.BUY, 30_000)),
      ).rejects.toEqual(Errors.BENEATH_MINIMAL_AMOUNT(30_000, limits.minimal));

      // 6,000,000 BTC sats are 12,000,000 SHA-256 sats, above the maximum
      // and the 2% overpayment allowance
      await expect(
        negotiator['calculateNewQuote'](swap(OrderSide.SELL, 6_000_000)),
      ).rejects.toEqual(
        Errors.EXCEED_MAXIMAL_AMOUNT(12_000_000, limits.maximal),
      );
    });
  });
});
