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
  MpesaDarajaAdapter: () => MpesaDarajaAdapter,
  OmniPayoutEngine: () => OmniPayoutEngine,
  PawaPayAdapter: () => PawaPayAdapter,
  PayoutAmbiguousError: () => PayoutAmbiguousError,
  PayoutProviderError: () => PayoutProviderError,
  PaystackAdapter: () => PaystackAdapter,
  RailHealthTracker: () => RailHealthTracker,
  StripeConnectAdapter: () => StripeConnectAdapter,
  YellowCardAdapter: () => YellowCardAdapter,
  constantTimeHexEqual: () => constantTimeHexEqual,
  constantTimeStringEqual: () => constantTimeStringEqual,
  currencyExponent: () => currencyExponent,
  fetchWithTimeout: () => fetchWithTimeout,
  fromMinorUnits: () => fromMinorUnits,
  isHttpStatusAmbiguous: () => isHttpStatusAmbiguous,
  sanitizeBaseUrl: () => sanitizeBaseUrl,
  toDeterministicUuid: () => toDeterministicUuid,
  toMinorUnits: () => toMinorUnits,
  validateDisburseInputs: () => validateDisburseInputs,
  validateSafeIdentifier: () => validateSafeIdentifier
});
module.exports = __toCommonJS(index_exports);

// src/utils.ts
var import_crypto = __toESM(require("crypto"));
var ZERO_DECIMAL_CURRENCIES = /* @__PURE__ */ new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF"
]);
var THREE_DECIMAL_CURRENCIES = /* @__PURE__ */ new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var CURRENCY_REGEX = /^[A-Za-z]{3}$/;
var CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
var PayoutProviderError = class extends Error {
  rail;
  statusCode;
  isAmbiguous;
  constructor(opts) {
    super(opts.message);
    this.name = "PayoutProviderError";
    this.rail = opts.rail;
    this.statusCode = opts.statusCode;
    this.isAmbiguous = opts.isAmbiguous;
  }
};
var PayoutAmbiguousError = class extends Error {
  rail;
  reference;
  isAmbiguous = true;
  constructor(rail, reference, causeMessage) {
    super(
      `Ambiguous payout state on ${rail} for reference "${reference}" (${causeMessage}). Failover halted to prevent double payout; verify status with getPayoutStatus() before retrying on another rail.`
    );
    this.name = "PayoutAmbiguousError";
    this.rail = rail;
    this.reference = reference;
  }
};
function currencyExponent(currency) {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return 3;
  return 2;
}
function toMinorUnits(amount, currency) {
  const exp = currencyExponent(currency);
  const factor = Math.pow(10, exp);
  return Math.round(Number((amount * factor).toPrecision(15)));
}
function fromMinorUnits(minorAmount, currency) {
  const exp = currencyExponent(currency);
  const factor = Math.pow(10, exp);
  return minorAmount / factor;
}
function validateDisburseInputs(amount, currency, reference) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Disbursement amount must be a finite number greater than zero");
  }
  if (!currency || !CURRENCY_REGEX.test(currency)) {
    throw new Error("Currency must be a valid 3-letter ISO currency code");
  }
  if (!reference || typeof reference !== "string" || reference.trim().length === 0) {
    throw new Error("Unique reference is required for idempotent disbursement");
  }
  if (reference.length > 200 || CONTROL_CHAR_REGEX.test(reference)) {
    throw new Error("Invalid reference: must be <= 200 characters with no control characters");
  }
}
function validateSafeIdentifier(value, fieldName) {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  if (value.length > 200 || CONTROL_CHAR_REGEX.test(value) || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`Invalid ${fieldName}: contains unsafe path characters`);
  }
  return encodeURIComponent(value.trim());
}
function sanitizeBaseUrl(baseUrl, defaultUrl) {
  if (!baseUrl) return defaultUrl;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid baseUrl: ${baseUrl}`);
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(isLocal && parsed.protocol === "http:")) {
    throw new Error(`Insecure baseUrl protocol "${parsed.protocol}"; HTTPS is required`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("baseUrl must not embed credentials");
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
}
function toDeterministicUuid(reference) {
  const trimmed = reference.trim();
  if (UUID_REGEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const hash = import_crypto.default.createHash("sha256").update(`omni-payout:pawapay:${trimmed}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function isHttpStatusAmbiguous(statusCode) {
  if (statusCode >= 400 && statusCode < 500) return false;
  if (statusCode === 501 || statusCode === 503) return false;
  return statusCode >= 500;
}
async function fetchWithTimeout(url, options, timeoutMs, rail, isMutatingPost = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOptions = options.signal ? options : { ...options, signal: controller.signal };
    return await fetch(url, fetchOptions);
  } catch (err) {
    const isAbort = err?.name === "AbortError" || err?.name === "TimeoutError";
    const message = isAbort ? `${rail} request timed out after ${timeoutMs}ms` : err?.message || `${rail} network request failed`;
    throw new PayoutProviderError({
      message,
      rail,
      isAmbiguous: isMutatingPost
    });
  } finally {
    clearTimeout(timer);
  }
}
function constantTimeHexEqual(providedSig, expectedHex) {
  if (!providedSig || !expectedHex) return false;
  const a = Buffer.from(providedSig.trim().toLowerCase(), "utf8");
  const b = Buffer.from(expectedHex.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return import_crypto.default.timingSafeEqual(a, b);
}
function constantTimeStringEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return import_crypto.default.timingSafeEqual(a, b);
}

