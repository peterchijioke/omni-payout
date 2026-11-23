"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  FlutterwaveAdapter: () => FlutterwaveAdapter,
  OmniPayoutEngine: () => OmniPayoutEngine,
  StripeConnectAdapter: () => StripeConnectAdapter
});
module.exports = __toCommonJS(index_exports);

// src/adapters/stripe.adapter.ts
function normalizeStripeStatus(rawStatus, defaultStatus) {
  if (!rawStatus) return defaultStatus;
  switch (rawStatus.toLowerCase()) {
    case "paid":
    case "succeeded":
    case "successful":
      return "SUCCESSFUL";
    case "failed":
    case "canceled":
    case "cancelled":
      return "FAILED";
    default:
      return "PENDING";
  }
}
var StripeConnectAdapter = class {
  constructor(secretKey) {
    this.secretKey = secretKey;
    if (!secretKey) throw new Error("Stripe secret key is required");
  }
  secretKey;
  async request(endpoint, options = {}) {
    const url = `https://api.stripe.com/v1${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      ...options.headers
    };
    if (options.method && options.method.toUpperCase() !== "GET" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Stripe request failed with status ${res.status}`);
    }
    return data;
  }
  async disburse(params) {
    if (!params.stripeAccountId) {
      throw new Error("stripeAccountId is required for Stripe Connect disbursements");
    }
    const amountInCents = Math.round(params.amount * 100);
    const transferBody = new URLSearchParams({
      amount: String(amountInCents),
      currency: params.currency.toLowerCase(),
      destination: params.stripeAccountId,
      "metadata[reference]": params.reference
    });
    if (params.narration) {
      transferBody.set("description", params.narration);
    }
    const transfer = await this.request("/transfers", {
      method: "POST",
      headers: {
        "Idempotency-Key": `${params.reference}:transfer`
      },
      body: transferBody.toString()
    });
    let transactionId = transfer.id;
    let providerStatus = transfer.status;
    let status = normalizeStripeStatus(transfer.status, "SUCCESSFUL");
    let failureMessage;
    let rawResponse = transfer;
    if (params.speed === "instant") {
      const payoutBody = new URLSearchParams({
        amount: String(amountInCents),
        currency: params.currency.toLowerCase(),
        method: "instant",
        "metadata[reference]": params.reference
      });
      const payout = await this.request("/payouts", {
        method: "POST",
        headers: {
          "Stripe-Account": params.stripeAccountId,
          "Idempotency-Key": `${params.reference}:payout`
        },
        body: payoutBody.toString()
      });
      transactionId = payout.id;
      providerStatus = payout.status;
      status = normalizeStripeStatus(payout.status, "PENDING");
      failureMessage = payout.failure_message || void 0;
      rawResponse = payout;
    }
    return {
      success: status !== "FAILED",
      transactionId,
      reference: params.reference,
      status,
      providerStatus,
      rail: "STRIPE_CONNECT",
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      error: status === "FAILED" ? failureMessage || "Stripe payout failed" : void 0,
      rawResponse
    };
  }
  async getPayoutStatus(transactionId, stripeAccountId, reference) {
    const isPayout = transactionId.startsWith("po_");
    const endpoint = isPayout ? `/payouts/${transactionId}` : `/transfers/${transactionId}`;
    const headers = {};
    if (isPayout && stripeAccountId) {
      headers["Stripe-Account"] = stripeAccountId;
    }
    const data = await this.request(endpoint, { method: "GET", headers });
    const status = normalizeStripeStatus(data.status, isPayout ? "PENDING" : "SUCCESSFUL");
    return {
      success: status !== "FAILED",
      transactionId: data.id || transactionId,
      reference: data.metadata?.reference || reference || transactionId,
      status,
      providerStatus: data.status,
      rail: "STRIPE_CONNECT",
      amount: typeof data.amount === "number" ? data.amount / 100 : 0,
      currency: (data.currency || "").toUpperCase(),
      error: status === "FAILED" ? data.failure_message || "Stripe payout failed" : void 0,
      rawResponse: data
    };
  }
  async createOnboardingLink(params) {
    const body = new URLSearchParams({
      account: params.accountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: params.type || "account_onboarding"
    });
    const data = await this.request("/account_links", {
      method: "POST",
      body: body.toString()
    });
    return {
      url: data.url,
      expiresAt: data.expires_at ? new Date(data.expires_at * 1e3) : void 0
    };
  }
};

