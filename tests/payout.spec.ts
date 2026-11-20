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
  });
});
