import { OmniPayoutEngine } from '../src/engine';

describe('OmniPayoutEngine', () => {
  const engine = new OmniPayoutEngine({
    stripe: { secretKey: 'sk_test_mock_stripe' },
    flutterwave: { secretKey: 'flw_sec_mock_flw' },
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
  });
});
