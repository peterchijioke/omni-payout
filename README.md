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
| `resolveRail(params)` / `ResolveRail(params)` | Selects the primary payout rail based on explicit `rail`, `stripeAccountId`, `mobileMoneyDetails`, `bankDetails`, or destination `currency`. |
| `disburse(params)` / `Disburse(params)` | Executes a payout. Supports `fallbackRails`, `checkBalanceBeforeDisburse`, and automatic circuit-breaker skipping. Returns normalized `DisburseResult` with `status` (`PENDING`, `SUCCESSFUL`, `FAILED`), `providerStatus`, `reference`, `attemptedRails`, and `failoverFrom`. |
| `getPayoutStatus(params)` / `GetPayoutStatus(params)` | Queries the provider for the latest settlement status of a `PENDING` payout by `transactionId` (and optional `reference` / `stripeAccountId`). |
| `getBalances(rail?)` / `GetBalances(rail)` | Returns available and pending float balances (`RailBalance[]`) for a specific rail, or across **all configured rails** when omitted/`""`. |
| `getRailHealth(rail?)` / `GetRailHealth(rail)` | Returns live uptime/latency telemetry and circuit-breaker state (`healthy`, `circuitOpen`, `consecutiveFailures`, `avgLatencyMs`, `lastError`) for one or all rails. |
| `verifyWebhook(rail, rawBody, signature)` / `VerifyWebhook(rail, rawBody, signature)` | Verifies the provider's webhook signature using constant-time comparison and normalizes the payload (including `fee` and M-Pesa `QUEUE_TIMEOUT`) into a unified `WebhookEvent`. |
| `verifyAndConfirmWebhook(...)` / `VerifyAndConfirmWebhook(...)` | Verifies the webhook signature, blocks out-of-order status regressions (`canTransitionStatus`), and cross-checks the authoritative status & amount directly against the provider API. |
| `resolveBankAccount(bankCode, accountNumber, rail?)` / `ResolveBankAccount(bankCode, accountNumber)` | Resolves and verifies an African bank account holder's legal name with automatic Flutterwave ↔ Paystack failover. |
| `matchAccountNames(expected, resolved, threshold?)` / `MatchAccountNames(...)` | Compares expected vs. resolved legal names, tolerating word-order differences (`"Peter Chukwu"` vs `"CHUKWU CHIJIOKE PETER"`) and honorifics. |
| `normalizeMsisdn(phone, currency?)` / `NormalizeMSISDN(phone, currency)` | Normalizes `+254 712-345-678` / `0712345678` phone numbers into bare E.164 MSISDN digits (`254712345678`) automatically across all mobile money rails. |
| `encryptMpesaInitiatorPassword(pass, certPem)` / `EncryptMpesaInitiatorPassword(...)` | Encrypts plaintext Safaricom Daraja initiator passwords with X.509 / RSA PKCS#1 v1.5 padding automatically when `initiatorPassword` + `certificatePem` are supplied. |
| `createConnectOnboardingLink(params)` *(TypeScript)* | Generates a hosted Stripe Connect Express onboarding URL for US/EU payees. |

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

	// 2. Check settlement status when a payout is accepted but not yet received
	if res.Status == string(omnipayout.StatusPending) {
		latest, _ := engine.GetPayoutStatus(omnipayout.PayoutStatusParams{
			TransactionID: res.TransactionID,
			Reference:     res.Reference,
			Rail:          res.Rail,
		})
		fmt.Printf("Latest: %s (%s)\n", latest.Status, latest.ProviderStatus)
	}

	// 3. Inspect float balances and circuit-breaker health across all rails
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

// 2. Poll settlement status if accepted but not yet received
if (payout.status === 'PENDING') {
  const latest = await payoutEngine.getPayoutStatus({
    transactionId: payout.transactionId,
    reference: payout.reference,
    rail: payout.rail,
  });
  console.log(latest.status, latest.providerStatus);
}

// 3. Query float balances & live rail health
const balances = await payoutEngine.getBalances();
const health = payoutEngine.getRailHealth();

// 4. Verify & normalize incoming provider webhooks
const event = payoutEngine.verifyWebhook('PAYSTACK', rawBody, signatureHeader);
console.log(event.reference, event.status);
```

---

## License

MIT © [Peter Chukwu](https://github.com/peterchijioke)
