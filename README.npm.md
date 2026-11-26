# @peterchijioke/omni-payout

> **Unified multi-rail payout engine for Node.js & TypeScript with float-aware failover, per-rail circuit breakers, idempotent retries, and normalized webhooks across Stripe Connect, Flutterwave, Paystack, PawaPay, Yellow Card, and M-Pesa Daraja.**

[![npm version](https://img.shields.io/npm/v/@peterchijioke/omni-payout.svg)](https://www.npmjs.com/package/@peterchijioke/omni-payout)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Supported Rails

| Rail | `PayoutRail` | Regions / Corridors | Payout Methods | Idempotency | Webhook Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Stripe Connect** | `'STRIPE_CONNECT'` | US, EU, UK, Global | Transfers & Instant Card Payouts | `Idempotency-Key` header | `Stripe-Signature` (HMAC-SHA256) |
| **Flutterwave** | `'FLUTTERWAVE'` | NG, KE, GH, UG, TZ, RW, ZA, XOF | NIP Bank & Mobile Money | `reference` | `verif-hash` |
| **Paystack** | `'PAYSTACK'` | NG, GH, ZA, KE | NUBAN / GHIPSS / BASA & MoMo | `reference` | `x-paystack-signature` (HMAC-SHA512) |
| **PawaPay** | `'PAWAPAY'` | Pan-African Mobile Money | M-Pesa, MTN, Airtel, Orange, Wave | `payoutId` | HMAC-SHA256 |
| **Yellow Card** | `'YELLOW_CARD'` | 20+ African countries | Local Bank & Mobile Money | `sequenceId` (`YcHmacV1` signed) | `X-YC-Signature` (HMAC-SHA256) |
| **M-Pesa Daraja** | `'MPESA_DARAJA'` | Kenya (KES) | Safaricom B2C Mobile Money | `OriginatorConversationID` | B2C `Result` callback |

---

## Installation

```bash
npm install @peterchijioke/omni-payout
```

Zero external runtime dependencies — uses native `fetch` and Node's built-in `crypto`.

---

## Initialization

Configure only the rails you use:

```typescript
import { OmniPayoutEngine } from '@peterchijioke/omni-payout';

const payoutEngine = new OmniPayoutEngine({
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
  flutterwave: {
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY!,
    webhookSecret: process.env.FLW_WEBHOOK_SECRET,
  },
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY!,
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET,
  },
  pawapay: {
    apiToken: process.env.PAWAPAY_TOKEN!,
    baseUrl: 'https://api.pawapay.io', // optional (defaults to production)
    webhookSecret: process.env.PAWAPAY_WEBHOOK_SECRET,
  },
  yellowCard: {
    apiKey: process.env.YC_API_KEY!,
    secretKey: process.env.YC_SECRET_KEY!,
    webhookSecret: process.env.YC_WEBHOOK_SECRET,
  },
  mpesaDaraja: {
    consumerKey: process.env.MPESA_CONSUMER_KEY!,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
    shortCode: process.env.MPESA_SHORT_CODE!,
    initiatorName: process.env.MPESA_INITIATOR!,
    securityCredential: process.env.MPESA_SECURITY_CREDENTIAL!,
    resultUrl: 'https://api.example.com/webhooks/mpesa/result',
    queueTimeoutUrl: 'https://api.example.com/webhooks/mpesa/timeout',
  },
  // Optional circuit-breaker thresholds per rail
  health: {
    failureThreshold: 3, // open circuit after 3 consecutive failures
    cooldownMs: 30_000,  // skip unhealthy rail for 30s
    maxLatencyMs: 10_000,
  },
});
```

---

## API Reference

### 1. `disburse(params)`
Executes a payout with automatic rail resolution, optional pre-flight float checks, circuit-breaker skipping, and automatic failover.

- **Status normalization**: Returns `'PENDING'` when accepted by the provider but not yet received by the recipient (e.g. Stripe `in_transit`, Flutterwave `NEW`, PawaPay `ACCEPTED`, M-Pesa `ACCEPTED`), `'SUCCESSFUL'` when settled, and `'FAILED'` on failure — alongside the raw `providerStatus`.
- **Safe retries**: Passing the same `reference` on retry sends deterministic `Idempotency-Key` headers (Stripe) or provider-native idempotency keys and preserves `reference` across retries and failovers.

```typescript
// Float-aware failover across African rails (Flutterwave -> Paystack -> Yellow Card)
const payout = await payoutEngine.disburse({
  amount: 45000,
  currency: 'NGN',
  reference: 'PAYOUT-NG-002',
  rail: 'FLUTTERWAVE',
  fallbackRails: ['PAYSTACK', 'YELLOW_CARD'],
  checkBalanceBeforeDisburse: true,
  bankDetails: { bankCode: '058', accountNumber: '0123456789' },
  narration: 'Restaurant order settlements',
});

console.log(payout.status);         // 'PENDING' | 'SUCCESSFUL' | 'FAILED'
console.log(payout.providerStatus); // e.g. 'NEW', 'pending', 'in_transit'
console.log(payout.rail);           // Rail that actually executed the payout
console.log(payout.failoverFrom);   // 'FLUTTERWAVE' if it failed over
console.log(payout.attemptedRails); // ['FLUTTERWAVE', 'PAYSTACK']
```

```typescript
// Mobile money failover (M-Pesa Daraja -> PawaPay)
const kesPayout = await payoutEngine.disburse({
  amount: 2500,
  currency: 'KES',
  reference: 'PAYOUT-KE-001',
  rail: 'MPESA_DARAJA',
  fallbackRails: ['PAWAPAY'],
  mobileMoneyDetails: { phone: '254712345678', network: 'MPESA' },
});
```

```typescript
// US/EU Stripe Connect instant payout
const usPayout = await payoutEngine.disburse({
  amount: 150.0,
  currency: 'USD',
  reference: 'PAYOUT-US-001',
  stripeAccountId: 'acct_1N23456789',
  speed: 'instant', // 'standard' | 'instant'
});
```

---

### 2. `getPayoutStatus(params)`
Fetches the latest settlement status of a previously initiated payout (useful when `disburse()` returned `status: 'PENDING'`).

```typescript
const latest = await payoutEngine.getPayoutStatus({
  transactionId: payout.transactionId,
  reference: payout.reference,
  rail: payout.rail,
  // stripeAccountId: 'acct_1N23456789', // required for Stripe instant payouts (po_...)
});
console.log(latest.reference, latest.status, latest.providerStatus);
```

---

### 3. `getBalances(rail?)`
Returns available and pending float balances across **all configured rails**, or for a single specified rail.

```typescript
const allBalances = await payoutEngine.getBalances();
// [{ rail: 'STRIPE_CONNECT', currency: 'USD', available: 2500, pending: 500 }, ...]

const flwBalances = await payoutEngine.getBalances('FLUTTERWAVE');
```

---

### 4. `getRailHealth(rail?)`
Inspects live uptime, latency, and circuit-breaker state for one or all configured rails. When a rail's circuit is open (`circuitOpen: true`), `disburse()` automatically skips it if a `fallbackRails` option is provided.

```typescript
const health = payoutEngine.getRailHealth();
// [{ rail: 'FLUTTERWAVE', healthy: false, circuitOpen: true, consecutiveFailures: 3, avgLatencyMs: 8420, ... }]
```

---

### 5. `verifyWebhook(rail, rawBody, signature)`
Validates provider webhook signatures using constant-time comparison and normalizes all 6 providers into a single `WebhookEvent` object (`rail`, `eventType`, `transactionId`, `reference`, `status`, `providerStatus`, `amount`, `currency`, `error`).

```typescript
// Pass the exact raw request body string and the provider's signature header:
// - STRIPE_CONNECT: req.headers['stripe-signature']
// - FLUTTERWAVE:    req.headers['verif-hash']
// - PAYSTACK:       req.headers['x-paystack-signature']
// - PAWAPAY:        req.headers['x-pawapay-signature'] (if webhookSecret configured)
// - YELLOW_CARD:    req.headers['x-yc-signature']
// - MPESA_DARAJA:   custom secret header (if webhookSecret configured)
const event = payoutEngine.verifyWebhook(
  'PAYSTACK',
  rawBody,
  req.headers['x-paystack-signature'] as string
);

if (event.status === 'SUCCESSFUL') {
  // Mark payout settled using event.reference
}
```

---

### 6. `resolveBankAccount(bankCode, accountNumber, rail?)`
Verifies an African bank account number and retrieves the account holder's legal name via Flutterwave or Paystack before sending money.

```typescript
const account = await payoutEngine.resolveBankAccount('058', '0123456789');
console.log(account.accountName);
```

---

### 7. `createConnectOnboardingLink(params)`
Generates a hosted Stripe Connect Express onboarding URL for US/EU payees.

```typescript
const link = await payoutEngine.createConnectOnboardingLink({
  accountId: 'acct_1N23456789',
  refreshUrl: 'https://example.com/reauth',
  returnUrl: 'https://example.com/return',
});
console.log(link.url);
```

---

### 8. `resolveRail(params)`
Returns the primary `PayoutRail` that `disburse()` would select for a given request without executing a payout.

```typescript
const rail = payoutEngine.resolveRail({
  amount: 2500,
  currency: 'KES',
  reference: 'REF-1',
  mobileMoneyDetails: { phone: '254712345678', network: 'MPESA' },
});
```

---

## License

MIT © [Peter Chukwu](https://github.com/peterchijioke)
