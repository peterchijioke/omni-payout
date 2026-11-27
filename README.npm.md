# @peterchijioke/omni-payout

> **Unified multi-rail payout engine for Node.js & TypeScript with float-aware failover, per-rail circuit breakers, idempotent retries, and normalized webhooks across Stripe Connect, Flutterwave, Paystack, PawaPay, Yellow Card, and M-Pesa Daraja.**

[![CI](https://github.com/peterchijioke/omni-payout/actions/workflows/ci.yml/badge.svg)](https://github.com/peterchijioke/omni-payout/actions/workflows/ci.yml)
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

### Built-In Security & Money-Safety Guarantees
- **Timeout-Safe Failover (No Double Payouts)**: Pre-execution failures (`4xx`, `503`, low float, open circuit) fail over immediately; ambiguous timeouts/`502`/`504` automatically query `getPayoutStatus()` by `reference` first and throw `PayoutAmbiguousError` if state cannot be confirmed.
- **Zero-Decimal Currency Safety**: Automatically handles zero-decimal (`UGX`, `RWF`, `XOF`, `XAF`, `JPY`), 2-decimal, and 3-decimal currencies without 100x overpay bugs.
- **Deterministic PawaPay UUIDs**: Automatically hashes human-readable `reference` strings into valid RFC 4122 UUIDs for PawaPay while preserving your original `reference` in responses.
- **Hardened Webhooks & Secret Isolation**: Constant-time HMAC verification, Stripe replay-window enforcement (`webhookToleranceSec`), HTTPS/SSRF `baseUrl` validation, path-traversal guards, and ECMAScript `#private` secret storage (secrets never leak via `JSON.stringify` or `console.log`).
- **Stateless by Default & Pluggable**: Zero dependencies; plug in Redis/Postgres via `idempotencyStore` & `webhookStore`, wire Prometheus/OpenTelemetry via `onTelemetry`, configure fee/limit `routingRules`, `retry` backoff with jitter, `HALF_OPEN` circuit breakers, `balanceCacheTtlMs`, and `waitForSettlement()`.

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
    // Pass pre-encrypted securityCredential OR plaintext initiatorPassword + certificatePem:
    initiatorPassword: process.env.MPESA_INITIATOR_PASSWORD,
    certificatePem: process.env.MPESA_CERT_PEM,
    resultUrl: 'https://api.example.com/webhooks/mpesa/result',
    queueTimeoutUrl: 'https://api.example.com/webhooks/mpesa/timeout',
  },
  // Optional circuit-breaker thresholds per rail (CLOSED -> OPEN -> HALF_OPEN)
  health: {
    failureThreshold: 3, // open circuit after 3 consecutive failures
    cooldownMs: 30_000,  // transition to HALF_OPEN probe after 30s
    maxLatencyMs: 10_000,
  },
  // Optional retry policy (exponential backoff + full jitter for retryable 429 / 503 errors)
  retry: { maxRetries: 3, baseDelayMs: 250, maxDelayMs: 5_000, jitter: true },
  // Optional short-TTL balance cache to minimize GET /balance calls under high throughput
  balanceCacheTtlMs: 10_000,
  // Optional smart routing rules (country, currency, min/max limits, lowest provider fees)
  routingRules: [
    {
      currencies: ['NGN'],
      countries: ['NG'],
      rails: ['FLUTTERWAVE', 'PAYSTACK'],
      fees: {
        FLUTTERWAVE: { flat: 50, percent: 0.5 },
        PAYSTACK: { flat: 10, percent: 0.1 },
      },
    },
  ],
  railLimits: {
    PAYSTACK: { minAmount: 100, maxAmount: 10_000_000 },
  },
  // Optional storage-agnostic persistence & monitoring hooks (plug in Redis, Postgres, OpenTelemetry)
  // idempotencyStore: myRedisIdempotencyStore,
  // webhookStore: myRedisWebhookStore,
  // onTelemetry: (event) => metrics.record(event),
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

### 2. `getPayoutStatus(params)` & `waitForSettlement(params, options?)`
Fetches the latest settlement status of a previously initiated payout, or automatically polls with exponential backoff until `SUCCESSFUL` or `FAILED`.

```typescript
const latest = await payoutEngine.getPayoutStatus({
  transactionId: payout.transactionId,
  reference: payout.reference,
  rail: payout.rail,
  // stripeAccountId: 'acct_1N23456789', // required for Stripe instant payouts (po_...)
});

// Automated polling until terminal state (throws RECONCILIATION_TIMEOUT if still pending)
const settled = await payoutEngine.waitForSettlement(
  { transactionId: payout.transactionId, reference: payout.reference, rail: payout.rail },
  { intervalMs: 2_000, maxAttempts: 10, backoffMultiplier: 1.5, maxIntervalMs: 15_000 }
);
console.log(settled.reference, settled.status, settled.providerStatus);
```

---

### 3. `getBalances(rail?)` & `invalidateBalanceCache(rail?)`
Returns available and pending float balances across **all configured rails**, or for a single specified rail. When `balanceCacheTtlMs` is set, repeated float checks are served from cache until TTL expires or `invalidateBalanceCache()` is called.

```typescript
const allBalances = await payoutEngine.getBalances();
// [{ rail: 'STRIPE_CONNECT', currency: 'USD', available: 2500, pending: 500 }, ...]

const flwBalances = await payoutEngine.getBalances('FLUTTERWAVE');
payoutEngine.invalidateBalanceCache('FLUTTERWAVE');
```

---

### 4. `getRailHealth(rail?)`
Inspects live uptime, latency, and circuit-breaker state (`'CLOSED' | 'OPEN' | 'HALF_OPEN'`) for one or all configured rails. When a rail's circuit is `'OPEN'`, `disburse()` proactively skips it if a fallback rail exists; after `cooldownMs`, it enters `'HALF_OPEN'` and allows a single recovery probe.

```typescript
const health = payoutEngine.getRailHealth();
// [{ rail: 'FLUTTERWAVE', state: 'OPEN', healthy: false, circuitOpen: true, consecutiveFailures: 3, avgLatencyMs: 8420 }]
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

// Or verify signature + cross-check authoritative state & amount against the provider API:
const confirmed = await payoutEngine.verifyAndConfirmWebhook(
  'PAYSTACK',
  rawBody,
  req.headers['x-paystack-signature'] as string,
  { currentStatus: 'PENDING' } // blocks out-of-order regressions (e.g. SUCCESSFUL -> PENDING)
);
```

---

### 6. `resolveBankAccount(bankCode, accountNumber, rail?, currency?)` & `matchAccountNames(...)`
Verifies an African bank account number (with automatic Flutterwave ↔ Paystack failover when `rail` is omitted) and compares the resolved legal name against the expected beneficiary name.

```typescript
const account = await payoutEngine.resolveBankAccount('058', '0123456789');
const nameCheck = payoutEngine.matchAccountNames('Mr. Peter Chukwu', account.accountName);
console.log(nameCheck.matched, nameCheck.score); // true, 0.9167
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

### 8. `resolveRoute(params)` & `resolveRail(params)`
Evaluates configured `routingRules` (by country, currency, amount limits, and lowest fees) without executing a payout.

```typescript
const route = payoutEngine.resolveRoute({
  amount: 25000,
  currency: 'NGN',
  country: 'NG',
  reference: 'REF-1',
  bankDetails: { bankCode: '058', accountNumber: '0123456789' },
});
// ['PAYSTACK', 'FLUTTERWAVE']
```

---

### 9. Normalized Error Codes (`PayoutProviderError`)
All provider errors are normalized into `PayoutProviderError` with `.code`, `.retryable`, `.isAmbiguous`, and `.rail`:

| Code | Meaning |
| :--- | :--- |
| `INSUFFICIENT_FLOAT` | Partner wallet balance is below the payout amount |
| `INVALID_ACCOUNT` | Destination bank account, recipient, or MSISDN is invalid |
| `IDEMPOTENCY_CONFLICT` | Same `reference` reused concurrently or with different amount/currency |
| `AMBIGUOUS_TIMEOUT` | Post-dispatch timeout/`502`/`504`; failover halted to prevent double payout |
| `LIMIT_EXCEEDED` | Amount falls outside `railLimits` or provider min/max bounds |
| `RATE_LIMITED` | HTTP `429` (`retryable: true`) |
| `PROVIDER_DOWN` | HTTP `503`/circuit open (`retryable: true`) |
| `AUTH_FAILED` | Invalid API key, token, or signature credentials |
| `DUPLICATE_WEBHOOK` | Duplicate webhook rejected when `webhookDeduplication.rejectDuplicates` is true |
| `RECONCILIATION_TIMEOUT` | `waitForSettlement()` exhausted `maxAttempts` while payout remained `PENDING` |

---

### 10. Plugging In Custom Persistence & Monitoring (Redis / Postgres / OpenTelemetry)

`omni-payout` is **stateless by default**. To enforce durable idempotency (`IN_PROGRESS`, `AMBIGUOUS`, `COMPLETED`) and webhook deduplication across multiple application instances or restarts, implement `IdempotencyStore` and `WebhookStore` with your own client:

```typescript
import {
  OmniPayoutEngine,
  type IdempotencyStore,
  type IdempotencyRecord,
  type WebhookStore,
} from '@peterchijioke/omni-payout';

// 1. Implement IdempotencyStore (e.g. backed by Redis or Postgres)
class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: any) {}

  async get(reference: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.get(`omni:idemp:${reference}`);
    return raw ? JSON.parse(raw) : null;
  }

  async set(reference: string, record: IdempotencyRecord, ttlMs = 86_400_000): Promise<void> {
    await this.redis.set(`omni:idemp:${reference}`, JSON.stringify(record), 'PX', ttlMs);
  }

  async delete(reference: string): Promise<void> {
    await this.redis.del(`omni:idemp:${reference}`);
  }
}