// src/health.ts
var RailHealthTracker = class {
  failureThreshold;
  cooldownMs;
  maxLatencyMs;
  stats = /* @__PURE__ */ new Map();
  constructor(config) {
    this.failureThreshold = config?.failureThreshold ?? 3;
    this.cooldownMs = config?.cooldownMs ?? 3e4;
    this.maxLatencyMs = config?.maxLatencyMs ?? 1e4;
  }
  getOrCreate(rail) {
    let state = this.stats.get(rail);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        totalLatencyMs: 0,
        lastLatencyMs: 0,
        circuitOpenUntil: 0
      };
      this.stats.set(rail, state);
    }
    return state;
  }
  isAvailable(rail) {
    const state = this.stats.get(rail);
    if (!state) return true;
    return Date.now() >= state.circuitOpenUntil;
  }
  recordSuccess(rail, latencyMs) {
    const state = this.getOrCreate(rail);
    state.totalRequests += 1;
    state.lastLatencyMs = latencyMs;
    state.totalLatencyMs += latencyMs;
    if (latencyMs > this.maxLatencyMs) {
      state.consecutiveFailures += 1;
      state.lastError = `Latency ${latencyMs}ms exceeded threshold ${this.maxLatencyMs}ms`;
      if (state.consecutiveFailures >= this.failureThreshold) {
        state.circuitOpenUntil = Date.now() + this.cooldownMs;
      }
      return;
    }
    state.consecutiveFailures = 0;
    state.circuitOpenUntil = 0;
  }
  recordFailure(rail, latencyMs, errorMessage) {
    const state = this.getOrCreate(rail);
    state.totalRequests += 1;
    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastLatencyMs = latencyMs;
    state.totalLatencyMs += latencyMs;
    state.lastError = errorMessage;
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.circuitOpenUntil = Date.now() + this.cooldownMs;
    }
  }
  getHealth(rail) {
    const state = this.stats.get(rail);
    if (!state) {
      return {
        rail,
        healthy: true,
        circuitOpen: false,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        lastLatencyMs: 0,
        avgLatencyMs: 0
      };
    }
    const circuitOpen = Date.now() < state.circuitOpenUntil;
    return {
      rail,
      healthy: !circuitOpen,
      circuitOpen,
      consecutiveFailures: state.consecutiveFailures,
      totalRequests: state.totalRequests,
      totalFailures: state.totalFailures,
      lastLatencyMs: state.lastLatencyMs,
      avgLatencyMs: state.totalRequests > 0 ? Math.round(state.totalLatencyMs / state.totalRequests) : 0,
      lastError: state.lastError,
      circuitOpenUntil: circuitOpen ? new Date(state.circuitOpenUntil) : void 0
    };
  }
};

