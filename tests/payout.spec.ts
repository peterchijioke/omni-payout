import crypto from 'crypto';
import { OmniPayoutEngine } from '../src/engine';

describe('OmniPayoutEngine', () => {
  const engine = new OmniPayoutEngine({
    stripe: { secretKey: 'sk_test_mock_stripe', webhookSecret: 'whsec_test_stripe' },
    flutterwave: { secretKey: 'flw_sec_mock_flw', webhookSecret: 'flw_hash_secret' },
    paystack: { secretKey: 'sk_test_mock_paystack', webhookSecret: 'ps_webhook_secret' },
  });

  describe('Rail Resolution', () => {
    it('resolves USD with stripeAccountId to STRIPE_CONNECT', () => {
      const rail = engine.resolveRail({
        amount: 100,
        currency: 'USD',
        reference: 'REF-1',
        stripeAccountId: 'acct_123',
      });
      expect(rail).toBe('STRIPE_CONNECT');
    });

    it('resolves NGN with bankDetails to FLUTTERWAVE', () => {
      const rail = engine.resolveRail({
        amount: 50000,
        currency: 'NGN',
        reference: 'REF-2',
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });
      expect(rail).toBe('FLUTTERWAVE');
    });

    it('resolves KES mobile money to FLUTTERWAVE', () => {
      const rail = engine.resolveRail({
        amount: 2500,
        currency: 'KES',
        reference: 'REF-3',
        mobileMoneyDetails: { phone: '254712345678', network: 'MPESA' },
      });
      expect(rail).toBe('FLUTTERWAVE');
    });
  });

  describe('Disbursement execution with mocked fetch', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('disburses via Stripe Connect cleanly', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'tr_mock_123', status: 'paid' }),
      } as any);

      const res = await engine.disburse({
        amount: 50.00,
        currency: 'USD',
        reference: 'REF-STRIPE-001',
        stripeAccountId: 'acct_target_123',
      });

      expect(res.success).toBe(true);
      expect(res.rail).toBe('STRIPE_CONNECT');
      expect(res.transactionId).toBe('tr_mock_123');
      expect(res.amount).toBe(50.00);
    });

    it('disburses via Flutterwave cleanly', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { id: 987654, status: 'SUCCESSFUL', fee: 10.75 },
        }),
      } as any);

      const res = await engine.disburse({
        amount: 15000,
        currency: 'NGN',
        reference: 'REF-FLW-001',
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });

      expect(res.success).toBe(true);
      expect(res.rail).toBe('FLUTTERWAVE');
      expect(res.transactionId).toBe('987654');
      expect(res.fee).toBe(10.75);
    });

    it('resolves bank account name via Flutterwave', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'success',
          data: { account_name: 'CHUKWU CHIJIOKE PETER', account_number: '0123456789' },
        }),
      } as any);

      const res = await engine.resolveBankAccount('058', '0123456789');
      expect(res.accountName).toBe('CHUKWU CHIJIOKE PETER');
      expect(res.accountNumber).toBe('0123456789');
    });

    it('returns PENDING when Flutterwave accepts a payout not yet received by recipient', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            id: 555111,
            reference: 'REF-FLW-PENDING-001',
            status: 'NEW',
            fee: 10.75,
          },
        }),
      } as any);

      const res = await engine.disburse({
        amount: 20000,
        currency: 'NGN',
        reference: 'REF-FLW-PENDING-001',
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });

      expect(res.success).toBe(true);
      expect(res.status).toBe('PENDING');
      expect(res.providerStatus).toBe('NEW');
      expect(res.reference).toBe('REF-FLW-PENDING-001');
      expect(res.transactionId).toBe('555111');
    });

    it('returns FAILED when Flutterwave marks a transfer as FAILED', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            id: 555222,
            reference: 'REF-FLW-FAIL-001',
            status: 'FAILED',
            complete_message: 'Account validation failed',
          },
        }),
      } as any);

      const res = await engine.disburse({
        amount: 20000,
        currency: 'NGN',
        reference: 'REF-FLW-FAIL-001',
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });

      expect(res.success).toBe(false);
      expect(res.status).toBe('FAILED');
      expect(res.providerStatus).toBe('FAILED');
      expect(res.error).toBe('Account validation failed');
    });

    it('returns PENDING when Stripe instant payout is accepted (in_transit) and preserves reference/idempotency keys on retry', async () => {
      const fetchMock = jest
        .fn()
        // First attempt: transfer + instant payout (in_transit)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'tr_retry_1' }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'po_retry_1', status: 'in_transit' }),
        } as any)
        // Second attempt (retry with same reference): Stripe replays same objects
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'tr_retry_1' }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'po_retry_1', status: 'in_transit' }),
        } as any);

      global.fetch = fetchMock;

      const params = {
        amount: 120.0,
        currency: 'USD',
        reference: 'PAYOUT-RETRY-001',
        stripeAccountId: 'acct_target_123',
        speed: 'instant' as const,
      };

      const first = await engine.disburse(params);
      const retry = await engine.disburse(params);

      expect(first.success).toBe(true);
      expect(first.status).toBe('PENDING');
      expect(first.providerStatus).toBe('in_transit');
      expect(first.reference).toBe('PAYOUT-RETRY-001');
      expect(first.transactionId).toBe('po_retry_1');

      expect(retry.reference).toBe(first.reference);
      expect(retry.transactionId).toBe(first.transactionId);
      expect(retry.status).toBe('PENDING');

      // Verify identical deterministic Idempotency-Key headers across retries
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('PAYOUT-RETRY-001:transfer');
      expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe('PAYOUT-RETRY-001:payout');
      expect(fetchMock.mock.calls[2][1].headers['Idempotency-Key']).toBe('PAYOUT-RETRY-001:transfer');
      expect(fetchMock.mock.calls[3][1].headers['Idempotency-Key']).toBe('PAYOUT-RETRY-001:payout');
      expect(fetchMock.mock.calls[1][1].body).toContain('metadata%5Breference%5D=PAYOUT-RETRY-001');
    });

    it('fetches updated payout status for a previously pending payout', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'po_retry_1',
            status: 'paid',
            amount: 12000,
            currency: 'usd',
            metadata: { reference: 'PAYOUT-RETRY-001' },
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: 'success',
            data: {
              id: 555111,
              reference: 'REF-FLW-PENDING-001',
              status: 'SUCCESSFUL',
              amount: 20000,
              currency: 'NGN',
              fee: 10.75,
            },
          }),
        } as any);

      const stripeStatus = await engine.getPayoutStatus({
        transactionId: 'po_retry_1',
        rail: 'STRIPE_CONNECT',
        stripeAccountId: 'acct_target_123',
      });
      expect(stripeStatus.status).toBe('SUCCESSFUL');
      expect(stripeStatus.providerStatus).toBe('paid');
      expect(stripeStatus.reference).toBe('PAYOUT-RETRY-001');
      expect(stripeStatus.amount).toBe(120);

      const flwStatus = await engine.getPayoutStatus({
        transactionId: '555111',
        rail: 'FLUTTERWAVE',
      });
      expect(flwStatus.status).toBe('SUCCESSFUL');
      expect(flwStatus.providerStatus).toBe('SUCCESSFUL');
      expect(flwStatus.reference).toBe('REF-FLW-PENDING-001');
    });

    it('disburses via Paystack cleanly', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: true,
            data: { recipient_code: 'RCP_mock_123' },
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: true,
            data: {
              id: 888999,
              transfer_code: 'TRF_mock_123',
              reference: 'REF-PS-001',
              status: 'pending',
            },
          }),
        } as any);

      const res = await engine.disburse({
        amount: 30000,
        currency: 'NGN',
        reference: 'REF-PS-001',
        rail: 'PAYSTACK',
        bankDetails: { bankCode: '058', accountNumber: '0123456789', accountName: 'Jane Doe' },
      });

      expect(res.success).toBe(true);
      expect(res.rail).toBe('PAYSTACK');
      expect(res.status).toBe('PENDING');
      expect(res.transactionId).toBe('TRF_mock_123');
      expect(res.reference).toBe('REF-PS-001');
    });

    it('fails over from Flutterwave to Paystack when Flutterwave float is insufficient, keeping the same reference', async () => {
      global.fetch = jest
        .fn()
        // 1. Flutterwave balance check: only 5,000 NGN available (need 45,000)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: 'success',
            data: [{ currency: 'NGN', available_balance: 5000, ledger_balance: 5000 }],
          }),
        } as any)
        // 2. Paystack balance check: 100,000 NGN available (10_000_000 kobo)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: true,
            data: [{ currency: 'NGN', balance: 10000000 }],
          }),
        } as any)
        // 3. Paystack recipient creation
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: true,
            data: { recipient_code: 'RCP_failover_1' },
          }),
        } as any)
        // 4. Paystack transfer
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: true,
            data: {
              transfer_code: 'TRF_failover_1',
              reference: 'PAYOUT-FAILOVER-001',
              status: 'pending',
            },
          }),
        } as any);

      const res = await engine.disburse({
        amount: 45000,
        currency: 'NGN',
        reference: 'PAYOUT-FAILOVER-001',
        rail: 'FLUTTERWAVE',
        fallbackRails: ['PAYSTACK'],
        checkBalanceBeforeDisburse: true,
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });

      expect(res.success).toBe(true);
      expect(res.rail).toBe('PAYSTACK');
      expect(res.failoverFrom).toBe('FLUTTERWAVE');
      expect(res.attemptedRails).toEqual(['FLUTTERWAVE', 'PAYSTACK']);
      expect(res.reference).toBe('PAYOUT-FAILOVER-001');
    });

    it('fetches unified balances across all configured rails', async () => {
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('api.stripe.com')) {
          return {
            ok: true,
            json: async () => ({
              available: [{ currency: 'usd', amount: 250000 }],
              pending: [{ currency: 'usd', amount: 50000 }],
            }),
          };
        }
        if (url.includes('api.flutterwave.com')) {
          return {
            ok: true,
            json: async () => ({
              status: 'success',
              data: [{ currency: 'NGN', available_balance: 750000, ledger_balance: 800000 }],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            status: true,
            data: [{ currency: 'NGN', balance: 50000000 }],
          }),
        };
      });

      const balances = await engine.getBalances();
      expect(balances).toEqual(
        expect.arrayContaining([
          { rail: 'STRIPE_CONNECT', currency: 'USD', available: 2500, pending: 500 },
          { rail: 'FLUTTERWAVE', currency: 'NGN', available: 750000, pending: 50000 },
          { rail: 'PAYSTACK', currency: 'NGN', available: 500000 },
        ])
      );
    });

    it('verifies and normalizes webhooks across Stripe, Flutterwave, and Paystack', () => {
      // Stripe webhook
      const stripeBody = JSON.stringify({
        type: 'payout.paid',
        data: {
          object: {
            id: 'po_wh_1',
            status: 'paid',
            amount: 15000,
            currency: 'usd',
            metadata: { reference: 'REF-STRIPE-WH' },
          },
        },
      });
      const ts = '1700000000';
      const stripeSig = crypto
        .createHmac('sha256', 'whsec_test_stripe')
        .update(`${ts}.${stripeBody}`)
        .digest('hex');
      const stripeEvent = engine.verifyWebhook('STRIPE_CONNECT', stripeBody, `t=${ts},v1=${stripeSig}`);
      expect(stripeEvent.status).toBe('SUCCESSFUL');
      expect(stripeEvent.reference).toBe('REF-STRIPE-WH');
      expect(stripeEvent.amount).toBe(150);

      // Flutterwave webhook
      const flwBody = JSON.stringify({
        event: 'transfer.completed',
        data: {
          id: 9911,
          reference: 'REF-FLW-WH',
          status: 'SUCCESSFUL',
          amount: 45000,
          currency: 'NGN',
        },
      });
      const flwEvent = engine.verifyWebhook('FLUTTERWAVE', flwBody, 'flw_hash_secret');
      expect(flwEvent.status).toBe('SUCCESSFUL');
      expect(flwEvent.reference).toBe('REF-FLW-WH');

      // Paystack webhook
      const psBody = JSON.stringify({
        event: 'transfer.success',
        data: {
          transfer_code: 'TRF_wh_1',
          reference: 'REF-PS-WH',
          status: 'success',
          amount: 4500000,
          currency: 'NGN',
        },
      });
      const psSig = crypto.createHmac('sha512', 'ps_webhook_secret').update(psBody).digest('hex');
      const psEvent = engine.verifyWebhook('PAYSTACK', psBody, psSig);
      expect(psEvent.status).toBe('SUCCESSFUL');
      expect(psEvent.reference).toBe('REF-PS-WH');
      expect(psEvent.amount).toBe(45000);

      // Rejects invalid signature
      expect(() => engine.verifyWebhook('PAYSTACK', psBody, 'bad-signature')).toThrow(
        'Invalid Paystack webhook signature'
      );
    });
  });
});
