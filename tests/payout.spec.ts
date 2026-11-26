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
      const ts = String(Math.floor(Date.now() / 1000));
      const stripeSig = crypto
        .createHmac('sha256', 'whsec_test_stripe')
        .update(`${ts}.${stripeBody}`)
        .digest('hex');
      const stripeEvent = engine.verifyWebhook('STRIPE_CONNECT', stripeBody, `t=${ts},v1=${stripeSig}`);
      expect(stripeEvent.status).toBe('SUCCESSFUL');
      expect(stripeEvent.reference).toBe('REF-STRIPE-WH');
      expect(stripeEvent.amount).toBe(150);

      // Rejects replayed / stale Stripe webhook (> 300s old)
      const staleTs = String(Math.floor(Date.now() / 1000) - 600);
      const staleSig = crypto
        .createHmac('sha256', 'whsec_test_stripe')
        .update(`${staleTs}.${stripeBody}`)
        .digest('hex');
      expect(() =>
        engine.verifyWebhook('STRIPE_CONNECT', stripeBody, `t=${staleTs},v1=${staleSig}`)
      ).toThrow('outside tolerance window');

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

    it('disburses via PawaPay, Yellow Card, and M-Pesa Daraja and verifies their webhooks', async () => {
      const africaEngine = new OmniPayoutEngine({
        pawapay: { apiToken: 'pp_token_mock', webhookSecret: 'pp_wh_secret' },
        yellowCard: { apiKey: 'yc_key_mock', secretKey: 'yc_secret_mock', webhookSecret: 'yc_wh_secret' },
        mpesaDaraja: {
          consumerKey: 'mpesa_key',
          consumerSecret: 'mpesa_secret',
          shortCode: '600999',
          initiatorName: 'testapi',
          securityCredential: 'encrypted_cred',
          resultUrl: 'https://example.com/mpesa/result',
          queueTimeoutUrl: 'https://example.com/mpesa/timeout',
          webhookSecret: 'mpesa_wh_secret',
        },
      });

      const fetchMock = jest.fn().mockImplementation(async (url: string, init?: any) => {
        if (url.includes('pawapay.io')) {
          return {
            ok: true,
            json: async () => ({ payoutId: 'PP-REF-001', status: 'ACCEPTED' }),
          };
        }
        if (url.includes('yellowcard.io')) {
          expect(init.headers['Authorization']).toMatch(/^YcHmacV1 yc_key_mock:/);
          expect(init.headers['X-YC-Timestamp']).toBeDefined();
          return {
            ok: true,
            json: async () => ({ id: 'yc_tx_1', sequenceId: 'YC-REF-001', status: 'processing' }),
          };
        }
        if (url.includes('/oauth/v1/generate')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'mpesa_oauth_token', expires_in: '3599' }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            ResponseCode: '0',
            ConversationID: 'AG_2026_MPESA_1',
            OriginatorConversationID: 'MPESA-REF-001',
          }),
        };
      });
      global.fetch = fetchMock;

      const ppRes = await africaEngine.disburse({
        amount: 2500,
        currency: 'KES',
        reference: 'PP-REF-001',
        rail: 'PAWAPAY',
        mobileMoneyDetails: { phone: '254712345678', network: 'MPESA' },
      });
      expect(ppRes.rail).toBe('PAWAPAY');
      expect(ppRes.status).toBe('PENDING');
      expect(ppRes.reference).toBe('PP-REF-001');

      const ycRes = await africaEngine.disburse({
        amount: 50000,
        currency: 'NGN',
        reference: 'YC-REF-001',
        rail: 'YELLOW_CARD',
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });
      expect(ycRes.rail).toBe('YELLOW_CARD');
      expect(ycRes.status).toBe('PENDING');
      expect(ycRes.reference).toBe('YC-REF-001');

      const mpesaRes = await africaEngine.disburse({
        amount: 1500,
        currency: 'KES',
        reference: 'MPESA-REF-001',
        rail: 'MPESA_DARAJA',
        mobileMoneyDetails: { phone: '254712345678', network: 'MPESA' },
      });
      expect(mpesaRes.rail).toBe('MPESA_DARAJA');
      expect(mpesaRes.status).toBe('PENDING');
      expect(mpesaRes.reference).toBe('MPESA-REF-001');

      // Verify webhooks for all 3 new rails
      const ppBody = JSON.stringify({ payoutId: 'PP-REF-001', status: 'COMPLETED', amount: '2500', currency: 'KES' });
      const ppSig = crypto.createHmac('sha256', 'pp_wh_secret').update(ppBody).digest('hex');
      expect(africaEngine.verifyWebhook('PAWAPAY', ppBody, ppSig).status).toBe('SUCCESSFUL');

      const ycBody = JSON.stringify({ id: 'yc_tx_1', sequenceId: 'YC-REF-001', status: 'complete', localAmount: 50000, currency: 'NGN' });
      const ycSig = crypto.createHmac('sha256', 'yc_wh_secret').update(ycBody).digest('base64');
      expect(africaEngine.verifyWebhook('YELLOW_CARD', ycBody, ycSig).status).toBe('SUCCESSFUL');

      const mpesaBody = JSON.stringify({
        Result: {
          ResultCode: 0,
          OriginatorConversationID: 'MPESA-REF-001',
          TransactionID: 'QWE123RTY',
          ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 1500 }] },
        },
      });
      const mpesaEv = africaEngine.verifyWebhook('MPESA_DARAJA', mpesaBody, 'mpesa_wh_secret');
      expect(mpesaEv.status).toBe('SUCCESSFUL');
      expect(mpesaEv.amount).toBe(1500);
    });

    it('opens circuit breaker after repeated failures and proactively skips the stalled rail', async () => {
      const cbEngine = new OmniPayoutEngine({
        flutterwave: { secretKey: 'flw_mock' },
        paystack: { secretKey: 'ps_mock' },
        health: { failureThreshold: 2, cooldownMs: 60_000 },
      });

      let flwCalls = 0;
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('api.flutterwave.com')) {
          flwCalls++;
          return { ok: false, status: 503, json: async () => ({ status: 'error', message: 'Gateway timeout' }) };
        }
        if (url.includes('/transferrecipient')) {
          return { ok: true, json: async () => ({ status: true, data: { recipient_code: 'RCP_cb_1' } }) };
        }
        return {
          ok: true,
          json: async () => ({ status: true, data: { transfer_code: 'TRF_cb_1', reference: 'REF-CB', status: 'pending' } }),
        };
      });

      // Trip the circuit breaker with 2 consecutive failures on Flutterwave
      await expect(
        cbEngine.disburse({
          amount: 10000,
          currency: 'NGN',
          reference: 'REF-CB-1',
          rail: 'FLUTTERWAVE',
          bankDetails: { bankCode: '058', accountNumber: '0123456789' },
        })
      ).rejects.toThrow();

      await expect(
        cbEngine.disburse({
          amount: 10000,
          currency: 'NGN',
          reference: 'REF-CB-2',
          rail: 'FLUTTERWAVE',
          bankDetails: { bankCode: '058', accountNumber: '0123456789' },
        })
      ).rejects.toThrow();

      expect(flwCalls).toBe(2);
      const [flwHealth] = cbEngine.getRailHealth('FLUTTERWAVE');
      expect(flwHealth.circuitOpen).toBe(true);
      expect(flwHealth.healthy).toBe(false);

      // Next payout with fallbackRails should proactively skip Flutterwave (flwCalls stays 2!)
      const res = await cbEngine.disburse({
        amount: 10000,
        currency: 'NGN',
        reference: 'REF-CB',
        rail: 'FLUTTERWAVE',
        fallbackRails: ['PAYSTACK'],
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });

      expect(flwCalls).toBe(2);
      expect(res.rail).toBe('PAYSTACK');
      expect(res.failoverFrom).toBe('FLUTTERWAVE');
      expect(res.attemptedRails).toEqual(['PAYSTACK']);
    });

    it('halts failover on ambiguous 504 timeout when state cannot be reconciled, preventing double payouts', async () => {
      let paystackCalls = 0;
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('api.flutterwave.com')) {
          return {
            ok: false,
            status: 504,
            json: async () => ({ status: 'error', message: 'Gateway timeout' }),
          };
        }
        paystackCalls++;
        return { ok: true, json: async () => ({ status: true }) };
      });

      await expect(
        engine.disburse({
          amount: 25000,
          currency: 'NGN',
          reference: 'REF-AMBIGUOUS-1',
          rail: 'FLUTTERWAVE',
          fallbackRails: ['PAYSTACK'],
          bankDetails: { bankCode: '058', accountNumber: '0123456789' },
        })
      ).rejects.toThrow('Failover halted to prevent double payout');

      expect(paystackCalls).toBe(0);
    });

    it('auto-reconciles ambiguous 504 on Paystack by reference without double-paying, and fails over if 404', async () => {
      const reconcileEngine = new OmniPayoutEngine({
        paystack: { secretKey: 'sk_test_mock_paystack' },
        yellowCard: { apiKey: 'yc_mock_k', secretKey: 'yc_mock_s' },
      });
      let ycCalls = 0;
      // Case A: Paystack /transfer returns 504, but /transfer/verify/:reference confirms it WAS created -> returns PENDING, zero YellowCard calls!
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/transferrecipient')) {
          return { ok: true, json: async () => ({ status: true, data: { recipient_code: 'RCP_1' } }) };
        }
        if (url.endsWith('/transfer')) {
          return { ok: false, status: 504, json: async () => ({ status: false, message: 'Gateway Timeout' }) };
        }
        if (url.includes('/transfer/verify/REF-RECONCILE-OK')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: true,
              data: { transfer_code: 'TRF_rec_1', reference: 'REF-RECONCILE-OK', status: 'pending', amount: 1500000, currency: 'NGN' },
            }),
          };
        }
        ycCalls++;
        return { ok: true, json: async () => ({ id: 'yc_1', sequenceId: 'REF-RECONCILE-OK', status: 'processing' }) };
      });

      const reconciled = await reconcileEngine.disburse({
        amount: 15000,
        currency: 'NGN',
        reference: 'REF-RECONCILE-OK',
        rail: 'PAYSTACK',
        fallbackRails: ['YELLOW_CARD'],
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });
      expect(reconciled.rail).toBe('PAYSTACK');
      expect(reconciled.status).toBe('PENDING');
      expect(ycCalls).toBe(0);

      // Case B: /transfer/verify returns 404 (never recorded on Paystack) -> safely fails over to Yellow Card!
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/transferrecipient')) {
          return { ok: true, json: async () => ({ status: true, data: { recipient_code: 'RCP_1' } }) };
        }
        if (url.endsWith('/transfer')) {
          return { ok: false, status: 504, json: async () => ({ status: false, message: 'Gateway Timeout' }) };
        }
        if (url.includes('/transfer/verify/REF-RECONCILE-404')) {
          return { ok: false, status: 404, json: async () => ({ status: false, message: 'Transfer not found' }) };
        }
        ycCalls++;
        return { ok: true, status: 200, json: async () => ({ id: 'yc_2', sequenceId: 'REF-RECONCILE-404', status: 'processing' }) };
      });

      const failedOver = await reconcileEngine.disburse({
        amount: 15000,
        currency: 'NGN',
        reference: 'REF-RECONCILE-404',
        rail: 'PAYSTACK',
        fallbackRails: ['YELLOW_CARD'],
        bankDetails: { bankCode: '058', accountNumber: '0123456789' },
      });
      expect(failedOver.rail).toBe('YELLOW_CARD');
      expect(failedOver.failoverFrom).toBe('PAYSTACK');
      expect(ycCalls).toBe(1);
    });

    it('handles zero-decimal currencies (RWF/XOF) without 100x overpay and converts PawaPay references to valid UUIDs', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'tr_rwf_1', status: 'paid' }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'ACCEPTED' }),
        } as any);
      global.fetch = fetchMock;

      const ppEngine = new OmniPayoutEngine({
        stripe: { secretKey: 'sk_test_mock' },
        pawapay: { apiToken: 'pp_tok' },
      });

      await ppEngine.disburse({
        amount: 5000,
        currency: 'RWF',
        reference: 'REF-RWF-ZERO-DEC',
        stripeAccountId: 'acct_rwf_1',
      });
      // RWF is zero-decimal: amount must be 5000, NOT 500000
      expect(fetchMock.mock.calls[0][1].body).toContain('amount=5000');

      const ppRes = await ppEngine.disburse({
        amount: 2500,
        currency: 'KES',
        reference: 'HUMAN-REF-001',
        rail: 'PAWAPAY',
        mobileMoneyDetails: { phone: '254712345678', network: 'MPESA' },
      });
      const sentPayload = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(sentPayload.payoutId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(ppRes.reference).toBe('HUMAN-REF-001');
    });

    it('enforces input sanitization, SSRF/HTTPS baseUrl validation, unsigned webhook rejection, and secret non-leakage', async () => {
      // 1. Secrets cannot leak via JSON.stringify or Object.keys
      const serialized = JSON.stringify(engine);
      expect(serialized).toBe('{}');
      expect(Object.keys(engine)).toEqual([]);

      // 2. Rejects NaN/Infinity amounts and CRLF header-injection references
      await expect(
        engine.disburse({ amount: Number.NaN, currency: 'USD', reference: 'REF-1', stripeAccountId: 'acct_1' })
      ).rejects.toThrow('finite number');
      await expect(
        engine.disburse({ amount: 10, currency: 'USD', reference: 'REF\r\nEvil: 1', stripeAccountId: 'acct_1' })
      ).rejects.toThrow('control characters');

      // 3. Rejects path-traversal transactionId
      await expect(
        engine.getPayoutStatus({ transactionId: '../../charges', rail: 'STRIPE_CONNECT' })
      ).rejects.toThrow('unsafe path characters');

      // 4. Rejects insecure HTTP baseUrl and embedded credentials
      expect(
        () => new OmniPayoutEngine({ pawapay: { apiToken: 'tok', baseUrl: 'http://evil.example.com' } })
      ).toThrow('HTTPS is required');
      expect(
        () => new OmniPayoutEngine({ pawapay: { apiToken: 'tok', baseUrl: 'https://user:pass@api.pawapay.io' } })
      ).toThrow('embed credentials');

      // 5. Rejects webhook verification when webhookSecret is not configured
      const noWhEngine = new OmniPayoutEngine({ pawapay: { apiToken: 'tok' } });
      expect(() => noWhEngine.verifyWebhook('PAWAPAY', '{}', 'sig')).toThrow(
        'webhookSecret is required'
      );
    });
  });
});