// 2. Implement WebhookStore for duplicate-event protection
class RedisWebhookStore implements WebhookStore {
  constructor(private readonly redis: any) {}

  async hasSeen(eventKey: string): Promise<boolean> {
    return (await this.redis.exists(`omni:wh:${eventKey}`)) === 1;
  }

  async markSeen(eventKey: string, ttlMs = 86_400_000): Promise<void> {
    await this.redis.set(`omni:wh:${eventKey}`, '1', 'PX', ttlMs);
  }
}

// 3. Pass your stores and telemetry hook into OmniPayoutEngine
const payoutEngine = new OmniPayoutEngine({
  flutterwave: { secretKey: process.env.FLUTTERWAVE_SECRET_KEY! },
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY! },
  idempotencyStore: new RedisIdempotencyStore(redisClient),
  webhookStore: new RedisWebhookStore(redisClient),
  webhookDeduplication: { ttlMs: 86_400_000, rejectDuplicates: false },
  onTelemetry: (ev) => {
    // Export to OpenTelemetry, Prometheus, Datadog, or structured logs
    console.log({ event: ev.type, rail: ev.rail, code: ev.errorCode, latencyMs: ev.latencyMs });
  },
});
```

*(For single-node apps or tests, you can also import the built-in `InMemoryIdempotencyStore` and `InMemoryWebhookStore` helpers.)*

---

### 11. Two-Path Settlement Export & Reconciliation (`exportSettlements`, `reconcileBatch`, `formatSettlementsCsv`)

To make automated payouts auditable ("two paths, same numbers"), run a scheduled job that independently exports settlements directly from your providers and diffs them against your database ledger (including any `AMBIGUOUS` or `PENDING` payouts):

```typescript
// 1. Independently pull settlements for a date window from one or all configured rails
const providerRecords = await payoutEngine.exportSettlements({
  from: new Date('2026-11-26T00:00:00Z'),
  to: new Date('2026-11-26T23:59:59Z'),
  // rail: 'FLUTTERWAVE', // optional: filter to a single provider
  // stripeAccountId: 'acct_...', // optional: export Stripe connected-account payouts
});

// 2. Compare your local ledger (including AMBIGUOUS payouts) against the provider export
const report = payoutEngine.reconcileBatch(
  [
    { reference: 'PAY-US-001', amount: 150, currency: 'USD', status: 'SUCCESSFUL' },
    { reference: 'PAY-NG-002', amount: 45000, currency: 'NGN', status: 'AMBIGUOUS' },
  ],
  providerRecords
);

console.log(report.summary);
// {
//   totalLocalCount, totalProviderCount, matchedCount, discrepancyCount,
//   resolvedAmbiguousCount, totalLocalAmount, totalProviderAmount, totalProviderFees
// }
console.log('Status / AMBIGUOUS diffs:', report.statusMismatches);
console.log('Amount mismatches:', report.amountMismatches);
console.log('Missing on provider:', report.missingOnProvider);
console.log('Paid by provider but missing in local DB:', report.missingInLedger);

// 3. Export RFC 4180 CSV (with spreadsheet formula-injection protection) for accounting
const csv = payoutEngine.formatSettlementsCsv(providerRecords);
```

---

## License

MIT © [Peter Chukwu](https://github.com/peterchijioke)
