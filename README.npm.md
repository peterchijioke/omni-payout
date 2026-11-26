# @peterchijioke/omni-payout

> **Unified multi-rail marketplace payout and transfer engine for Node.js & TypeScript, bridging Stripe Connect (US/Europe) and Flutterwave / NIP bank transfers & Mobile Money (Africa).**

[![npm version](https://img.shields.io/npm/v/@peterchijioke/omni-payout.svg)](https://www.npmjs.com/package/@peterchijioke/omni-payout)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Cross-border marketplaces and platforms expanding between the **United States/Europe and Africa** face an infrastructure disconnect:
- In the US/EU, payees are paid via **Stripe Connect** (Transfers and Instant Card Payouts).
- In Africa, Stripe does not operate, and payees are paid via **NIP Bank Transfers or Mobile Money (M-Pesa, MTN MoMo, Wave)**.

`@peterchijioke/omni-payout` provides a single unified TypeScript/Node.js API to onboard payees and disburse payouts across both worlds.

---

## Features

- 🌉 **Unified Cross-Border API**: One `disburse()` method handles USD/EUR Stripe transfers and NGN/KES/GHS bank & mobile money disbursements.
- ⚡ **Auto-Rail Routing**: Automatically selects the right provider based on destination currency or parameters.
- 🚀 **Stripe Connect Express**: Supports instant debit card payouts, standard transfers, and onboarding links.
- 🏦 **African Bank Name Resolution**: Validates account numbers and retrieves verified legal entity names via NIP inquiry before sending money.
- 📱 **Mobile Money Support**: Native payouts to M-Pesa, MTN MoMo, Airtel, Vodafone, Orange, and Wave.
- 🔄 **Multi-Rail Failover & Float Checks**: Supports **Stripe Connect**, **Flutterwave**, and **Paystack** with optional pre-flight balance checks (`checkBalanceBeforeDisburse`) and automatic failover (`fallbackRails`) while preserving the exact same `reference`.
- 💰 **Unified Balance & Webhook APIs**: Query float balances across every configured rail (`getBalances()`) and verify/normalize Stripe, Flutterwave, and Paystack webhooks (`verifyWebhook()`).
- 🔁 **Idempotent Retries & Clear Settlement Status**: Deterministic `Idempotency-Key` headers (Stripe) and stable `reference` tracking across retries, normalized `PENDING` / `SUCCESSFUL` / `FAILED` statuses (plus `providerStatus`), and `getPayoutStatus()` for checking unsettled payouts.
- 🔒 **Zero Dependencies**: Pure standard library implementation using native `fetch`.

---

## Installation

```bash
npm install @peterchijioke/omni-payout
```

---

## Quick Start

```typescript
import { OmniPayoutEngine } from '@peterchijioke/omni-payout';

const payoutEngine = new OmniPayoutEngine({
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY!, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET },
  flutterwave: { secretKey: process.env.FLUTTERWAVE_SECRET_KEY!, webhookSecret: process.env.FLW_WEBHOOK_SECRET },
  paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY!, webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET },
});

// 1. Automatically routes to Stripe Connect (US/EU)
const usPayout = await payoutEngine.disburse({
  amount: 150.00,
  currency: 'USD',
  reference: 'PAYOUT-US-001', // Safe to reuse on retry; stays identical in responses
  stripeAccountId: 'acct_1N23456789',
  speed: 'instant', // 'standard' | 'instant'
  narration: 'Weekly courier earnings',
});

// 2. Float-aware failover across African rails (Flutterwave -> Paystack)
const ngPayout = await payoutEngine.disburse({
  amount: 45000,
  currency: 'NGN',
  reference: 'PAYOUT-NG-002',
  rail: 'FLUTTERWAVE',
  fallbackRails: ['PAYSTACK'],
  checkBalanceBeforeDisburse: true,
  bankDetails: { bankCode: '058', accountNumber: '0123456789' },
  narration: 'Restaurant order settlements',
});

// 3. Check settlement status if accepted by the provider but not yet received
if (ngPayout.status === 'PENDING') {
  const latest = await payoutEngine.getPayoutStatus({
    transactionId: ngPayout.transactionId,
    rail: ngPayout.rail,
  });
  console.log(latest.reference, latest.status, latest.providerStatus);
}
```

### Check Float Balances Across Rails

```typescript
const balances = await payoutEngine.getBalances();
console.log(balances);
// [{ rail: 'STRIPE_CONNECT', currency: 'USD', available: 2500, pending: 500 }, ...]
```

### Verify & Normalize Provider Webhooks

```typescript
const event = payoutEngine.verifyWebhook('PAYSTACK', rawBody, req.headers['x-paystack-signature']);
console.log(event.reference, event.status, event.providerStatus);
```

### Verify an African Bank Account (NIP Inquiry)

```typescript
const account = await payoutEngine.resolveBankAccount('058', '0123456789');
console.log(account.accountName);
```

### Create a Stripe Connect Onboarding Link

```typescript
const link = await payoutEngine.createConnectOnboardingLink({
  accountId: 'acct_1N23456789',
  refreshUrl: 'https://example.com/reauth',
  returnUrl: 'https://example.com/return',
});
console.log(link.url);
```

---

## License

MIT © [Peter Chukwu](https://github.com/peterchijioke)