// src/adapters/stripe.adapter.ts
var import_crypto2 = __toESM(require("crypto"));
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
  #secretKey;
  #webhookSecret;
  #webhookToleranceSec;
  #timeoutMs;
  constructor(secretKey, webhookSecret, timeoutMs = 3e4, webhookToleranceSec = 300) {
    if (!secretKey) throw new Error("Stripe secret key is required");
    this.#secretKey = secretKey;
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
    this.#webhookToleranceSec = webhookToleranceSec > 0 ? webhookToleranceSec : 300;
  }
  async request(endpoint, options = {}, isMutatingDisburse = false) {
    const url = `https://api.stripe.com/v1${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.#secretKey}`,
      ...options.headers
    };
    if (options.method && options.method.toUpperCase() !== "GET" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetchWithTimeout(
      url,
      { ...options, headers },
      this.#timeoutMs,
      "STRIPE_CONNECT",
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok) {
      const status = res.status || 500;
      throw new PayoutProviderError({
        message: data?.error?.message || `Stripe request failed with status ${status}`,
        rail: "STRIPE_CONNECT",
        statusCode: status,
        isAmbiguous: isMutatingDisburse && isHttpStatusAmbiguous(status)
      });
    }
    return data;
  }
  async disburse(params) {
    if (!params.stripeAccountId) {
      throw new Error("stripeAccountId is required for Stripe Connect disbursements");
    }
    const currency = params.currency.toUpperCase();
    const amountInMinor = toMinorUnits(params.amount, currency);
    const transferBody = new URLSearchParams({
      amount: String(amountInMinor),
      currency: currency.toLowerCase(),
      destination: params.stripeAccountId,
      "metadata[reference]": params.reference
    });
    if (params.narration) {
      transferBody.set("description", params.narration);
    }
    const transfer = await this.request(
      "/transfers",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `${params.reference}:transfer`
        },
        body: transferBody.toString()
      },
      true
    );
    let transactionId = transfer.id;
    let providerStatus = transfer.status;
    let status = normalizeStripeStatus(transfer.status, "SUCCESSFUL");
    let failureMessage;
    let rawResponse = transfer;
    if (params.speed === "instant") {
      const payoutBody = new URLSearchParams({
        amount: String(amountInMinor),
        currency: currency.toLowerCase(),
        method: "instant",
        "metadata[reference]": params.reference
      });
      const payout = await this.request(
        "/payouts",
        {
          method: "POST",
          headers: {
            "Stripe-Account": params.stripeAccountId,
            "Idempotency-Key": `${params.reference}:payout`
          },
          body: payoutBody.toString()
        },
        true
      );
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
      currency,
      error: status === "FAILED" ? failureMessage || "Stripe payout failed" : void 0,
      rawResponse
    };
  }
  async getPayoutStatus(transactionId, stripeAccountId, reference) {
    const safeId = validateSafeIdentifier(transactionId, "transactionId");
    const isPayout = transactionId.trim().startsWith("po_");
    const endpoint = isPayout ? `/payouts/${safeId}` : `/transfers/${safeId}`;
    const headers = {};
    if (isPayout && stripeAccountId) {
      headers["Stripe-Account"] = stripeAccountId;
    }
    const data = await this.request(endpoint, { method: "GET", headers });
    const status = normalizeStripeStatus(data.status, isPayout ? "PENDING" : "SUCCESSFUL");
    const currency = String(data.currency || "USD").toUpperCase();
    return {
      success: status !== "FAILED",
      transactionId: data.id || transactionId,
      reference: data.metadata?.reference || reference || transactionId,
      status,
      providerStatus: data.status,
      rail: "STRIPE_CONNECT",
      amount: typeof data.amount === "number" ? fromMinorUnits(data.amount, currency) : 0,
      currency,
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
        available: typeof entry.amount === "number" ? fromMinorUnits(entry.amount, currency) : 0,
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
      existing.pending = typeof entry.amount === "number" ? fromMinorUnits(entry.amount, currency) : 0;
      byCurrency.set(currency, existing);
    }
    return Array.from(byCurrency.values());
  }
  verifyWebhook(rawBody, signatureHeader) {
    if (!this.#webhookSecret) {
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
    const tsNum = Number(timestamp);
    if (!Number.isInteger(tsNum) || tsNum <= 0) {
      throw new Error("Invalid Stripe webhook timestamp");
    }
    const nowSec = Math.floor(Date.now() / 1e3);
    if (Math.abs(nowSec - tsNum) > this.#webhookToleranceSec) {
      throw new Error("Stripe webhook timestamp outside tolerance window (possible replay attack)");
    }
    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = import_crypto2.default.createHmac("sha256", this.#webhookSecret).update(signedPayload).digest("hex");
    if (!constantTimeHexEqual(signature, expected)) {
      throw new Error("Invalid Stripe webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const eventType = String(payload.type || "");
    const obj = payload.data?.object || {};
    const defaultStatus = eventType === "payout.paid" ? "SUCCESSFUL" : eventType === "payout.failed" || eventType === "payout.canceled" ? "FAILED" : "PENDING";
    const status = normalizeStripeStatus(obj.status, defaultStatus);
    const currency = String(obj.currency || "USD").toUpperCase();
    return {
      rail: "STRIPE_CONNECT",
      eventType,
      transactionId: String(obj.id || ""),
      reference: String(obj.metadata?.reference || obj.id || ""),
      status,
      providerStatus: obj.status,
      amount: typeof obj.amount === "number" ? fromMinorUnits(obj.amount, currency) : 0,
      currency,
      error: status === "FAILED" ? obj.failure_message || "Stripe payout failed" : void 0,
      rawPayload: payload
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
  #secretKey;
  #webhookSecret;
  #timeoutMs;
  constructor(secretKey, webhookSecret, timeoutMs = 3e4) {
    if (!secretKey) throw new Error("Flutterwave secret key is required");
    this.#secretKey = secretKey;
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
  }
  async request(endpoint, options = {}, isMutatingDisburse = false) {
    const url = `https://api.flutterwave.com/v3${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.#secretKey}`,
      ...options.headers
    };
    if (options.method && options.method.toUpperCase() !== "GET" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchWithTimeout(
      url,
      { ...options, headers },
      this.#timeoutMs,
      "FLUTTERWAVE",
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok || data.status === "error") {
      const status = res.status || (res.ok ? 400 : 500);
      throw new PayoutProviderError({
        message: data?.message || `Flutterwave request failed with status ${status}`,
        rail: "FLUTTERWAVE",
        statusCode: status,
        isAmbiguous: isMutatingDisburse && !res.ok && isHttpStatusAmbiguous(status)
      });
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
      throw new Error(
        "Either bankDetails or mobileMoneyDetails must be provided for African disbursements"
      );
    }
    const res = await this.request(
      "/transfers",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      true
    );
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
    const safeId = validateSafeIdentifier(transactionId, "transactionId");
    const res = await this.request(`/transfers/${safeId}`, {
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
    if (!this.#webhookSecret) {
      throw new Error("Flutterwave webhookSecret is required to verify webhooks");
    }
    if (!constantTimeStringEqual(verifHash, this.#webhookSecret)) {
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
  #secretKey;
  #webhookSecret;
  #timeoutMs;
  constructor(secretKey, webhookSecret, timeoutMs = 3e4) {
    if (!secretKey) throw new Error("Paystack secret key is required");
    this.#secretKey = secretKey;
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
  }
  async request(endpoint, options = {}, isMutatingDisburse = false) {
    const url = `https://api.paystack.co${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.#secretKey}`,
      ...options.headers
    };
    if (options.method && options.method.toUpperCase() !== "GET" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchWithTimeout(
      url,
      { ...options, headers },
      this.#timeoutMs,
      "PAYSTACK",
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok || data?.status === false) {
      const status = res.status || (res.ok ? 400 : 500);
      throw new PayoutProviderError({
        message: data?.message || `Paystack request failed with status ${status}`,
        rail: "PAYSTACK",
        statusCode: status,
        isAmbiguous: isMutatingDisburse && !res.ok && isHttpStatusAmbiguous(status)
      });
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
      throw new Error(
        "Either bankDetails or mobileMoneyDetails must be provided for Paystack disbursements"
      );
    }
    const currency = params.currency.toUpperCase();
    const amountInSubunit = toMinorUnits(params.amount, currency);
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
    const recipientRes = await this.request(
      "/transferrecipient",
      {
        method: "POST",
        body: JSON.stringify(recipientPayload)
      },
      false
    );
    const recipientCode = recipientRes.data?.recipient_code;
    if (!recipientCode) {
      throw new Error("Paystack failed to return a transfer recipient_code");
    }
    const transferRes = await this.request(
      "/transfer",
      {
        method: "POST",
        body: JSON.stringify({
          source: "balance",
          amount: amountInSubunit,
          recipient: recipientCode,
          currency,
          reference: params.reference,
          reason: params.narration || "Marketplace disbursement"
        })
      },
      true
    );
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
    const endpoint = reference ? `/transfer/verify/${validateSafeIdentifier(reference, "reference")}` : `/transfer/${validateSafeIdentifier(transactionId, "transactionId")}`;
    const res = await this.request(endpoint, { method: "GET" });
    const transferData = res.data || {};
    const status = normalizePaystackStatus(transferData.status);
    const currency = String(transferData.currency || "NGN").toUpperCase();
    return {
      success: status !== "FAILED",
      transactionId: String(transferData.transfer_code || transferData.id || transactionId),
      reference: transferData.reference || reference || transactionId,
      status,
      providerStatus: transferData.status,
      rail: "PAYSTACK",
      amount: typeof transferData.amount === "number" ? fromMinorUnits(transferData.amount, currency) : 0,
      currency,
      error: status === "FAILED" ? transferData.failures || res.message : void 0,
      rawResponse: res
    };
  }
  async getBalances() {
    const res = await this.request("/balance", { method: "GET" });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row) => {
      const currency = String(row.currency || "NGN").toUpperCase();
      return {
        rail: "PAYSTACK",
        currency,
        available: typeof row.balance === "number" ? fromMinorUnits(row.balance, currency) : 0
      };
    });
  }
  verifyWebhook(rawBody, signature) {
    const secret = this.#webhookSecret || this.#secretKey;
    const expected = import_crypto3.default.createHmac("sha512", secret).update(rawBody).digest("hex");
    if (!constantTimeHexEqual(signature, expected)) {
      throw new Error("Invalid Paystack webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const eventType = String(payload.event || "");
    const data = payload.data || {};
    const rawStatus = data.status || (eventType === "transfer.success" ? "success" : eventType === "transfer.failed" || eventType === "transfer.reversed" ? "failed" : "pending");
    const status = normalizePaystackStatus(rawStatus);
    const currency = String(data.currency || "NGN").toUpperCase();
    return {
      rail: "PAYSTACK",
      eventType,
      transactionId: String(data.transfer_code || data.id || ""),
      reference: String(data.reference || ""),
      status,
      providerStatus: rawStatus,
      amount: typeof data.amount === "number" ? fromMinorUnits(data.amount, currency) : 0,
      currency,
      error: status === "FAILED" ? data.reason || data.failures || "Paystack transfer failed" : void 0,
      rawPayload: payload
    };
  }
};

// src/adapters/pawapay.adapter.ts
var import_crypto4 = __toESM(require("crypto"));
function normalizePawaPayStatus(rawStatus) {
  if (!rawStatus) return "PENDING";
  switch (rawStatus.toUpperCase()) {
    case "COMPLETED":
    case "SUCCESSFUL":
      return "SUCCESSFUL";
    case "FAILED":
    case "REJECTED":
    case "CANCELLED":
      return "FAILED";
    default:
      return "PENDING";
  }
}
function resolvePawaPayCorrespondent(network, currency) {
  const key = `${network.toUpperCase()}_${currency.toUpperCase()}`;
  const map = {
    MPESA_KES: "MPESA_KEN",
    MTN_GHS: "MTN_MOMO_GHA",
    VODAFONE_GHS: "VODAFONE_GHA",
    AIRTEL_GHS: "AIRTELTIGO_GHA",
    MTN_UGX: "MTN_MOMO_UGA",
    AIRTEL_UGX: "AIRTEL_OAPI_UGA",
    MTN_RWF: "MTN_MOMO_RWA",
    AIRTEL_RWF: "AIRTEL_OAPI_RWA",
    AIRTEL_TZS: "AIRTEL_TZA",
    ORANGE_XOF: "ORANGE_CIV",
    MTN_XOF: "MTN_MOMO_CIV",
    WAVE_XOF: "WAVE_SEN"
  };
  return map[key] || `${network.toUpperCase()}_${currency.toUpperCase()}`;
}
var PawaPayAdapter = class {
  #apiToken;
  #baseUrl;
  #webhookSecret;
  #timeoutMs;
  constructor(apiToken, baseUrl, webhookSecret, timeoutMs = 3e4) {
    if (!apiToken) throw new Error("PawaPay apiToken is required");
    this.#apiToken = apiToken;
    this.#baseUrl = sanitizeBaseUrl(baseUrl, "https://api.pawapay.io");
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
  }
  async request(endpoint, options = {}, isMutatingDisburse = false) {
    const url = `${this.#baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.#apiToken}`,
      ...options.headers
    };
    if (options.method && options.method.toUpperCase() !== "GET" && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchWithTimeout(
      url,
      { ...options, headers },
      this.#timeoutMs,
      "PAWAPAY",
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok) {
      const status = res.status || 500;
      throw new PayoutProviderError({
        message: data?.failureReason?.failureMessage || data?.message || `PawaPay request failed with status ${status}`,
        rail: "PAWAPAY",
        statusCode: status,
        isAmbiguous: isMutatingDisburse && isHttpStatusAmbiguous(status)
      });
    }
    return data;
  }
  async disburse(params) {
    if (!params.mobileMoneyDetails) {
      throw new Error("mobileMoneyDetails is required for PawaPay disbursements");
    }
    const currency = params.currency.toUpperCase();
    const correspondent = params.metadata?.correspondent || resolvePawaPayCorrespondent(params.mobileMoneyDetails.network, currency);
    const payoutId = toDeterministicUuid(params.reference);
    const payload = {
      payoutId,
      amount: String(params.amount),
      currency,
      correspondent,
      recipient: {
        type: "MSISDN",
        address: {
          value: params.mobileMoneyDetails.phone
        }
      },
      customerTimestamp: (/* @__PURE__ */ new Date()).toISOString(),
      statementDescription: (params.narration || "Marketplace payout").slice(0, 22)
    };
    const data = await this.request(
      "/payouts",
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      true
    );
    const rawStatus = data.status || "ACCEPTED";
    const status = normalizePawaPayStatus(rawStatus);
    const errMsg = data.rejectionReason?.rejectionMessage || data.failureReason?.failureMessage;
    return {
      success: status !== "FAILED",
      transactionId: String(data.payoutId || payoutId),
      reference: params.reference,
      status,
      providerStatus: rawStatus,
      rail: "PAWAPAY",
      amount: params.amount,
      currency,
      error: status === "FAILED" ? errMsg || "PawaPay payout rejected" : void 0,
      rawResponse: data
    };
  }
  async getPayoutStatus(transactionId, reference) {
    const lookupId = reference ? toDeterministicUuid(reference) : transactionId;
    const safeId = validateSafeIdentifier(lookupId, "payoutId");
    const raw = await this.request(`/payouts/${safeId}`, { method: "GET" });
    const data = Array.isArray(raw) ? raw[0] || {} : raw.data || raw;
    const status = normalizePawaPayStatus(data.status);
    return {
      success: status !== "FAILED",
      transactionId: String(data.payoutId || lookupId),
      reference: reference || String(data.payoutId || transactionId),
      status,
      providerStatus: data.status,
      rail: "PAWAPAY",
      amount: data.amount ? Number(data.amount) : 0,
      currency: String(data.currency || "").toUpperCase(),
      error: status === "FAILED" ? data.failureReason?.failureMessage || "PawaPay payout failed" : void 0,
      rawResponse: raw
    };
  }
  async getBalances() {
    const res = await this.request("/wallets/balances", { method: "GET" });
    const rows = Array.isArray(res.balances) ? res.balances : Array.isArray(res) ? res : [];
    return rows.map((row) => ({
      rail: "PAWAPAY",
      currency: String(row.currency || "").toUpperCase(),
      available: Number(row.balance ?? row.availableBalance ?? 0)
    }));
  }
  verifyWebhook(rawBody, signature) {
    if (!this.#webhookSecret) {
      throw new Error("PawaPay webhookSecret is required to verify webhooks");
    }
    const expected = import_crypto4.default.createHmac("sha256", this.#webhookSecret).update(rawBody).digest("hex");
    if (!constantTimeHexEqual(signature, expected)) {
      throw new Error("Invalid PawaPay webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const status = normalizePawaPayStatus(payload.status);
    return {
      rail: "PAWAPAY",
      eventType: `payout.${String(payload.status || "updated").toLowerCase()}`,
      transactionId: String(payload.payoutId || ""),
      reference: String(payload.payoutId || ""),
      status,
      providerStatus: payload.status,
      amount: payload.amount ? Number(payload.amount) : 0,
      currency: String(payload.currency || "").toUpperCase(),
      error: status === "FAILED" ? payload.failureReason?.failureMessage || "PawaPay payout failed" : void 0,
      rawPayload: payload
    };
  }
};

// src/adapters/yellowcard.adapter.ts
var import_crypto5 = __toESM(require("crypto"));
function normalizeYellowCardStatus(rawStatus) {
  if (!rawStatus) return "PENDING";
  switch (rawStatus.toLowerCase()) {
    case "complete":
    case "completed":
    case "settled":
    case "successful":
      return "SUCCESSFUL";
    case "failed":
    case "cancelled":
    case "canceled":
    case "rejected":
    case "expired":
      return "FAILED";
    default:
      return "PENDING";
  }
}
var YellowCardAdapter = class {
  #apiKey;
  #secretKey;
  #baseUrl;
  #webhookSecret;
  #timeoutMs;
  constructor(apiKey, secretKey, baseUrl, webhookSecret, timeoutMs = 3e4) {
    if (!apiKey || !secretKey) {
      throw new Error("Yellow Card apiKey and secretKey are required");
    }
    this.#apiKey = apiKey;
    this.#secretKey = secretKey;
    this.#baseUrl = sanitizeBaseUrl(baseUrl, "https://api.yellowcard.io");
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
  }
  buildAuthHeaders(method, path, body) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const upperMethod = method.toUpperCase();
    const hmac = import_crypto5.default.createHmac("sha256", this.#secretKey);
    hmac.update(timestamp);
    hmac.update(path);
    hmac.update(upperMethod);
    if (body) {
      const bodyHash = import_crypto5.default.createHash("sha256").update(body).digest("base64");
      hmac.update(bodyHash);
    }
    const signature = hmac.digest("base64");
    return {
      "X-YC-Timestamp": timestamp,
      Authorization: `YcHmacV1 ${this.#apiKey}:${signature}`
    };
  }
  async request(path, method, bodyObj, isMutatingDisburse = false) {
    const body = bodyObj ? JSON.stringify(bodyObj) : void 0;
    const headers = {
      ...this.buildAuthHeaders(method, path, body),
      ...body ? { "Content-Type": "application/json" } : {}
    };
    const res = await fetchWithTimeout(
      `${this.#baseUrl}${path}`,
      { method, headers, body },
      this.#timeoutMs,
      "YELLOW_CARD",
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok) {
      const status = res.status || 500;
      throw new PayoutProviderError({
        message: data?.message || data?.error || `Yellow Card request failed with status ${status}`,
        rail: "YELLOW_CARD",
        statusCode: status,
        isAmbiguous: isMutatingDisburse && isHttpStatusAmbiguous(status)
      });
    }
    return data;
  }
  async disburse(params) {
    if (!params.bankDetails && !params.mobileMoneyDetails) {
      throw new Error(
        "Either bankDetails or mobileMoneyDetails is required for Yellow Card disbursements"
      );
    }
    const currency = params.currency.toUpperCase();
    const destination = params.bankDetails ? {
      accountType: "bank",
      accountNumber: params.bankDetails.accountNumber,
      accountName: params.bankDetails.accountName || params.bankDetails.accountNumber,
      accountBank: params.bankDetails.bankCode,
      networkId: params.metadata?.networkId || params.bankDetails.bankCode
    } : {
      accountType: "momo",
      accountNumber: params.mobileMoneyDetails.phone,
      networkId: params.metadata?.networkId || params.mobileMoneyDetails.network
    };
    const payload = {
      sequenceId: params.reference,
      channelId: params.metadata?.channelId || `${currency}_PAYOUT`,
      localAmount: params.amount,
      currency,
      reason: params.narration || "Marketplace disbursement",
      destination,
      forceAccept: true
    };
    const data = await this.request("/business/payments", "POST", payload, true);
    const status = normalizeYellowCardStatus(data.status);
    return {
      success: status !== "FAILED",
      transactionId: String(data.id || params.reference),
      reference: String(data.sequenceId || params.reference),
      status,
      providerStatus: data.status,
      rail: "YELLOW_CARD",
      amount: params.amount,
      currency,
      error: status === "FAILED" ? data.failureReason || data.message || "Yellow Card payout failed" : void 0,
      rawResponse: data
    };
  }
  async getPayoutStatus(transactionId, reference) {
    const path = reference ? `/business/payments/sequence-id/${validateSafeIdentifier(reference, "reference")}` : `/business/payments/${validateSafeIdentifier(transactionId, "transactionId")}`;
    const data = await this.request(path, "GET");
    const status = normalizeYellowCardStatus(data.status);
    return {
      success: status !== "FAILED",
      transactionId: String(data.id || transactionId),
      reference: String(data.sequenceId || reference || transactionId),
      status,
      providerStatus: data.status,
      rail: "YELLOW_CARD",
      amount: Number(data.localAmount ?? data.amount ?? 0),
      currency: String(data.currency || "").toUpperCase(),
      error: status === "FAILED" ? data.failureReason || "Yellow Card payout failed" : void 0,
      rawResponse: data
    };
  }
  async getBalances() {
    const res = await this.request("/business/account", "GET");
    const accounts = Array.isArray(res.accounts) ? res.accounts : Array.isArray(res.balances) ? res.balances : [res];
    return accounts.filter((row) => row && (row.currency || row.code)).map((row) => ({
      rail: "YELLOW_CARD",
      currency: String(row.currency || row.code || "").toUpperCase(),
      available: Number(row.availableBalance ?? row.balance ?? 0),
      pending: row.pendingBalance !== void 0 ? Number(row.pendingBalance) : void 0
    }));
  }
  verifyWebhook(rawBody, signature) {
    const secret = this.#webhookSecret || this.#secretKey;
    const expected = import_crypto5.default.createHmac("sha256", secret).update(rawBody).digest("base64");
    if (!constantTimeStringEqual(signature, expected)) {
      throw new Error("Invalid Yellow Card webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const status = normalizeYellowCardStatus(payload.status);
    return {
      rail: "YELLOW_CARD",
      eventType: String(
        payload.event || `payment.${String(payload.status || "updated").toLowerCase()}`
      ),
      transactionId: String(payload.id || ""),
      reference: String(payload.sequenceId || payload.reference || ""),
      status,
      providerStatus: payload.status,
      amount: Number(payload.localAmount ?? payload.amount ?? 0),
      currency: String(payload.currency || "").toUpperCase(),
      error: status === "FAILED" ? payload.failureReason || "Yellow Card payout failed" : void 0,
      rawPayload: payload
    };
  }
};

// src/adapters/mpesa.adapter.ts
var MpesaDarajaAdapter = class {
  #config;
  #baseUrl;
  #timeoutMs;
  #cachedToken;
  #tokenExpiresAt = 0;
  constructor(config, timeoutMs = 3e4) {
    if (!config.consumerKey || !config.consumerSecret) {
      throw new Error("M-Pesa Daraja consumerKey and consumerSecret are required");
    }
    this.#config = { ...config };
    this.#baseUrl = sanitizeBaseUrl(config.baseUrl, "https://api.safaricom.co.ke");
    this.#timeoutMs = timeoutMs;
  }
  async getAccessToken() {
    if (this.#cachedToken && Date.now() < this.#tokenExpiresAt) {
      return this.#cachedToken;
    }
    const basic = Buffer.from(
      `${this.#config.consumerKey}:${this.#config.consumerSecret}`
    ).toString("base64");
    const res = await fetchWithTimeout(
      `${this.#baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: "GET",
        headers: { Authorization: `Basic ${basic}` }
      },
      this.#timeoutMs,
      "MPESA_DARAJA",
      false
    );
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new PayoutProviderError({
        message: data?.errorMessage || `M-Pesa OAuth failed with status ${res.status}`,
        rail: "MPESA_DARAJA",
        statusCode: res.status || 401,
        isAmbiguous: false
      });
    }
    this.#cachedToken = data.access_token;
    const expiresInSec = Number(data.expires_in || 3500);
    this.#tokenExpiresAt = Date.now() + Math.max(expiresInSec - 60, 60) * 1e3;
    return data.access_token;
  }
  async request(path, body, isMutatingDisburse = false) {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(
      `${this.#baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      },
      this.#timeoutMs,
      "MPESA_DARAJA",
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok || data.ResponseCode && data.ResponseCode !== "0") {
      const status = res.status || (res.ok ? 400 : 500);
      throw new PayoutProviderError({
        message: data?.errorMessage || data?.ResponseDescription || `M-Pesa Daraja request failed with status ${status}`,
        rail: "MPESA_DARAJA",
        statusCode: status,
        isAmbiguous: isMutatingDisburse && !res.ok && isHttpStatusAmbiguous(status)
      });
    }
    return data;
  }
  async disburse(params) {
    if (!params.mobileMoneyDetails) {
      throw new Error("mobileMoneyDetails is required for M-Pesa Daraja disbursements");
    }
    const data = await this.request(
      "/mpesa/b2c/v3/paymentrequest",
      {
        OriginatorConversationID: params.reference,
        InitiatorName: this.#config.initiatorName,
        SecurityCredential: this.#config.securityCredential,
        CommandID: params.metadata?.commandId || "BusinessPayment",
        Amount: Math.round(params.amount),
        PartyA: this.#config.shortCode,
        PartyB: params.mobileMoneyDetails.phone,
        Remarks: params.narration || "Marketplace payout",
        QueueTimeOutURL: this.#config.queueTimeoutUrl,
        ResultURL: this.#config.resultUrl,
        Occasion: params.reference
      },
      true
    );
    return {
      success: true,
      transactionId: String(
        data.ConversationID || data.OriginatorConversationID || params.reference
      ),
      reference: String(data.OriginatorConversationID || params.reference),
      status: "PENDING",
      providerStatus: "ACCEPTED",
      rail: "MPESA_DARAJA",
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      rawResponse: data
    };
  }
  async getPayoutStatus(transactionId, reference) {
    const data = await this.request("/mpesa/transactionstatus/v1/query", {
      Initiator: this.#config.initiatorName,
      SecurityCredential: this.#config.securityCredential,
      CommandID: "TransactionStatusQuery",
      TransactionID: transactionId,
      OriginatorConversationID: reference || transactionId,
      PartyA: this.#config.shortCode,
      IdentifierType: "4",
      ResultURL: this.#config.resultUrl,
      QueueTimeOutURL: this.#config.queueTimeoutUrl,
      Remarks: "Payout status check",
      Occasion: reference || transactionId
    });
    return {
      success: true,
      transactionId: String(data.ConversationID || transactionId),
      reference: String(data.OriginatorConversationID || reference || transactionId),
      status: "PENDING",
      providerStatus: "QUERY_ACCEPTED",
      rail: "MPESA_DARAJA",
      amount: 0,
      currency: "KES",
      rawResponse: data
    };
  }
  async getBalances() {
    const data = await this.request("/mpesa/accountbalance/v1/query", {
      Initiator: this.#config.initiatorName,
      SecurityCredential: this.#config.securityCredential,
      CommandID: "AccountBalance",
      PartyA: this.#config.shortCode,
      IdentifierType: "4",
      Remarks: "Float balance check",
      QueueTimeOutURL: this.#config.queueTimeoutUrl,
      ResultURL: this.#config.resultUrl
    });
    if (typeof data.availableBalance === "number") {
      return [
        {
          rail: "MPESA_DARAJA",
          currency: String(data.currency || "KES").toUpperCase(),
          available: data.availableBalance
        }
      ];
    }
    return [];
  }
  verifyWebhook(rawBody, signature) {
    if (!this.#config.webhookSecret) {
      throw new Error("M-Pesa Daraja webhookSecret is required to verify webhooks");
    }
    if (!constantTimeStringEqual(signature, this.#config.webhookSecret)) {
      throw new Error("Invalid M-Pesa Daraja webhook signature");
    }
    const payload = JSON.parse(rawBody);
    const result = payload.Result || payload;
    const resultCode = Number(result.ResultCode);
    const status = resultCode === 0 ? "SUCCESSFUL" : "FAILED";
    let amount = 0;
    const params = result.ResultParameters?.ResultParameter || [];
    for (const p of params) {
      if (p.Key === "TransactionAmount") {
        amount = Number(p.Value || 0);
      }
    }
    return {
      rail: "MPESA_DARAJA",
      eventType: status === "SUCCESSFUL" ? "b2c.result.success" : "b2c.result.failed",
      transactionId: String(result.TransactionID || result.ConversationID || ""),
      reference: String(result.OriginatorConversationID || result.TransactionID || ""),
      status,
      providerStatus: String(result.ResultCode ?? ""),
      amount,
      currency: "KES",
      error: status === "FAILED" ? result.ResultDesc || "M-Pesa B2C payout failed" : void 0,
      rawPayload: payload
    };
  }
};

// src/engine.ts
var AFRICAN_CURRENCIES = /* @__PURE__ */ new Set(["NGN", "KES", "GHS", "UGX", "TZS", "RWF", "XOF", "XAF", "ZAR"]);
var REFERENCE_LOOKUP_RAILS = /* @__PURE__ */ new Set(["PAYSTACK", "PAWAPAY", "YELLOW_CARD"]);
var OmniPayoutEngine = class {
  #stripe;
  #flutterwave;
  #paystack;
  #pawapay;
  #yellowCard;
  #mpesaDaraja;
  #health;
  constructor(config) {
    const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 3e4;
    if (config.stripe?.secretKey) {
      this.#stripe = new StripeConnectAdapter(
        config.stripe.secretKey,
        config.stripe.webhookSecret,
        timeoutMs,
        config.stripe.webhookToleranceSec
      );
    }
    if (config.flutterwave?.secretKey) {
      this.#flutterwave = new FlutterwaveAdapter(
        config.flutterwave.secretKey,
        config.flutterwave.webhookSecret,
        timeoutMs
      );
    }
    if (config.paystack?.secretKey) {
      this.#paystack = new PaystackAdapter(
        config.paystack.secretKey,
        config.paystack.webhookSecret,
        timeoutMs
      );
    }
    if (config.pawapay?.apiToken) {
      this.#pawapay = new PawaPayAdapter(
        config.pawapay.apiToken,
        config.pawapay.baseUrl,
        config.pawapay.webhookSecret,
        timeoutMs
      );
    }
    if (config.yellowCard?.apiKey && config.yellowCard?.secretKey) {
      this.#yellowCard = new YellowCardAdapter(
        config.yellowCard.apiKey,
        config.yellowCard.secretKey,
        config.yellowCard.baseUrl,
        config.yellowCard.webhookSecret,
        timeoutMs
      );
    }
    if (config.mpesaDaraja?.consumerKey && config.mpesaDaraja?.consumerSecret) {
      this.#mpesaDaraja = new MpesaDarajaAdapter(config.mpesaDaraja, timeoutMs);
    }
    this.#health = new RailHealthTracker(config.health);
  }
  getConfiguredRails() {
    const rails = [];
    if (this.#stripe) rails.push("STRIPE_CONNECT");
    if (this.#flutterwave) rails.push("FLUTTERWAVE");
    if (this.#paystack) rails.push("PAYSTACK");
    if (this.#pawapay) rails.push("PAWAPAY");
    if (this.#yellowCard) rails.push("YELLOW_CARD");
    if (this.#mpesaDaraja) rails.push("MPESA_DARAJA");
    return rails;
  }
  /**
   * Automatically resolves the best primary payout rail based on explicit parameters or currency.
   */
  resolveRail(params) {
    if (params.rail) return params.rail;
    if (params.stripeAccountId) return "STRIPE_CONNECT";
    const currency = params.currency.toUpperCase();
    if (params.mobileMoneyDetails) {
      if (this.#flutterwave) return "FLUTTERWAVE";
      if (currency === "KES" && params.mobileMoneyDetails.network === "MPESA" && this.#mpesaDaraja) {
        return "MPESA_DARAJA";
      }
      if (this.#pawapay) return "PAWAPAY";
      if (this.#yellowCard) return "YELLOW_CARD";
      if (this.#paystack) return "PAYSTACK";
      return "FLUTTERWAVE";
    }
    if (params.bankDetails || AFRICAN_CURRENCIES.has(currency)) {
      if (this.#flutterwave) return "FLUTTERWAVE";
      if (this.#paystack) return "PAYSTACK";
      if (this.#yellowCard) return "YELLOW_CARD";
      return "FLUTTERWAVE";
    }
    return "STRIPE_CONNECT";
  }
  async disburseOnRail(rail, params) {
    if (rail === "STRIPE_CONNECT") {
      if (!this.#stripe) {
        throw new Error("Stripe Connect provider is not configured (missing secretKey)");
      }
      return this.#stripe.disburse(params);
    }
    if (rail === "FLUTTERWAVE") {
      if (!this.#flutterwave) {
        throw new Error("Flutterwave provider is not configured (missing secretKey)");
      }
      return this.#flutterwave.disburse(params);
    }
    if (rail === "PAYSTACK") {
      if (!this.#paystack) {
        throw new Error("Paystack provider is not configured (missing secretKey)");
      }
      return this.#paystack.disburse(params);
    }
    if (rail === "PAWAPAY") {
      if (!this.#pawapay) {
        throw new Error("PawaPay provider is not configured (missing apiToken)");
      }
      return this.#pawapay.disburse(params);
    }
    if (rail === "YELLOW_CARD") {
      if (!this.#yellowCard) {
        throw new Error("Yellow Card provider is not configured (missing apiKey/secretKey)");
      }
      return this.#yellowCard.disburse(params);
    }
    if (rail === "MPESA_DARAJA") {
      if (!this.#mpesaDaraja) {
        throw new Error("M-Pesa Daraja provider is not configured (missing consumerKey/consumerSecret)");
      }
      return this.#mpesaDaraja.disburse(params);
    }
    throw new Error(`Unsupported payout rail: ${rail}`);
  }
  /**
   * Unified disbursement method with input sanitization, circuit-breaker health checks,
   * pre-flight float balance checks, and timeout-safe failover (preventing double payouts).
   */
  async disburse(params) {
    validateDisburseInputs(params.amount, params.currency, params.reference);
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
      if (!this.#health.isAvailable(rail) && hasFallback) {
        lastError = new Error(`Rail ${rail} circuit breaker is open (unhealthy)`);
        continue;
      }
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
      const startMs = Date.now();
      try {
        const result = await this.disburseOnRail(rail, params);
        const latencyMs = Date.now() - startMs;
        if (result.status === "FAILED") {
          this.#health.recordFailure(rail, latencyMs, result.error || `${rail} disbursement failed`);
          if (hasFallback) {
            lastFailedResult = result;
            lastError = new Error(result.error || `${rail} disbursement returned FAILED`);
            continue;
          }
        } else {
          this.#health.recordSuccess(rail, latencyMs);
        }
        return {
          ...result,
          attemptedRails,
          failoverFrom: rail !== primaryRail ? primaryRail : void 0
        };
      } catch (err) {
        const latencyMs = Date.now() - startMs;
        lastError = err instanceof Error ? err : new Error(String(err));
        this.#health.recordFailure(rail, latencyMs, lastError.message);
        const isAmbiguous = err instanceof PayoutProviderError && err.isAmbiguous;
        if (isAmbiguous && !params.allowUnsafeTimeoutFailover) {
          if (REFERENCE_LOOKUP_RAILS.has(rail)) {
            try {
              const reconciled = await this.getPayoutStatus({
                transactionId: params.reference,
                reference: params.reference,
                rail
              });
              if (reconciled.status === "FAILED") {
                if (hasFallback) {
                  lastFailedResult = reconciled;
                  continue;
                }
              }
              return {
                ...reconciled,
                attemptedRails,
                failoverFrom: rail !== primaryRail ? primaryRail : void 0
              };
            } catch (statusErr) {
              if (statusErr instanceof PayoutProviderError && statusErr.statusCode === 404) {
                if (hasFallback) {
                  continue;
                }
                throw lastError;
              }
            }
          }
          throw new PayoutAmbiguousError(rail, params.reference, lastError.message);
        }
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
   * Returns live uptime/latency health and circuit-breaker state for one or all configured rails.
   */
  getRailHealth(rail) {
    if (rail) {
      return [this.#health.getHealth(rail)];
    }
    return this.getConfiguredRails().map((r) => this.#health.getHealth(r));
  }
  /**
   * Fetches the latest settlement status for a previously initiated payout.
   */
  async getPayoutStatus(params) {
    if (!params.transactionId) {
      throw new Error("transactionId is required to check payout status");
    }
    if (params.rail === "STRIPE_CONNECT") {
      if (!this.#stripe) throw new Error("Stripe Connect provider is not configured (missing secretKey)");
      return this.#stripe.getPayoutStatus(params.transactionId, params.stripeAccountId, params.reference);
    }
    if (params.rail === "FLUTTERWAVE") {
      if (!this.#flutterwave) throw new Error("Flutterwave provider is not configured (missing secretKey)");
      return this.#flutterwave.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === "PAYSTACK") {
      if (!this.#paystack) throw new Error("Paystack provider is not configured (missing secretKey)");
      return this.#paystack.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === "PAWAPAY") {
      if (!this.#pawapay) throw new Error("PawaPay provider is not configured (missing apiToken)");
      return this.#pawapay.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === "YELLOW_CARD") {
      if (!this.#yellowCard) throw new Error("Yellow Card provider is not configured");
      return this.#yellowCard.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === "MPESA_DARAJA") {
      if (!this.#mpesaDaraja) throw new Error("M-Pesa Daraja provider is not configured");
      return this.#mpesaDaraja.getPayoutStatus(params.transactionId, params.reference);
    }
    throw new Error(`Unsupported payout rail: ${params.rail}`);
  }
  /**
   * Queries available float balances for a specific rail or across all configured rails.
   */
  async getBalances(rail) {
    if (rail === "STRIPE_CONNECT") {
      if (!this.#stripe) throw new Error("Stripe Connect provider is not configured (missing secretKey)");
      return this.#stripe.getBalances();
    }
    if (rail === "FLUTTERWAVE") {
      if (!this.#flutterwave) throw new Error("Flutterwave provider is not configured (missing secretKey)");
      return this.#flutterwave.getBalances();
    }
    if (rail === "PAYSTACK") {
      if (!this.#paystack) throw new Error("Paystack provider is not configured (missing secretKey)");
      return this.#paystack.getBalances();
    }
    if (rail === "PAWAPAY") {
      if (!this.#pawapay) throw new Error("PawaPay provider is not configured (missing apiToken)");
      return this.#pawapay.getBalances();
    }
    if (rail === "YELLOW_CARD") {
      if (!this.#yellowCard) throw new Error("Yellow Card provider is not configured");
      return this.#yellowCard.getBalances();
    }
    if (rail === "MPESA_DARAJA") {
      if (!this.#mpesaDaraja) throw new Error("M-Pesa Daraja provider is not configured");
      return this.#mpesaDaraja.getBalances();
    }
    const tasks = [];
    if (this.#stripe) tasks.push(this.#stripe.getBalances());
    if (this.#flutterwave) tasks.push(this.#flutterwave.getBalances());
    if (this.#paystack) tasks.push(this.#paystack.getBalances());
    if (this.#pawapay) tasks.push(this.#pawapay.getBalances());
    if (this.#yellowCard) tasks.push(this.#yellowCard.getBalances());
    if (this.#mpesaDaraja) tasks.push(this.#mpesaDaraja.getBalances());
    const results = await Promise.all(tasks);
    return results.flat();
  }
  /**
   * Verifies a provider webhook signature and normalizes the event into a unified WebhookEvent.
   */
  verifyWebhook(rail, rawBody, signature) {
    if (rail === "STRIPE_CONNECT") {
      if (!this.#stripe) throw new Error("Stripe Connect provider is not configured");
      return this.#stripe.verifyWebhook(rawBody, signature);
    }
    if (rail === "FLUTTERWAVE") {
      if (!this.#flutterwave) throw new Error("Flutterwave provider is not configured");
      return this.#flutterwave.verifyWebhook(rawBody, signature);
    }
    if (rail === "PAYSTACK") {
      if (!this.#paystack) throw new Error("Paystack provider is not configured");
      return this.#paystack.verifyWebhook(rawBody, signature);
    }
    if (rail === "PAWAPAY") {
      if (!this.#pawapay) throw new Error("PawaPay provider is not configured");
      return this.#pawapay.verifyWebhook(rawBody, signature);
    }
    if (rail === "YELLOW_CARD") {
      if (!this.#yellowCard) throw new Error("Yellow Card provider is not configured");
      return this.#yellowCard.verifyWebhook(rawBody, signature);
    }
    if (rail === "MPESA_DARAJA") {
      if (!this.#mpesaDaraja) throw new Error("M-Pesa Daraja provider is not configured");
      return this.#mpesaDaraja.verifyWebhook(rawBody, signature);
    }
    throw new Error(`Unsupported payout rail: ${rail}`);
  }
  /**
   * Resolves a Nigerian / African bank account name using Flutterwave or Paystack.
   */
  async resolveBankAccount(bankCode, accountNumber, rail) {
    if (rail === "PAYSTACK" || !rail && !this.#flutterwave && this.#paystack) {
      if (!this.#paystack) {
        throw new Error("Paystack provider is not configured for bank resolution");
      }
      return this.#paystack.resolveBankAccount(bankCode, accountNumber);
    }
    if (!this.#flutterwave) {
      throw new Error("Flutterwave provider is not configured for bank resolution");
    }
    return this.#flutterwave.resolveBankAccount(bankCode, accountNumber);
  }
  /**
   * Generates a Stripe Connect Express onboarding URL for US/European merchants and couriers.
   */
  async createConnectOnboardingLink(params) {
    if (!this.#stripe) {
      throw new Error("Stripe Connect provider is not configured for onboarding links");
    }
    return this.#stripe.createOnboardingLink(params);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FlutterwaveAdapter,
  MpesaDarajaAdapter,
  OmniPayoutEngine,
  PawaPayAdapter,
  PayoutAmbiguousError,
  PayoutProviderError,
  PaystackAdapter,
  RailHealthTracker,
  StripeConnectAdapter,
  YellowCardAdapter,
  constantTimeHexEqual,
  constantTimeStringEqual,
  currencyExponent,
  fetchWithTimeout,
  fromMinorUnits,
  isHttpStatusAmbiguous,
  sanitizeBaseUrl,
  toDeterministicUuid,
  toMinorUnits,
  validateDisburseInputs,
  validateSafeIdentifier
});
//# sourceMappingURL=index.js.map