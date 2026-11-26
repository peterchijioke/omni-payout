"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  FlutterwaveAdapter: () => FlutterwaveAdapter,
  OmniPayoutEngine: () => OmniPayoutEngine,
  PaystackAdapter: () => PaystackAdapter,
  StripeConnectAdapter: () => StripeConnectAdapter
});
module.exports = __toCommonJS(index_exports);

// src/adapters/stripe.adapter.ts
var import_crypto = __toESM(require("crypto"));
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
  constructor(secretKey, webhookSecret) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
    if (!secretKey) throw new Error("Stripe secret key is required");
  }
  secretKey;
  webhookSecret;
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
  async getBalances() {
    const data = await this.request("/balance", { method: "GET" });
    const byCurrency = /* @__PURE__ */ new Map();
    for (const entry of data.available || []) {
      const currency = String(entry.currency || "").toUpperCase();
      byCurrency.set(currency, {
        rail: "STRIPE_CONNECT",
        currency,
        available: typeof entry.amount === "number" ? entry.amount / 100 : 0,
        pending: 0
      });
    }
    for (const entry of data.pending || []) {
      const currency = String(entry.currency || "").toUpperCase();
      const existing = byCurrency.get(currency) || {
        rail: "STRIPE_CONNECT",
        currency,
        available: 0,
        pending: 0
      };
      existing.pending = typeof entry.amount === "number" ? entry.amount / 100 : 0;
      byCurrency.set(currency, existing);
    }
    return Array.from(byCurrency.values());
  }
  verifyWebhook(rawBody, signatureHeader) {
    if (!this.webhookSecret) {
      throw new Error("Stripe webhookSecret is required to verify webhooks");
    }
    const parts = Object.fromEntries(
      (signatureHeader || "").split(",").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2)
    );
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) {
      throw new Error("Invalid Stripe-Signature header format");
    }
    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = import_crypto.default.createHmac("sha256", this.webhookSecret).update(signedPayload).digest("hex");
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length || !import_crypto.default.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error("Invalid Stripe webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const eventType = String(payload.type || "");
    const obj = payload.data?.object || {};
    const defaultStatus = eventType === "payout.paid" ? "SUCCESSFUL" : eventType === "payout.failed" || eventType === "payout.canceled" ? "FAILED" : "PENDING";
    const status = normalizeStripeStatus(obj.status, defaultStatus);
    return {
      rail: "STRIPE_CONNECT",
      eventType,
      transactionId: String(obj.id || ""),
      reference: String(obj.metadata?.reference || obj.id || ""),
      status,
      providerStatus: obj.status,
      amount: typeof obj.amount === "number" ? obj.amount / 100 : 0,
      currency: String(obj.currency || "").toUpperCase(),
      error: status === "FAILED" ? obj.failure_message || "Stripe payout failed" : void 0,
      rawPayload: payload
    };
  }
};

