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
		StripeSecretKey:      "sk_live_...",
		FlutterwaveSecretKey: "FLWSECK_...",
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

	// 2. Disburse to a Nigerian Vendor (NIP Bank Transfer)
	ngResult, err := engine.Disburse(omnipayout.DisburseParams{
		Amount:    45000,
		Currency:  "NGN",
		Reference: "PAYOUT-NG-002",
		BankDetails: &omnipayout.BankAccountDetails{
			BankCode:      "058", // GTBank
			AccountNumber: "0123456789",
		},
		Narration: "Restaurant order settlements",
	})
	if err != nil {
		log.Fatalf("Flutterwave payout error: %v", err)
	}
	fmt.Printf("NG Payout Success: %s (TxID: %s)\n", ngResult.Status, ngResult.TransactionID)
}
```

---

## TypeScript / Node.js Quick Start

```typescript
import { OmniPayoutEngine } from '@peterchijioke/omni-payout';

const payoutEngine = new OmniPayoutEngine({
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY! },
  flutterwave: { secretKey: process.env.FLUTTERWAVE_SECRET_KEY! },
});

// Automatically routes to Stripe Connect
await payoutEngine.disburse({
  amount: 150.00,
  currency: 'USD',
  reference: 'PAYOUT-US-001',
  stripeAccountId: 'acct_1N23456789',
});

// Automatically routes to Flutterwave NIP Bank Transfer
const payout = await payoutEngine.disburse({
  amount: 45000,
  currency: 'NGN',
  reference: 'PAYOUT-NG-002', // Safe to reuse on retry; stays identical in responses
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
```

---

## License

MIT © [Peter Chukwu](https://github.com/peterchijioke)
