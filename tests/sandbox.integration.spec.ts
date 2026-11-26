import { OmniPayoutEngine } from '../src/engine';

/**
 * Opt-in live sandbox integration tests.
 * Automatically skipped in CI/local runs unless sandbox API keys are set in environment variables:
 *   STRIPE_TEST_KEY, PAYSTACK_TEST_KEY, FLUTTERWAVE_TEST_KEY
 */
describe('Live Sandbox Integration Tests (Opt-In)', () => {
  const stripeKey = process.env.STRIPE_TEST_KEY;
  const paystackKey = process.env.PAYSTACK_TEST_KEY;
  const flutterwaveKey = process.env.FLUTTERWAVE_TEST_KEY;

  const maybeStripe = stripeKey ? it : it.skip;
  const maybePaystack = paystackKey ? it : it.skip;
  const maybeFlutterwave = flutterwaveKey ? it : it.skip;

  maybeStripe('fetches live Stripe test-mode balances', async () => {
    const engine = new OmniPayoutEngine({ stripe: { secretKey: stripeKey! } });
    const balances = await engine.getBalances('STRIPE_CONNECT');
    expect(Array.isArray(balances)).toBe(true);
  });

  maybePaystack('fetches live Paystack test-mode balances', async () => {
    const engine = new OmniPayoutEngine({ paystack: { secretKey: paystackKey! } });
    const balances = await engine.getBalances('PAYSTACK');
    expect(Array.isArray(balances)).toBe(true);
  });

  maybeFlutterwave('fetches live Flutterwave sandbox balances', async () => {
    const engine = new OmniPayoutEngine({ flutterwave: { secretKey: flutterwaveKey! } });
    const balances = await engine.getBalances('FLUTTERWAVE');
    expect(Array.isArray(balances)).toBe(true);
  });
});