// src/adapters/flutterwave.adapter.ts
var import_crypto2 = __toESM(require("crypto"));
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
  constructor(secretKey, webhookSecret) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
    if (!secretKey) throw new Error("Flutterwave secret key is required");
  }
  secretKey;
  webhookSecret;
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
  async getBalances() {
    const res = await this.request("/balances", { method: "GET" });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row) => ({
      rail: "FLUTTERWAVE",
      currency: String(row.currency || "").toUpperCase(),
      available: Number(row.available_balance || 0),
      pending: row.ledger_balance !== void 0 ? Number(row.ledger_balance) - Number(row.available_balance || 0) : void 0
    }));
  }
  verifyWebhook(rawBody, verifHash) {
    if (!this.webhookSecret) {
      throw new Error("Flutterwave webhookSecret is required to verify webhooks");
    }
    const sigBuf = Buffer.from(verifHash || "", "utf8");
    const expBuf = Buffer.from(this.webhookSecret, "utf8");
    if (sigBuf.length !== expBuf.length || !import_crypto2.default.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error("Invalid Flutterwave webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const eventType = String(payload.event || "");
    const data = payload.data || {};
    const status = normalizeFlutterwaveStatus(data.status);
    return {
      rail: "FLUTTERWAVE",
      eventType,
      transactionId: String(data.id || ""),
      reference: String(data.reference || ""),
      status,
      providerStatus: data.status,
      amount: data.amount ? Number(data.amount) : 0,
      currency: String(data.currency || "").toUpperCase(),
      error: status === "FAILED" ? data.complete_message || "Flutterwave transfer failed" : void 0,
      rawPayload: payload
    };
  }
};

// src/adapters/paystack.adapter.ts
var import_crypto3 = __toESM(require("crypto"));
function normalizePaystackStatus(rawStatus) {
  if (!rawStatus) return "PENDING";
  switch (rawStatus.toLowerCase()) {
    case "success":
    case "successful":
      return "SUCCESSFUL";
    case "failed":
    case "reversed":
    case "abandoned":
      return "FAILED";
    default:
      return "PENDING";
  }
}
var PaystackAdapter = class {
  constructor(secretKey, webhookSecret) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
    if (!secretKey) throw new Error("Paystack secret key is required");
  }
  secretKey;
  webhookSecret;
  async request(endpoint, options = {}) {
    const url = `https://api.paystack.co${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      ...options.headers
    };
    if (options.method && options.method.toUpperCase() !== "GET" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok || data?.status === false) {
      throw new Error(data?.message || `Paystack request failed with status ${res.status}`);
    }
    return data;
  }
  async resolveBankAccount(bankCode, accountNumber) {
    const query = new URLSearchParams({
      account_number: accountNumber,
      bank_code: bankCode
    });
    const res = await this.request(`/bank/resolve?${query.toString()}`, {
      method: "GET"
    });
    return {
      accountName: res.data?.account_name || "",
      accountNumber: res.data?.account_number || accountNumber,
      bankCode
    };
  }
  async disburse(params) {
    if (!params.bankDetails && !params.mobileMoneyDetails) {
      throw new Error("Either bankDetails or mobileMoneyDetails must be provided for Paystack disbursements");
    }
    const currency = params.currency.toUpperCase();
    const amountInSubunit = Math.round(params.amount * 100);
    const recipientPayload = params.bankDetails ? {
      type: currency === "GHS" ? "ghipss" : currency === "ZAR" ? "basa" : "nuban",
      name: params.bankDetails.accountName || params.bankDetails.accountNumber,
      account_number: params.bankDetails.accountNumber,
      bank_code: params.bankDetails.bankCode,
      currency
    } : {
      type: "mobile_money",
      name: params.mobileMoneyDetails.phone,
      account_number: params.mobileMoneyDetails.phone,
      bank_code: params.mobileMoneyDetails.network.toUpperCase(),
      currency
    };
    const recipientRes = await this.request("/transferrecipient", {
      method: "POST",
      body: JSON.stringify(recipientPayload)
    });
    const recipientCode = recipientRes.data?.recipient_code;
    if (!recipientCode) {
      throw new Error("Paystack failed to return a transfer recipient_code");
    }
    const transferRes = await this.request("/transfer", {
      method: "POST",
      body: JSON.stringify({
        source: "balance",
        amount: amountInSubunit,
        recipient: recipientCode,
        currency,
        reference: params.reference,
        reason: params.narration || "Marketplace disbursement"
      })
    });
    const transferData = transferRes.data || {};
    const status = normalizePaystackStatus(transferData.status);
    return {
      success: status !== "FAILED",
      transactionId: String(transferData.transfer_code || transferData.id || params.reference),
      reference: transferData.reference || params.reference,
      status,
      providerStatus: transferData.status,
      rail: "PAYSTACK",
      amount: params.amount,
      currency,
      error: status === "FAILED" ? transferData.failures || transferRes.message : void 0,
      rawResponse: transferRes
    };
  }
  async getPayoutStatus(transactionId, reference) {
    const endpoint = reference ? `/transfer/verify/${encodeURIComponent(reference)}` : `/transfer/${encodeURIComponent(transactionId)}`;
    const res = await this.request(endpoint, { method: "GET" });
    const transferData = res.data || {};
    const status = normalizePaystackStatus(transferData.status);
    return {
      success: status !== "FAILED",
      transactionId: String(transferData.transfer_code || transferData.id || transactionId),
      reference: transferData.reference || reference || transactionId,
      status,
      providerStatus: transferData.status,
      rail: "PAYSTACK",
      amount: typeof transferData.amount === "number" ? transferData.amount / 100 : 0,
      currency: (transferData.currency || "").toUpperCase(),
      error: status === "FAILED" ? transferData.failures || res.message : void 0,
      rawResponse: res
    };
  }
  async getBalances() {
    const res = await this.request("/balance", { method: "GET" });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row) => ({
      rail: "PAYSTACK",
      currency: String(row.currency || "").toUpperCase(),
      available: typeof row.balance === "number" ? row.balance / 100 : 0
    }));
  }
  verifyWebhook(rawBody, signature) {
    const secret = this.webhookSecret || this.secretKey;
    const expected = import_crypto3.default.createHmac("sha512", secret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(signature || "", "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length || !import_crypto3.default.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error("Invalid Paystack webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const eventType = String(payload.event || "");
    const data = payload.data || {};
    const rawStatus = data.status || (eventType === "transfer.success" ? "success" : eventType === "transfer.failed" || eventType === "transfer.reversed" ? "failed" : "pending");
    const status = normalizePaystackStatus(rawStatus);
    return {
      rail: "PAYSTACK",
      eventType,
      transactionId: String(data.transfer_code || data.id || ""),
      reference: String(data.reference || ""),
      status,
      providerStatus: rawStatus,
      amount: typeof data.amount === "number" ? data.amount / 100 : 0,
      currency: String(data.currency || "").toUpperCase(),
      error: status === "FAILED" ? data.reason || data.failures || "Paystack transfer failed" : void 0,
      rawPayload: payload
    };
  }
};

// src/engine.ts
var AFRICAN_CURRENCIES = /* @__PURE__ */ new Set(["NGN", "KES", "GHS", "UGX", "TZS", "RWF", "XOF", "XAF", "ZAR"]);
var OmniPayoutEngine = class {
  stripe;
  flutterwave;
  paystack;
  constructor(config) {
    if (config.stripe?.secretKey) {
      this.stripe = new StripeConnectAdapter(config.stripe.secretKey, config.stripe.webhookSecret);
    }
    if (config.flutterwave?.secretKey) {
      this.flutterwave = new FlutterwaveAdapter(
        config.flutterwave.secretKey,
        config.flutterwave.webhookSecret
      );
    }
    if (config.paystack?.secretKey) {
      this.paystack = new PaystackAdapter(config.paystack.secretKey, config.paystack.webhookSecret);
    }
  }
  /**
   * Automatically resolves the best primary payout rail based on explicit parameters or currency.
   */
  resolveRail(params) {
    if (params.rail) return params.rail;
    if (params.stripeAccountId) return "STRIPE_CONNECT";
    if (params.bankDetails || params.mobileMoneyDetails || AFRICAN_CURRENCIES.has(params.currency.toUpperCase())) {
      if (!this.flutterwave && this.paystack) return "PAYSTACK";
      return "FLUTTERWAVE";
    }
    return "STRIPE_CONNECT";
  }
  async disburseOnRail(rail, params) {
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
    if (rail === "PAYSTACK") {
      if (!this.paystack) {
        throw new Error("Paystack provider is not configured (missing secretKey)");
      }
      return this.paystack.disburse(params);
    }
    throw new Error(`Unsupported payout rail: ${rail}`);
  }
  /**
   * Unified disbursement method with optional pre-flight balance checks and automatic failover.
   */
  async disburse(params) {
    if (params.amount <= 0) {
      throw new Error("Disbursement amount must be greater than zero");
    }
    if (!params.reference) {
      throw new Error("Unique reference is required for idempotent disbursement");
    }
    const primaryRail = this.resolveRail(params);
    const candidateRails = [primaryRail];
    for (const fallback of params.fallbackRails || []) {
      if (!candidateRails.includes(fallback)) {
        candidateRails.push(fallback);
      }
    }
    const attemptedRails = [];
    let lastError;
    let lastFailedResult;
    const currency = params.currency.toUpperCase();
    for (let i = 0; i < candidateRails.length; i++) {
      const rail = candidateRails[i];
      const hasFallback = i < candidateRails.length - 1;
      attemptedRails.push(rail);
      if (params.checkBalanceBeforeDisburse) {
        try {
          const balances = await this.getBalances(rail);
          const match = balances.find((b) => b.currency === currency);
          if (match && match.available < params.amount) {
            const insufficientErr = new Error(
              `Insufficient ${currency} balance on ${rail}: available ${match.available}, required ${params.amount}`
            );
            lastError = insufficientErr;
            if (hasFallback) {
              continue;
            }
            throw insufficientErr;
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (hasFallback) {
            continue;
          }
          throw lastError;
        }
      }
      try {
        const result = await this.disburseOnRail(rail, params);
        if (result.status === "FAILED" && hasFallback) {
          lastFailedResult = result;
          lastError = new Error(result.error || `${rail} disbursement returned FAILED`);
          continue;
        }
        return {
          ...result,
          attemptedRails,
          failoverFrom: rail !== primaryRail ? primaryRail : void 0
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (hasFallback) {
          continue;
        }
        throw lastError;
      }
    }
    if (lastFailedResult) {
      return {
        ...lastFailedResult,
        attemptedRails
      };
    }
    throw lastError || new Error("All configured payout rails failed");
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
    if (params.rail === "PAYSTACK") {
      if (!this.paystack) {
        throw new Error("Paystack provider is not configured (missing secretKey)");
      }
      return this.paystack.getPayoutStatus(params.transactionId, params.reference);
    }
    throw new Error(`Unsupported payout rail: ${params.rail}`);
  }
  /**
   * Queries available float balances for a specific rail or across all configured rails.
   */
  async getBalances(rail) {
    if (rail === "STRIPE_CONNECT") {
      if (!this.stripe) throw new Error("Stripe Connect provider is not configured (missing secretKey)");
      return this.stripe.getBalances();
    }
    if (rail === "FLUTTERWAVE") {
      if (!this.flutterwave) throw new Error("Flutterwave provider is not configured (missing secretKey)");
      return this.flutterwave.getBalances();
    }
    if (rail === "PAYSTACK") {
      if (!this.paystack) throw new Error("Paystack provider is not configured (missing secretKey)");
      return this.paystack.getBalances();
    }
    const tasks = [];
    if (this.stripe) tasks.push(this.stripe.getBalances());
    if (this.flutterwave) tasks.push(this.flutterwave.getBalances());
    if (this.paystack) tasks.push(this.paystack.getBalances());
    const results = await Promise.all(tasks);
    return results.flat();
  }
  /**
   * Verifies a provider webhook signature and normalizes the event into a unified WebhookEvent.
   */
  verifyWebhook(rail, rawBody, signature) {
    if (rail === "STRIPE_CONNECT") {
      if (!this.stripe) throw new Error("Stripe Connect provider is not configured");
      return this.stripe.verifyWebhook(rawBody, signature);
    }
    if (rail === "FLUTTERWAVE") {
      if (!this.flutterwave) throw new Error("Flutterwave provider is not configured");
      return this.flutterwave.verifyWebhook(rawBody, signature);
    }
    if (rail === "PAYSTACK") {
      if (!this.paystack) throw new Error("Paystack provider is not configured");
      return this.paystack.verifyWebhook(rawBody, signature);
    }
    throw new Error(`Unsupported payout rail: ${rail}`);
  }
  /**
   * Resolves a Nigerian / African bank account name using Flutterwave or Paystack.
   */
  async resolveBankAccount(bankCode, accountNumber, rail) {
    if (rail === "PAYSTACK" || !rail && !this.flutterwave && this.paystack) {
      if (!this.paystack) {
        throw new Error("Paystack provider is not configured for bank resolution");
      }
      return this.paystack.resolveBankAccount(bankCode, accountNumber);
    }
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
  PaystackAdapter,
  StripeConnectAdapter
});
//# sourceMappingURL=index.js.map