// src/adapters/flutterwave.adapter.ts
function normalizeFlutterwaveStatus(rawStatus) {
  if (!rawStatus) return "PENDING";
  switch (rawStatus.toUpperCase()) {
    case "SUCCESSFUL":
    case "SUCCESS":
      return "SUCCESSFUL";
    case "FAILED":
    case "FAIL":
    case "CANCELLED":
    case "CANCELED":
      return "FAILED";
    default:
      return "PENDING";
  }
}
var FlutterwaveAdapter = class {
  constructor(secretKey) {
    this.secretKey = secretKey;
    if (!secretKey) throw new Error("Flutterwave secret key is required");
  }
  secretKey;
  async request(endpoint, options = {}) {
    const url = `https://api.flutterwave.com/v3${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      "Content-Type": "application/json",
      ...options.headers
    };
    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      throw new Error(data?.message || `Flutterwave request failed with status ${res.status}`);
    }
    return data;
  }
  async resolveBankAccount(bankCode, accountNumber) {
    const res = await this.request("/accounts/resolve", {
      method: "POST",
      body: JSON.stringify({
        account_bank: bankCode,
        account_number: accountNumber
      })
    });
    return {
      accountName: res.data.account_name,
      accountNumber: res.data.account_number,
      bankCode
    };
  }
  async disburse(params) {
    let payload;
    if (params.bankDetails) {
      payload = {
        account_bank: params.bankDetails.bankCode,
        account_number: params.bankDetails.accountNumber,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        reference: params.reference,
        narration: params.narration || "Marketplace disbursement",
        debit_currency: params.currency.toUpperCase()
      };
    } else if (params.mobileMoneyDetails) {
      payload = {
        account_bank: params.mobileMoneyDetails.network.toLowerCase(),
        account_number: params.mobileMoneyDetails.phone,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        reference: params.reference,
        narration: params.narration || "Mobile Money payout"
      };
    } else {
      throw new Error("Either bankDetails or mobileMoneyDetails must be provided for African disbursements");
    }
    const res = await this.request("/transfers", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const transferData = res.data || {};
    const status = normalizeFlutterwaveStatus(transferData.status);
    const isSuccess = res.status === "success" && status !== "FAILED";
    return {
      success: isSuccess,
      transactionId: String(transferData.id || params.reference),
      reference: transferData.reference || params.reference,
      status,
      providerStatus: transferData.status,
      rail: "FLUTTERWAVE",
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      fee: transferData.fee ? Number(transferData.fee) : void 0,
      error: status === "FAILED" ? transferData.complete_message || res.message : void 0,
      rawResponse: res
    };
  }
  async getPayoutStatus(transactionId, reference) {
    const res = await this.request(`/transfers/${transactionId}`, {
      method: "GET"
    });
    const transferData = res.data || {};
    const status = normalizeFlutterwaveStatus(transferData.status);
    const isSuccess = res.status === "success" && status !== "FAILED";
    return {
      success: isSuccess,
      transactionId: String(transferData.id || transactionId),
      reference: transferData.reference || reference || transactionId,
      status,
      providerStatus: transferData.status,
      rail: "FLUTTERWAVE",
      amount: transferData.amount ? Number(transferData.amount) : 0,
      currency: (transferData.currency || "").toUpperCase(),
      fee: transferData.fee ? Number(transferData.fee) : void 0,
      error: status === "FAILED" ? transferData.complete_message || res.message : void 0,
      rawResponse: res
    };
  }
};

// src/engine.ts
var AFRICAN_CURRENCIES = /* @__PURE__ */ new Set(["NGN", "KES", "GHS", "UGX", "TZS", "RWF", "XOF", "XAF", "ZAR"]);
var OmniPayoutEngine = class {
  stripe;
  flutterwave;
  constructor(config) {
    if (config.stripe?.secretKey) {
      this.stripe = new StripeConnectAdapter(config.stripe.secretKey);
    }
    if (config.flutterwave?.secretKey) {
      this.flutterwave = new FlutterwaveAdapter(config.flutterwave.secretKey);
    }
  }
  /**
   * Automatically resolves the best payout rail based on explicit parameters or currency.
   */
  resolveRail(params) {
    if (params.rail) return params.rail;
    if (params.stripeAccountId) return "STRIPE_CONNECT";
    if (params.bankDetails || params.mobileMoneyDetails) return "FLUTTERWAVE";
    if (AFRICAN_CURRENCIES.has(params.currency.toUpperCase())) return "FLUTTERWAVE";
    return "STRIPE_CONNECT";
  }
  /**
   * Unified disbursement method across all international and domestic rails.
   */
  async disburse(params) {
    if (params.amount <= 0) {
      throw new Error("Disbursement amount must be greater than zero");
    }
    if (!params.reference) {
      throw new Error("Unique reference is required for idempotent disbursement");
    }
    const rail = this.resolveRail(params);
    if (rail === "STRIPE_CONNECT") {
      if (!this.stripe) {
        throw new Error("Stripe Connect provider is not configured (missing secretKey)");
      }
      return this.stripe.disburse(params);
    }
    if (rail === "FLUTTERWAVE") {
      if (!this.flutterwave) {
        throw new Error("Flutterwave provider is not configured (missing secretKey)");
      }
      return this.flutterwave.disburse(params);
    }
    throw new Error(`Unsupported payout rail: ${rail}`);
  }
  /**
   * Fetches the latest settlement status for a previously initiated payout.
   */
  async getPayoutStatus(params) {
    if (!params.transactionId) {
      throw new Error("transactionId is required to check payout status");
    }
    if (params.rail === "STRIPE_CONNECT") {
      if (!this.stripe) {
        throw new Error("Stripe Connect provider is not configured (missing secretKey)");
      }
      return this.stripe.getPayoutStatus(
        params.transactionId,
        params.stripeAccountId,
        params.reference
      );
    }
    if (params.rail === "FLUTTERWAVE") {
      if (!this.flutterwave) {
        throw new Error("Flutterwave provider is not configured (missing secretKey)");
      }
      return this.flutterwave.getPayoutStatus(params.transactionId, params.reference);
    }
    throw new Error(`Unsupported payout rail: ${params.rail}`);
  }
  /**
   * Resolves a Nigerian / African bank account name using NIP inquiry.
   */
  async resolveBankAccount(bankCode, accountNumber) {
    if (!this.flutterwave) {
      throw new Error("Flutterwave provider is not configured for bank resolution");
    }
    return this.flutterwave.resolveBankAccount(bankCode, accountNumber);
  }
  /**
   * Generates a Stripe Connect Express onboarding URL for US/European merchants and couriers.
   */
  async createConnectOnboardingLink(params) {
    if (!this.stripe) {
      throw new Error("Stripe Connect provider is not configured for onboarding links");
    }
    return this.stripe.createOnboardingLink(params);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FlutterwaveAdapter,
  OmniPayoutEngine,
  StripeConnectAdapter
});
//# sourceMappingURL=index.js.map