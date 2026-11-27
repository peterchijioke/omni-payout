# omni-payout

> **Unified multi-rail payout engine with float-aware failover, circuit-breaker health routing, idempotent retries, and normalized webhooks across Stripe Connect, Flutterwave, Paystack, PawaPay, Yellow Card, and M-Pesa Daraja.**  
> *Available in both **Go (Golang)** and **TypeScript / Node.js** — zero external dependencies.*

[![CI](https://github.com/peterchijioke/omni-payout/actions/workflows/ci.yml/badge.svg)](https://github.com/peterchijioke/omni-payout/actions/workflows/ci.yml)
[![Go Reference](https://pkg.go.dev/badge/github.com/peterchijioke/omni-payout.svg)](https://pkg.go.dev/github.com/peterchijioke/omni-payout)
[![npm version](https://img.shields.io/npm/v/@peterchijioke/omni-payout.svg)](https://www.npmjs.com/package/@peterchijioke/omni-payout)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Supported Rails

| Rail | Constant (TS / Go) | Regions / Corridors | Payout Methods | Idempotency | Webhook Verification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Stripe Connect** | `STRIPE_CONNECT` / `RailStripeConnect` | US, EU, UK, Global | Transfers & Instant Card Payouts | `Idempotency-Key` header | `Stripe-Signature` (HMAC-SHA256) |
| **Flutterwave** | `FLUTTERWAVE` / `RailFlutterwave` | NG, KE, GH, UG, TZ, RW, ZA, XOF | NIP Bank & Mobile Money | `reference` | `verif-hash` |
| **Paystack** | `PAYSTACK` / `RailPaystack` | NG, GH, ZA, KE | NUBAN / GHIPSS / BASA & MoMo | `reference` | `x-paystack-signature` (HMAC-SHA512) |
| **PawaPay** | `PAWAPAY` / `RailPawaPay` | Pan-African Mobile Money | M-Pesa, MTN, Airtel, Orange, Wave | `payoutId` | HMAC-SHA256 |
| **Yellow Card** | `YELLOW_CARD` / `RailYellowCard` | 20+ African countries | Local Bank & Mobile Money | `sequenceId` (`YcHmacV1` signed) | `X-YC-Signature` (HMAC-SHA256) |
| **M-Pesa Daraja** | `MPESA_DARAJA` / `RailMpesaDaraja` | Kenya (KES) | Safaricom B2C Mobile Money | `OriginatorConversationID` | B2C `Result` callback |

---

## Key Capabilities

- **Float-Aware Failover**: Check partner float balances before sending (`checkBalanceBeforeDisburse`) and automatically fail over across `fallbackRails` (e.g., `FLUTTERWAVE` → `PAYSTACK` → `YELLOW_CARD`) while keeping the **exact same `reference`**.
- **Per-Rail Circuit Breaker & Latency Tracking**: Monitors consecutive failures and latency per rail. When a provider stalls or returns repeated errors, `omni-payout` opens its circuit breaker and proactively routes around it without wasting timeouts.
- **Clear Settlement Statuses**: Distinguishes between *provider accepted* (`PENDING` + raw `providerStatus` like `in_transit`, `NEW`, `ACCEPTED`) and *actually settled* (`SUCCESSFUL`), mapping failures cleanly to `FAILED`.
- **Safe, Idempotent Retries**: Reusing the same `reference` sends deterministic `Idempotency-Key` headers (Stripe) or provider-native idempotency keys and returns the same `reference` on retry or failover.
- **Unified Balances & Webhooks**: Fetch float balances across all configured rails in one call, and verify/normalize webhooks from all 6 providers into a single `WebhookEvent` shape.
- **Hardened Money-Safety & Security**:
  - **Double-Payout Protection**: Distinguishes pre-execution failures (`4xx`/`503`/low float) from post-dispatch timeouts (`502`/`504`/network drop). Automatically reconciles by `reference` when supported and halts failover (`PayoutAmbiguousError` / `AmbiguousPayoutError`) if state cannot be confirmed.
  - **ISO-4217 Currency Precision**: Handles zero-decimal (`UGX`, `RWF`, `XOF`, `XAF`, `JPY`), two-decimal, and three-decimal currencies accurately without 100x minor-unit bugs.
  - **Webhook Replay & Signature Enforcement**: Constant-time signature verification across all 6 rails, mandatory webhook secrets, and Stripe timestamp tolerance checks.
  - **SSRF, Path-Traversal & Secret Redaction**: Enforces HTTPS `baseUrl`s, escapes/validates path identifiers, and stores credentials in ECMAScript `#private` fields (TS) and redacted structs (Go).
- **Zero Dependencies & Stateless by Default**: Pure standard library in both Go and TypeScript. Storage-agnostic `IdempotencyStore` / `WebhookStore` and monitoring-agnostic `onTelemetry` hooks let you plug in Redis, Postgres, OpenTelemetry, or Prometheus without forcing dependencies into the package.
- **Smart Routing, Retry Policies & Automated Reconciliation**: Route by country, currency, min/max limits, and lowest provider fees (`routingRules` / `railLimits`); retry transient `429`/`503` errors with exponential backoff + jitter (`retry`); recover circuits gracefully via `CLOSED` → `OPEN` → `HALF_OPEN` probes; and poll pending transfers via `waitForSettlement()` / `WaitForSettlement()`.

---

## Installation

### Go (Golang)
```bash
go get github.com/peterchijioke/omni-payout
```

### Node.js / TypeScript
```bash
npm install @peterchijioke/omni-payout
```

---

## Core Functions (API Reference)

Every method is available in both **TypeScript** (`camelCase`) and **Go** (`PascalCase`):

| Function (TS / Go) | What it does |
| :--- | :--- |
| `resolveRoute(params)` / `ResolveRoute(params)` | Evaluates `routingRules` (country, currency, min/max limits, lowest provider fees) and returns the ordered candidate rail chain `[primary, ...fallbacks]`. |
| `resolveRail(params)` / `ResolveRail(params)` | Returns the primary payout rail selected by `resolveRoute(params)`. |
| `disburse(params)` / `Disburse(params)` / `DisburseContext(ctx, params)` | Executes a payout with concurrent singleflight deduplication, optional `IdempotencyStore`, `railLimits`, `HALF_OPEN` circuit breakers, retry backoff, float checks, and timeout-safe failover. |
| `getPayoutStatus(params)` / `GetPayoutStatus(params)` | Queries the provider for the latest settlement status of a `PENDING` payout by `transactionId` (and optional `reference` / `stripeAccountId`). |
| `waitForSettlement(params, opts?)` / `WaitForSettlement(ctx, params, opts)` | Polls `getPayoutStatus` with exponential backoff until the payout reaches `SUCCESSFUL` or `FAILED`, or throws `RECONCILIATION_TIMEOUT`. |
| `exportSettlements(params)` / `ExportSettlements(params)` | Independently pulls normalized transfer/payout records for a date range directly from one or all configured providers (Stripe, Flutterwave, Paystack, Yellow Card) for accounting & auditing. |
| `reconcileBatch(local, provider)` / `ReconcileBatch(local, provider)` | Pure, stateless two-path diff comparing your local ledger (including `AMBIGUOUS` / `PENDING` records) against `exportSettlements()` — surfacing matched rows, resolved ambiguous payouts, status/amount mismatches, and missing records. |
| `formatSettlementsCsv(records)` / `FormatSettlementsCSV(records)` | Exports normalized `SettlementRecord[]` as RFC 4180 CSV with automatic spreadsheet formula-injection neutralization. |
| `getBalances(rail?)` / `GetBalances(rail)` | Returns available and pending float balances (`RailBalance[]`) for a specific rail, or concurrently across **all configured rails** (with optional `balanceCacheTtlMs` / `invalidateBalanceCache`). |
| `getRailHealth(rail?)` / `GetRailHealth(rail)` | Returns live uptime/latency telemetry and circuit-breaker state (`CLOSED`, `OPEN`, `HALF_OPEN`, `consecutiveFailures`, `avgLatencyMs`, `lastError`). |
| `verifyWebhook(rail, rawBody, signature)` / `VerifyWebhook(...)` | Verifies the provider's webhook signature using constant-time comparison, flags/rejects duplicates via optional `WebhookStore`, and normalizes `fee` & M-Pesa `QUEUE_TIMEOUT`. *(TS also provides `verifyWebhookAsync` for async stores.)* |
| `verifyAndConfirmWebhook(...)` / `VerifyAndConfirmWebhook(...)` | Verifies the webhook signature, blocks out-of-order status regressions (`canTransitionStatus`), and cross-checks the authoritative status & amount directly against the provider API. |
| `resolveBankAccount(bankCode, accountNumber, rail?)` / `ResolveBankAccount(...)` | Resolves and verifies an African bank account holder's legal name with automatic Flutterwave ↔ Paystack failover. |
| `matchAccountNames(expected, resolved, threshold?)` / `MatchAccountNames(...)` | Compares expected vs. resolved legal names, tolerating word-order differences (`"Peter Chukwu"` vs `"CHUKWU CHIJIOKE PETER"`) and honorifics. |
| `normalizeMsisdn(phone, currency?)` / `NormalizeMSISDN(phone, currency)` | Normalizes `+254 712-345-678` / `0712345678` phone numbers into bare E.164 MSISDN digits (`254712345678`) automatically across all mobile money rails. |
| `encryptMpesaInitiatorPassword(pass, certPem)` / `EncryptMpesaInitiatorPassword(...)` | Encrypts plaintext Safaricom Daraja initiator passwords with X.509 / RSA PKCS#1 v1.5 padding automatically when `initiatorPassword` + `certificatePem` are supplied. |
| `createConnectOnboardingLink(params)` / `CreateConnectOnboardingLink(params)` | Generates a hosted Stripe Connect Express onboarding URL for US/EU payees (full parity in both TS and Go). |

### Normalized Error Codes (`PayoutErrorCode` / `ErrorCode`)
All 6 providers map into consistent, actionable codes on `PayoutProviderError` / `ProviderError` (alongside `retryable: boolean` and `isAmbiguous: boolean`):

`VALIDATION_ERROR` · `IDEMPOTENCY_CONFLICT` · `AUTH_FAILED` · `INVALID_ACCOUNT` · `INSUFFICIENT_FLOAT` · `LIMIT_EXCEEDED` · `RATE_LIMITED` · `PROVIDER_DOWN` · `AMBIGUOUS_TIMEOUT` · `DUPLICATE_REFERENCE` · `DUPLICATE_WEBHOOK` · `WEBHOOK_SIGNATURE_INVALID` · `RECONCILIATION_TIMEOUT` · `PROVIDER_ERROR`

---

## Go (Golang) Quick Start

```go
package main

import (
	"fmt"
	"log"
	"time"

	omnipayout "github.com/peterchijioke/omni-payout"
)

func main() {
	engine := omnipayout.NewEngine(omnipayout.Config{
		StripeSecretKey:          "sk_live_...",
		StripeWebhookSecret:      "whsec_...",
		FlutterwaveSecretKey:     "FLWSECK_...",
		FlutterwaveWebhookSecret: "flw_verif_hash...",
		PaystackSecretKey:        "sk_live_paystack_...",
		PaystackWebhookSecret:    "ps_webhook_secret...",
		PawaPayAPIToken:          "pawapay_token_...",
		YellowCardAPIKey:         "yc_api_key_...",
		YellowCardSecretKey:      "yc_secret_...",
		MpesaDaraja: &omnipayout.MpesaDarajaConfig{
			ConsumerKey:        "mpesa_key",
			ConsumerSecret:     "mpesa_secret",
			ShortCode:          "600999",
			InitiatorName:      "api_initiator",
			SecurityCredential: "encrypted_credential",
			ResultURL:          "https://api.example.com/webhooks/mpesa/result",
			QueueTimeoutURL:    "https://api.example.com/webhooks/mpesa/timeout",
		},
		Health: &omnipayout.HealthConfig{
			FailureThreshold: 3,
			Cooldown:         30 * time.Second,
			MaxLatency:       10 * time.Second,
		},
	})

	// 1. Float-aware failover across African rails (Flutterwave -> Paystack -> Yellow Card)
	res, err := engine.Disburse(omnipayout.DisburseParams{
		Amount:                     45000,
		Currency:                   "NGN",
		Reference:                  "PAYOUT-NG-002", // Safe to reuse on retry; stays identical on failover
		Rail:                       omnipayout.RailFlutterwave,
		FallbackRails:              []omnipayout.PayoutRail{omnipayout.RailPaystack, omnipayout.RailYellowCard},
		CheckBalanceBeforeDisburse: true,
		BankDetails: &omnipayout.BankAccountDetails{
			BankCode:      "058",
			AccountNumber: "0123456789",
		},
		Narration: "Merchant settlement",
	})
	if err != nil {
		log.Fatalf("Payout failed across all rails: %v", err)
	}
	fmt.Printf("Status: %s via %s (FailoverFrom: %s, Ref: %s)\n", res.Status, res.Rail, res.FailoverFrom, res.Reference)

	// 2. Poll until settled (exponential backoff reconciliation)
	if res.Status == string(omnipayout.StatusPending) {
		settled, err := engine.WaitForSettlement(ctx, omnipayout.PayoutStatusParams{
			TransactionID: res.TransactionID,
			Reference:     res.Reference,
			Rail:          res.Rail,
		}, &omnipayout.ReconcileOptions{
			Interval:          2 * time.Second,
			MaxAttempts:       10,
			BackoffMultiplier: 1.5,
		})
		if err != nil {
			log.Printf("Still pending or error: %v", err)
		} else {
			fmt.Printf("Settled: %s (%s)\n", settled.Status, settled.ProviderStatus)
		}
	}

	// 3. Inspect float balances and circuit-breaker health (CLOSED / OPEN / HALF_OPEN)
	balances, _ := engine.GetBalances("")
	health := engine.GetRailHealth("")
	fmt.Printf("Balances: %+v\nHealth: %+v\n", balances, health)
}
```

---

## TypeScript / Node.js Quick Start

```typescript
import { OmniPayoutEngine } from '@peterchijioke/omni-payout';

const payoutEngine = new OmniPayoutEngine({
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY!, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET },
  flutterwave: { secretKey: process.env.FLUTTERWAVE_SECRET_KEY!, webhookSecret: process.env.FLW_WEBHOOK_SECRET },
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY!, webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET },
  pawapay: { apiToken: process.env.PAWAPAY_TOKEN!, webhookSecret: process.env.PAWAPAY_WEBHOOK_SECRET },
  yellowCard: { apiKey: process.env.YC_API_KEY!, secretKey: process.env.YC_SECRET_KEY! },
  mpesaDaraja: {
    consumerKey: process.env.MPESA_CONSUMER_KEY!,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
    shortCode: process.env.MPESA_SHORT_CODE!,
    initiatorName: process.env.MPESA_INITIATOR!,
    securityCredential: process.env.MPESA_SECURITY_CREDENTIAL!,
    resultUrl: 'https://api.example.com/webhooks/mpesa/result',
    queueTimeoutUrl: 'https://api.example.com/webhooks/mpesa/timeout',
  },
  health: { failureThreshold: 3, cooldownMs: 30_000, maxLatencyMs: 10_000 },
});

// 1. Float-aware failover (Flutterwave -> Paystack -> Yellow Card)
const payout = await payoutEngine.disburse({
  amount: 45000,
  currency: 'NGN',
  reference: 'PAYOUT-NG-002',
  rail: 'FLUTTERWAVE',
  fallbackRails: ['PAYSTACK', 'YELLOW_CARD'],
  checkBalanceBeforeDisburse: true,
  bankDetails: { bankCode: '058', accountNumber: '0123456789' },
});

// 2. Poll until settled with exponential backoff
if (payout.status === 'PENDING') {
  const settled = await payoutEngine.waitForSettlement(
    { transactionId: payout.transactionId, reference: payout.reference, rail: payout.rail },
    { intervalMs: 2000, maxAttempts: 10, backoffMultiplier: 1.5 }
  );
  console.log(settled.status, settled.providerStatus);
}

// 3. Query float balances & live rail health (CLOSED / OPEN / HALF_OPEN)
const balances = await payoutEngine.getBalances();
const health = payoutEngine.getRailHealth();

// 4. Verify & confirm incoming provider webhooks against the provider API
const event = await payoutEngine.verifyAndConfirmWebhook('PAYSTACK', rawBody, signatureHeader);
console.log(event.reference, event.status, event.fee);
```

---

## Pluggable Persistence, Smart Routing & Observability

`omni-payout` is **stateless by default** with zero dependencies. Plug in your own Redis/Postgres stores, routing rules, retry policies, and monitoring hooks only when needed:

```typescript
import {
  OmniPayoutEngine,
  InMemoryIdempotencyStore,
  InMemoryWebhookStore,
} from '@peterchijioke/omni-payout';

const engine = new OmniPayoutEngine({
  timeoutMs: 30_000,
  balanceCacheTtlMs: 10_000, // avoid redundant GET /balance calls during bursts
  flutterwave: { secretKey: process.env.FLW_SECRET_KEY!, timeoutMs: 15_000 },
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY!, timeoutMs: 10_000 },

  // Plug in Redis/Postgres implementing IdempotencyStore / WebhookStore (or built-in in-memory helpers)
  idempotencyStore: new InMemoryIdempotencyStore(),
  webhookStore: new InMemoryWebhookStore(),
  webhookDeduplication: { ttlMs: 86_400_000, rejectDuplicates: false },

  // Exponential backoff + full jitter for retryable 429 / 503 errors
  retry: { maxRetries: 3, baseDelayMs: 250, maxDelayMs: 5_000, jitter: true },

  // Route by country, currency, limits, and lowest provider fee
  routingRules: [
    {
      currencies: ['NGN'],
      countries: ['NG'],
      rails: ['FLUTTERWAVE', 'PAYSTACK'],
      fees: {
        FLUTTERWAVE: { flat: 50, percent: 0.5 },
        PAYSTACK: { flat: 10, percent: 0.1 }, // automatically prioritized first
      },
    },
  ],
  railLimits: {
    PAYSTACK: { minAmount: 100, maxAmount: 10_000_000 },
  },

  // Wire into OpenTelemetry, Prometheus, Datadog, or structured logs
  onTelemetry: (ev) => console.log('[omni-payout]', ev.type, ev.rail, ev.errorCode ?? ''),
});
```

### How to Implement Custom Persistence Plugins (Redis / Postgres)

To enforce durable idempotency (`IN_PROGRESS`, `AMBIGUOUS`, `COMPLETED`) and webhook deduplication across multiple instances or restarts, implement `IdempotencyStore` and `WebhookStore` using your existing client (no extra dependencies inside `omni-payout`).

#### TypeScript (Redis Example)

```typescript
import type { IdempotencyStore, IdempotencyRecord, WebhookStore } from '@peterchijioke/omni-payout';
// Bring your own client (e.g. ioredis, node-redis, Prisma, Drizzle, Knex)

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: { get(k: string): Promise<string | null>; set(k: string, v: string, mode: 'PX', ttl: number): Promise<unknown>; del(k: string): Promise<unknown> }) {}

  async get(reference: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.get(`omni:idemp:${reference}`);
    return raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
  }

  async set(reference: string, record: IdempotencyRecord, ttlMs = 86_400_000): Promise<void> {
    await this.redis.set(`omni:idemp:${reference}`, JSON.stringify(record), 'PX', ttlMs);
  }

  async delete(reference: string): Promise<void> {
    await this.redis.del(`omni:idemp:${reference}`);
  }
}

export class RedisWebhookStore implements WebhookStore {
  constructor(private readonly redis: { exists(k: string): Promise<number>; set(k: string, v: string, mode: 'PX', ttl: number): Promise<unknown> }) {}

  async hasSeen(eventKey: string): Promise<boolean> {
    return (await this.redis.exists(`omni:wh:${eventKey}`)) === 1;
  }

  async markSeen(eventKey: string, ttlMs = 86_400_000): Promise<void> {
    await this.redis.set(`omni:wh:${eventKey}`, '1', 'PX', ttlMs);
  }
}
```

#### Go (Redis / Custom Store Example)

Implement the `omnipayout.IdempotencyStore` and `omnipayout.WebhookStore` interfaces and pass them in `omnipayout.Config`:

```go
type RedisIdempotencyStore struct{ client *redis.Client }

func (s *RedisIdempotencyStore) Get(ctx context.Context, ref string) (*omnipayout.IdempotencyRecord, error) {
	raw, err := s.client.Get(ctx, "omni:idemp:"+ref).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rec omnipayout.IdempotencyRecord
	return &rec, json.Unmarshal(raw, &rec)
}

func (s *RedisIdempotencyStore) Set(ctx context.Context, ref string, rec omnipayout.IdempotencyRecord, ttl time.Duration) error {
	b, _ := json.Marshal(rec)
	return s.client.Set(ctx, "omni:idemp:"+ref, b, ttl).Err()
}

func (s *RedisIdempotencyStore) Delete(ctx context.Context, ref string) error {
	return s.client.Del(ctx, "omni:idemp:"+ref).Err()
}

// Wire into NewEngine:
engine := omnipayout.NewEngine(omnipayout.Config{
	FlutterwaveSecretKey: os.Getenv("FLW_SECRET_KEY"),
	PaystackSecretKey:    os.Getenv("PAYSTACK_SECRET_KEY"),
	IdempotencyStore:     &RedisIdempotencyStore{client: rdb},
	OnTelemetry: func(ev omnipayout.TelemetryEvent) {
		// Export to Prometheus / OpenTelemetry / structured logs
		log.Printf("event=%s rail=%s code=%s latency_ms=%d", ev.Type, ev.Rail, ev.ErrorCode, ev.LatencyMs)
	},
})
```

---

## Two-Path Audit & Settlement Reconciliation ("Two Paths, Same Numbers")

Run a scheduled reconciliation job that independently exports settlements directly from your providers and diffs them against your local ledger (including any `AMBIGUOUS` or `PENDING` payouts):

### TypeScript

```typescript
// 1. Independently pull settled/pending transfers for the day from all configured rails
const providerRecords = await engine.exportSettlements({
  from: new Date('2026-11-26T00:00:00Z'),
  to: new Date('2026-11-26T23:59:59Z'),
  // rail: 'FLUTTERWAVE', // optional: filter to a single provider
});

// 2. Diff against your database's payout ledger (including AMBIGUOUS / PENDING rows)
const report = engine.reconcileBatch(
  [
    { reference: 'PAY-US-001', amount: 150, currency: 'USD', status: 'SUCCESSFUL' },
    { reference: 'PAY-NG-002', amount: 45000, currency: 'NGN', status: 'AMBIGUOUS' },
  ],
  providerRecords
);

console.log(report.summary);
// { matchedCount, discrepancyCount, resolvedAmbiguousCount, totalLocalAmount, totalProviderAmount, totalProviderFees }
console.log('Resolved AMBIGUOUS / status diffs:', report.statusMismatches);
console.log('Amount mismatches:', report.amountMismatches);
console.log('Missing on provider:', report.missingOnProvider);
console.log('Paid by provider but missing in local DB:', report.missingInLedger);

// 3. Export formula-safe CSV for finance/accounting
const csv = engine.formatSettlementsCsv(providerRecords);
```

### Go (Golang)

```go
// 1. Independently pull settlements for the day across all configured rails
providerRecords, err := engine.ExportSettlements(omnipayout.SettlementExportParams{
	From: time.Date(2026, 11, 26, 0, 0, 0, 0, time.UTC),
	To:   time.Date(2026, 11, 26, 23, 59, 59, 0, time.UTC),
	// Rail: omnipayout.RailFlutterwave, // optional: filter to a single rail
})
if err != nil {
	log.Fatalf("settlement export failed: %v", err)
}

// 2. Diff against your local ledger (including AMBIGUOUS payouts)
report := engine.ReconcileBatch([]omnipayout.LocalLedgerRecord{
	{Reference: "PAY-US-001", Amount: 150, Currency: "USD", Status: string(omnipayout.StatusSuccessful)},
	{Reference: "PAY-NG-002", Amount: 45000, Currency: "NGN", Status: string(omnipayout.IdempotencyAmbiguous)},
}, providerRecords)

fmt.Printf("Matched: %d, Discrepancies: %d, Resolved AMBIGUOUS: %d\n",
	report.Summary.MatchedCount,
	report.Summary.DiscrepancyCount,
	report.Summary.ResolvedAmbiguousCount,
)

// 3. Export formula-safe CSV for accounting
csvData := engine.FormatSettlementsCSV(providerRecords)
fmt.Println(csvData)
```

---

## License

MIT © [Peter Chukwu](https://github.com/peterchijioke)
