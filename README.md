# omni-payout

> **Unified multi-rail marketplace payout and transfer engine bridging Stripe Connect (US/Europe) and Flutterwave / NIP bank transfers & Mobile Money (Africa).**

[![npm version](https://img.shields.io/npm/v/omni-payout.svg)](https://www.npmjs.com/package/omni-payout)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Cross-border marketplaces and platforms expanding between the **United States/Europe and Africa** face an infrastructure disconnect:

- In the US/EU, payees are paid via **Stripe Connect** (Transfers and Instant Card Payouts).
- In Africa, Stripe does not operate, and payees are paid via **NIP Bank Transfers or Mobile Money (M-Pesa, MTN MoMo, Wave)**.

`omni-payout` provides a single unified TypeScript API to onboard payees and disburse payouts across both worlds.

---

## Features

- 🌉 **Unified Cross-Border API**: One single `disburse()` method handles USD Stripe transfers and NGN/KES/GHS bank disbursements.
- ⚡ **Auto-Rail Routing**: Automatically selects the correct provider based on destination currency or parameters.
- 🚀 **Stripe Connect Express**: Generates instant onboarding links and supports instant debit card payouts.
- 🏦 **African Bank Name Resolution**: Validates account numbers and retrieves verified legal entity names before sending money.
- 📱 **Mobile Money Support**: Native payouts to M-Pesa, MTN MoMo, Airtel, Vodafone, Orange, and Wave.

---

## Installation

```bash
npm install omni-payout
```

---

## Quick Start

### 1. Initialize the Engine

```typescript
import { OmniPayoutEngine } from "omni-payout";

const payoutEngine = new OmniPayoutEngine({
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
  },
  flutterwave: {
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY!,
  },
});
```

### 2. Disburse to a US Partner (Stripe Connect)

```typescript
const result = await payoutEngine.disburse({
  amount: 150.0,
  currency: "USD",
  reference: "PAYOUT-US-001",
  stripeAccountId: "acct_1N23456789",
  speed: "instant", // 'instant' or 'standard'
  narration: "Weekly courier earnings",
});

console.log(result);
// {
//   success: true,
//   transactionId: 'po_1N...',
//   reference: 'PAYOUT-US-001',
//   status: 'SUCCESSFUL',
//   rail: 'STRIPE_CONNECT',
//   amount: 150.00,
//   currency: 'USD'
// }
```

### 3. Disburse to a Nigerian / African Partner (NIP Bank Transfer)

```typescript
// 1. Verify bank account name first
const account = await payoutEngine.resolveBankAccount("058", "0123456789");
console.log(account.accountName); // "CHUKWU CHIJIOKE PETER"

// 2. Disburse payout
const result = await payoutEngine.disburse({
  amount: 45000,
  currency: "NGN",
  reference: "PAYOUT-NG-002",
  bankDetails: {
    bankCode: "058", // GTBank
    accountNumber: "0123456789",
  },
  narration: "Restaurant order settlements",
});

console.log(result);
// {
//   success: true,
//   transactionId: '987654',
//   reference: 'PAYOUT-NG-002',
//   status: 'SUCCESSFUL',
//   rail: 'FLUTTERWAVE',
//   amount: 45000,
//   currency: 'NGN',
//   fee: 10.75
// }
```

### 4. Generate Stripe Connect Onboarding Link

```typescript
const link = await payoutEngine.createConnectOnboardingLink({
  accountId: "acct_1N23456789",
  refreshUrl: "https://yourapp.com/finance/refresh",
  returnUrl: "https://yourapp.com/finance/complete",
});

console.log(link.url);
// "https://connect.stripe.com/setup/s/..."
```

---

## License

MIT © [Peter Chijioke](https://github.com/peterchijioke)
