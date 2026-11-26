# omni-payout

> **Unified multi-rail marketplace payout and transfer engine bridging Stripe Connect (US/Europe) and Flutterwave / NIP bank transfers & Mobile Money (Africa).**  
> *Available in both **Go (Golang)** and **TypeScript / Node.js**.*

[![Go Reference](https://pkg.go.dev/badge/github.com/peterchijioke/omni-payout.svg)](https://pkg.go.dev/github.com/peterchijioke/omni-payout)
[![npm version](https://img.shields.io/npm/v/@peterchijioke/omni-payout.svg)](https://www.npmjs.com/package/@peterchijioke/omni-payout)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Cross-border marketplaces and platforms expanding between the **United States/Europe and Africa** face an infrastructure disconnect:
- In the US/EU, payees are paid via **Stripe Connect** (Transfers and Instant Card Payouts).
- In Africa, Stripe does not operate, and payees are paid via **NIP Bank Transfers or Mobile Money (M-Pesa, MTN MoMo, Wave)**.

`omni-payout` provides a single unified API to onboard payees and disburse payouts across both worlds.

---

## Features

- 🌉 **Unified Cross-Border API**: One single `Disburse()` method handles USD Stripe transfers and NGN/KES/GHS bank disbursements.
- ⚡ **Auto-Rail Routing**: Automatically selects the correct provider based on destination currency or parameters.
- 🚀 **Stripe Connect Express**: Supports instant debit card payouts and standard transfers.
- 🏦 **African Bank Name Resolution**: Validates account numbers and retrieves verified legal entity names before sending money.
- 📱 **Mobile Money Support**: Native payouts to M-Pesa, MTN MoMo, Airtel, Vodafone, Orange, and Wave.
- 🔄 **Multi-Rail Failover & Float Checks**: Supports **Stripe Connect**, **Flutterwave**, and **Paystack** with optional pre-flight balance checks (`checkBalanceBeforeDisburse`) and automatic failover (`fallbackRails`) while preserving the exact same `reference`.
- 💰 **Unified Balance & Webhook APIs**: Query float balances across every configured rail (`getBalances()` / `GetBalances()`) and verify/normalize Stripe, Flutterwave, and Paystack webhooks (`verifyWebhook()` / `VerifyWebhook()`).
- 🔁 **Idempotent Retries & Clear Settlement Status**: Deterministic `Idempotency-Key` headers (Stripe) and stable `reference` tracking across retries, normalized `PENDING` / `SUCCESSFUL` / `FAILED` statuses (plus `providerStatus`), and `getPayoutStatus()` / `GetPayoutStatus()` for checking unsettled payouts.
- 🔒 **Zero Dependencies**: Pure standard library implementation in both Go and TypeScript.

---

## Installation

### For Go (Golang)
```bash
go get github.com/peterchijioke/omni-payout
```

### For Node.js / TypeScript
```bash
npm install @peterchijioke/omni-payout
```

---

## Go (Golang) Quick Start

```go
package main

import (
	"fmt"
	"log"

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
	})

	// 1. Disburse to a US Courier (Stripe Connect)
	usResult, err := engine.Disburse(omnipayout.DisburseParams{
		Amount:          150.00,
		Currency:        "USD",
		Reference:       "PAYOUT-US-001",
		StripeAccountID: "acct_1N23456789",
		Speed:           omnipayout.SpeedInstant, // Instant card payout
		Narration:       "Weekly courier earnings",
	})
	if err != nil {
		log.Fatalf("Stripe payout error: %v", err)
	}
	fmt.Printf("US Payout Success: %s (TxID: %s)\n", usResult.Status, usResult.TransactionID)

	// 2. Disburse to a Nigerian Vendor with float-aware failover (Flutterwave -> Paystack)
	ngResult, err := engine.Disburse(omnipayout.DisburseParams{
		Amount:                     45000,
		Currency:                   "NGN",
		Reference:                  "PAYOUT-NG-002", // Safe to reuse on retry; stays identical across failover
		Rail:                       omnipayout.RailFlutterwave,
		FallbackRails:              []omnipayout.PayoutRail{omnipayout.RailPaystack},
		CheckBalanceBeforeDisburse: true,
		BankDetails: &omnipayout.BankAccountDetails{
			BankCode:      "058", // GTBank
			AccountNumber: "0123456789",
		},
		Narration: "Restaurant order settlements",
	})
	if err != nil {
		log.Fatalf("African payout error: %v", err)
	}
	fmt.Printf("NG Payout: %s via %s (Ref: %s, TxID: %s)\n", ngResult.Status, ngResult.Rail, ngResult.Reference, ngResult.TransactionID)

	// 3. Check settlement status if the payout was accepted but not yet received
	if ngResult.Status == string(omnipayout.StatusPending) {
		latest, err := engine.GetPayoutStatus(omnipayout.PayoutStatusParams{
			TransactionID: ngResult.TransactionID,
			Rail:          ngResult.Rail,
		})
		if err != nil {
			log.Fatalf("Status lookup error: %v", err)
		}
		fmt.Printf("Latest Status: %s (Provider: %s, Ref: %s)\n", latest.Status, latest.ProviderStatus, latest.Reference)
	}

	// 4. Inspect float balances across all configured rails
	balances, _ := engine.GetBalances("")
	fmt.Printf("Balances: %+v\n", balances)
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
});

// Automatically routes to Stripe Connect
await payoutEngine.disburse({
  amount: 150.00,
  currency: 'USD',
  reference: 'PAYOUT-US-001',
  stripeAccountId: 'acct_1N23456789',
});

// Float-aware failover across African rails (Flutterwave -> Paystack)
const payout = await payoutEngine.disburse({
  amount: 45000,
  currency: 'NGN',
  reference: 'PAYOUT-NG-002', // Safe to reuse on retry; stays identical across failover
  rail: 'FLUTTERWAVE',
  fallbackRails: ['PAYSTACK'],
  checkBalanceBeforeDisburse: true,
  bankDetails: { bankCode: '058', accountNumber: '0123456789' },
});

// If accepted by the provider but not yet received by the recipient, status is 'PENDING'
if (payout.status === 'PENDING') {
  const latest = await payoutEngine.getPayoutStatus({
    transactionId: payout.transactionId,
    rail: payout.rail,
  });
  console.log(latest.reference, latest.status, latest.providerStatus);
}

// Check float balances across all configured rails
const balances = await payoutEngine.getBalances();

// Verify and normalize incoming provider webhooks
const event = payoutEngine.verifyWebhook('PAYSTACK', rawBody, signatureHeader);
console.log(event.reference, event.status);
```

---

## License

MIT © [Peter Chukwu](https://github.com/peterchijioke)
