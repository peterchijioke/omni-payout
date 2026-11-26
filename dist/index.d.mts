type PayoutRail = 'STRIPE_CONNECT' | 'FLUTTERWAVE' | 'PAYSTACK' | 'PAWAPAY' | 'YELLOW_CARD' | 'MPESA_DARAJA';
type PayoutSpeed = 'standard' | 'instant';
type PayoutStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';
type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
type PayoutErrorCode = 'VALIDATION_ERROR' | 'IDEMPOTENCY_CONFLICT' | 'AUTH_FAILED' | 'INVALID_ACCOUNT' | 'INSUFFICIENT_FLOAT' | 'LIMIT_EXCEEDED' | 'RATE_LIMITED' | 'PROVIDER_DOWN' | 'AMBIGUOUS_TIMEOUT' | 'DUPLICATE_REFERENCE' | 'DUPLICATE_WEBHOOK' | 'WEBHOOK_SIGNATURE_INVALID' | 'RECONCILIATION_TIMEOUT' | 'PROVIDER_ERROR';
interface BankAccountDetails {
    bankCode: string;
    accountNumber: string;
    accountName?: string;
}
interface MobileMoneyDetails {
    phone: string;
    network: 'MTN' | 'AIRTEL' | 'VODAFONE' | 'MPESA' | 'ORANGE' | 'WAVE';
}
interface DisburseParams {
    amount: number;
    currency: string;
    reference: string;
    country?: string;
    narration?: string;
    rail?: PayoutRail;
    fallbackRails?: PayoutRail[];
    checkBalanceBeforeDisburse?: boolean;
    /**
     * Defaults to false. When false, ambiguous timeout/502/504 errors during a payout POST
     * trigger a status lookup first and halt automatic failover if state cannot be confirmed,
     * preventing double payouts.
     */
    allowUnsafeTimeoutFailover?: boolean;
    stripeAccountId?: string;
    speed?: PayoutSpeed;
    bankDetails?: BankAccountDetails;
    mobileMoneyDetails?: MobileMoneyDetails;
    metadata?: Record<string, string>;
}
interface DisburseResult {
    success: boolean;
    transactionId: string;
    reference: string;
    status: PayoutStatus;
    providerStatus?: string;
    rail: PayoutRail;
    attemptedRails?: PayoutRail[];
    failoverFrom?: PayoutRail;
    amount: number;
    currency: string;
    fee?: number;
    error?: string;
    rawResponse?: unknown;
}
interface PayoutStatusParams {
    transactionId: string;
    rail: PayoutRail;
    stripeAccountId?: string;
    reference?: string;
}
interface ReconcileOptions {
    /** Initial polling delay in milliseconds (default: 2000ms). */
    intervalMs?: number;
    /** Maximum polling attempts before throwing RECONCILIATION_TIMEOUT (default: 10). */
    maxAttempts?: number;
    /** Exponential backoff multiplier between polls (default: 1.5). */
    backoffMultiplier?: number;
    /** Maximum interval cap between polls in milliseconds (default: 15000ms). */
    maxIntervalMs?: number;
}
interface RailBalance {
    rail: PayoutRail;
    currency: string;
    available: number;
    pending?: number;
}
interface RailHealth {
    rail: PayoutRail;
    state: CircuitState;
    healthy: boolean;
    circuitOpen: boolean;
    consecutiveFailures: number;
    totalRequests: number;
    totalFailures: number;
    lastLatencyMs: number;
    avgLatencyMs: number;
    lastError?: string;
    circuitOpenUntil?: Date;
}
interface HealthConfig {
    failureThreshold?: number;
    cooldownMs?: number;
    maxLatencyMs?: number;
}
interface RetryConfig {
    /** Maximum retry attempts for retryable transient errors (default: 0). */
    maxRetries?: number;
    /** Base backoff delay in milliseconds (default: 250ms). */
    baseDelayMs?: number;
    /** Maximum backoff delay cap in milliseconds (default: 5000ms). */
    maxDelayMs?: number;
    /** Apply random full jitter to backoff delays (default: true). */
    jitter?: boolean;
}
interface ProviderFeeRule {
    /** Flat fee in the payout currency (e.g. 10 NGN). */
    flat?: number;
    /** Percentage fee (e.g. 1.5 for 1.5%). */
    percent?: number;
}
interface RailLimit {
    minAmount?: number;
    maxAmount?: number;
}
interface RoutingRule {
    currencies?: string[];
    countries?: string[];
    minAmount?: number;
    maxAmount?: number;
    /** Ordered candidate rails when this rule matches. */
    rails: PayoutRail[];
    /** Optional fee schedule: when set, candidate rails are sorted lowest-cost first. */
    fees?: Partial<Record<PayoutRail, ProviderFeeRule>>;
}
interface WebhookDeduplicationConfig {
    /** Time-to-live for seen webhook event keys in milliseconds (default: 86400000ms / 24h). */
    ttlMs?: number;
    /** Throw DUPLICATE_WEBHOOK error instead of returning `duplicate: true` (default: false). */
    rejectDuplicates?: boolean;
}
interface IdempotencyRecord {
    fingerprint: string;
    result?: DisburseResult;
}
/**
 * Storage-agnostic idempotency adapter (plug in Redis, Postgres, DynamoDB, or InMemoryIdempotencyStore).
 * Omitted by default so `omni-payout` stays 100% stateless out of the box.
 */
interface IdempotencyStore {
    get(reference: string): Promise<IdempotencyRecord | null | undefined> | IdempotencyRecord | null | undefined;
    set(reference: string, record: IdempotencyRecord, ttlMs?: number): Promise<void> | void;
    delete?(reference: string): Promise<void> | void;
}
/**
 * Storage-agnostic webhook deduplication adapter (plug in Redis, Postgres, or InMemoryWebhookStore).
 */
interface WebhookStore {
    hasSeen(eventKey: string): Promise<boolean> | boolean;
    markSeen(eventKey: string, ttlMs?: number): Promise<void> | void;
}
/**
 * Monitoring-agnostic telemetry event emitted to plug into OpenTelemetry, Prometheus, Datadog, or logs.
 */
interface PayoutTelemetryEvent {
    type: 'disburse.success' | 'disburse.failed' | 'disburse.failover' | 'disburse.retry' | 'circuit.state_change' | 'webhook.verified' | 'webhook.duplicate';
    rail: PayoutRail;
    reference?: string;
    latencyMs?: number;
    errorCode?: PayoutErrorCode;
    circuitState?: CircuitState;
    failoverFrom?: PayoutRail;
    message?: string;
}
interface WebhookEvent {
    rail: PayoutRail;
    eventType: string;
    transactionId: string;
    reference: string;
    status: PayoutStatus;
    providerStatus?: string;
    amount: number;
    currency: string;
    fee?: number;
    duplicate?: boolean;
    error?: string;
    rawPayload?: unknown;
}
interface NameMatchResult {
    matched: boolean;
    score: number;
    normalizedExpected: string;
    normalizedActual: string;
}
interface BankResolutionResult {
    accountName: string;
    accountNumber: string;
    bankCode: string;
}
interface OnboardingLinkParams {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
    type?: 'account_onboarding' | 'account_update';
}
interface OnboardingLinkResult {
    url: string;
    expiresAt?: Date;
}
interface OmniPayoutConfig {
    /** Default HTTP request timeout in milliseconds across providers (default: 30000ms). */
    timeoutMs?: number;
    /** Optional TTL in milliseconds to cache `getBalances()` results for fast float checks (default: 0 / stateless). */
    balanceCacheTtlMs?: number;
    /** Optional TTL in milliseconds passed to `idempotencyStore.set()` (default: 86400000ms / 24h). */
    idempotencyTtlMs?: number;
    /** Optional storage-agnostic persistence adapter (Redis/Postgres/DynamoDB) for distributed idempotency. */
    idempotencyStore?: IdempotencyStore;
    /** Optional storage-agnostic adapter for duplicate webhook event detection. */
    webhookStore?: WebhookStore;
    /** Duplicate webhook handling options when `webhookStore` is provided. */
    webhookDeduplication?: WebhookDeduplicationConfig;
    /** Optional monitoring-agnostic hook for OpenTelemetry, Prometheus, Datadog, or structured logging. */
    onTelemetry?: (event: PayoutTelemetryEvent) => void;
    /** Configurable retry policy with exponential backoff and jitter. */
    retry?: RetryConfig;
    /** Configurable smart routing rules by country, currency, amount limits, and fees. */
    routingRules?: RoutingRule[];
    /** Per-rail transaction amount min/max limits. */
    railLimits?: Partial<Record<PayoutRail, RailLimit>>;
    stripe?: {
        secretKey: string;
        webhookSecret?: string;
        webhookToleranceSec?: number;
        timeoutMs?: number;
    };
    flutterwave?: {
        secretKey: string;
        publicKey?: string;
        webhookSecret?: string;
        timeoutMs?: number;
    };
    paystack?: {
        secretKey: string;
        webhookSecret?: string;
        timeoutMs?: number;
    };
    pawapay?: {
        apiToken: string;
        baseUrl?: string;
        webhookSecret?: string;
        timeoutMs?: number;
    };
    yellowCard?: {
        apiKey: string;
        secretKey: string;
        baseUrl?: string;
        webhookSecret?: string;
        timeoutMs?: number;
    };
    mpesaDaraja?: {
        consumerKey: string;
        consumerSecret: string;
        shortCode: string;
        initiatorName: string;
        securityCredential?: string;
        initiatorPassword?: string;
        certificatePem?: string;
        resultUrl: string;
        queueTimeoutUrl: string;
        baseUrl?: string;
        webhookSecret?: string;
        timeoutMs?: number;
    };
    health?: HealthConfig;
}

/**
 * Classifies provider HTTP status codes and error messages into consistent, actionable PayoutErrorCodes.
 */
declare function classifyProviderError(statusCode: number | undefined, message: string, isAmbiguous: boolean): {
    code: PayoutErrorCode;
    retryable: boolean;
};
declare class PayoutProviderError extends Error {
    readonly rail: PayoutRail;
    readonly code: PayoutErrorCode;
    readonly statusCode?: number;
    readonly isAmbiguous: boolean;
    readonly retryable: boolean;
    constructor(opts: {
        message: string;
        rail: PayoutRail;
        statusCode?: number;
        isAmbiguous: boolean;
        code?: PayoutErrorCode;
        retryable?: boolean;
    });
}
declare class PayoutAmbiguousError extends Error {
    readonly rail: PayoutRail;
    readonly reference: string;
    readonly code: PayoutErrorCode;
    readonly isAmbiguous = true;
    readonly retryable = false;
    constructor(rail: PayoutRail, reference: string, causeMessage: string);
}
declare function currencyExponent(currency: string): number;
/**
 * Converts a major-unit decimal amount into exact integer minor units using string-based
 * decimal shifting (avoiding IEEE-754 floating-point drift on fractional currencies).
 */
declare function toMinorUnits(amount: number | string, currency: string): number;
declare function fromMinorUnits(minorAmount: number, currency: string): number;
declare function validateDisburseInputs(amount: number, currency: string, reference: string): void;
declare function validateSafeIdentifier(value: string, fieldName: string): string;
declare function sanitizeBaseUrl(baseUrl: string | undefined, defaultUrl: string): string;
declare function toDeterministicUuid(reference: string): string;
declare function isHttpStatusAmbiguous(statusCode: number): boolean;
declare function sleepMs(ms: number): Promise<void>;
/**
 * Executes an operation with configurable exponential backoff and optional full jitter,
 * retrying ONLY errors explicitly marked `retryable: true` and `isAmbiguous: false`.
 */
declare function withRetry<T>(fn: () => Promise<T>, retryConfig?: RetryConfig, onRetry?: (err: PayoutProviderError, attempt: number) => void): Promise<T>;
/**
 * Optional bounded in-memory reference implementation of `IdempotencyStore` for single-node setups or testing.
 */
declare class InMemoryIdempotencyStore implements IdempotencyStore {
    private readonly maxEntries;
    private readonly entries;
    constructor(maxEntries?: number);
    get(reference: string): IdempotencyRecord | null;
    set(reference: string, record: IdempotencyRecord, ttlMs?: number): void;
    delete(reference: string): void;
}
/**
 * Optional bounded in-memory reference implementation of `WebhookStore` for single-node setups or testing.
 */
declare class InMemoryWebhookStore implements WebhookStore {
    private readonly maxEntries;
    private readonly seen;
    constructor(maxEntries?: number);
    hasSeen(eventKey: string): boolean;
    markSeen(eventKey: string, ttlMs?: number): void;
}
declare function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number, rail: PayoutRail, isMutatingPost?: boolean): Promise<Response>;
declare function constantTimeHexEqual(providedSig: string, expectedHex: string): boolean;
declare function constantTimeStringEqual(provided: string, expected: string): boolean;
declare const CURRENCY_COUNTRIES: Record<string, string>;
declare function normalizeMsisdn(phone: string, currency?: string): string;
declare function encryptMpesaInitiatorPassword(initiatorPassword: string, certificatePem: string): string;
declare function matchAccountNames(expectedName: string, resolvedName: string, threshold?: number): NameMatchResult;
declare function canTransitionStatus(currentStatus: PayoutStatus | undefined | null, nextStatus: PayoutStatus, allowReversal?: boolean): boolean;
declare function resolveProviderCode(code: string, currency: string, rail: PayoutRail, isMobileMoney?: boolean): string;

declare class RailHealthTracker {
    private readonly failureThreshold;
    private readonly cooldownMs;
    private readonly maxLatencyMs;
    private readonly stats;
    constructor(config?: HealthConfig);
    private getOrCreate;
    /**
     * Checks whether a rail can accept a request, transitioning OPEN -> HALF_OPEN
     * after cooldown and allowing a single recovery probe through.
     */
    tryAcquire(rail: PayoutRail): boolean;
    isAvailable(rail: PayoutRail): boolean;
    recordSuccess(rail: PayoutRail, latencyMs: number): void;
    recordFailure(rail: PayoutRail, latencyMs: number, errorMessage: string): void;
    getHealth(rail: PayoutRail): RailHealth;
}

declare class StripeConnectAdapter {
    #private;
    constructor(secretKey: string, webhookSecret?: string, timeoutMs?: number, webhookToleranceSec?: number);
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, stripeAccountId?: string, reference?: string): Promise<DisburseResult>;
    createOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signatureHeader: string): WebhookEvent;
}

declare class FlutterwaveAdapter {
    #private;
    constructor(secretKey: string, webhookSecret?: string, timeoutMs?: number);
    private request;
    resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult>;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, verifHash: string): WebhookEvent;
}

declare class PaystackAdapter {
    #private;
    constructor(secretKey: string, webhookSecret?: string, timeoutMs?: number);
    private request;
    resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult>;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}

declare class PawaPayAdapter {
    #private;
    constructor(apiToken: string, baseUrl?: string, webhookSecret?: string, timeoutMs?: number);
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}

declare class YellowCardAdapter {
    #private;
    constructor(apiKey: string, secretKey: string, baseUrl?: string, webhookSecret?: string, timeoutMs?: number);
    private buildAuthHeaders;
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}

interface MpesaDarajaConfig {
    consumerKey: string;
    consumerSecret: string;
    shortCode: string;
    initiatorName: string;
    securityCredential?: string;
    initiatorPassword?: string;
    certificatePem?: string;
    resultUrl: string;
    queueTimeoutUrl: string;
    baseUrl?: string;
    webhookSecret?: string;
}
declare class MpesaDarajaAdapter {
    #private;
    constructor(config: MpesaDarajaConfig, timeoutMs?: number);
    private getAccessToken;
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}

declare class OmniPayoutEngine {
    #private;
    constructor(config: OmniPayoutConfig);
    private emit;
    private getConfiguredRails;
    /**
     * Evaluates smart routing rules (by country, currency, amount limits, and provider fees)
     * and returns the ordered candidate rail chain `[primary, ...fallbacks]`.
     */
    resolveRoute(params: DisburseParams): PayoutRail[];
    /**
     * Resolves the primary payout rail for the given disbursement parameters.
     */
    resolveRail(params: DisburseParams): PayoutRail;
    private disburseOnRail;
    /**
     * Unified disbursement method with concurrent singleflight deduplication, optional pluggable
     * `IdempotencyStore`, smart routing, half-open circuit breakers, retry backoff, and timeout-safe failover.
     */
    disburse(params: DisburseParams): Promise<DisburseResult>;
    private executeDisbursePipeline;
    /**
     * Polls `getPayoutStatus` with configurable exponential backoff until the payout reaches
     * a terminal state (`SUCCESSFUL` or `FAILED`), or throws `RECONCILIATION_TIMEOUT`.
     */
    waitForSettlement(params: PayoutStatusParams, options?: ReconcileOptions): Promise<DisburseResult>;
    /**
     * Returns live uptime/latency health and circuit-breaker state (`CLOSED` / `OPEN` / `HALF_OPEN`).
     */
    getRailHealth(rail?: PayoutRail): RailHealth[];
    /**
     * Invalidates cached float balances (when `balanceCacheTtlMs > 0`).
     */
    invalidateBalanceCache(rail?: PayoutRail): void;
    /**
     * Fetches the latest settlement status for a previously initiated payout.
     */
    getPayoutStatus(params: PayoutStatusParams): Promise<DisburseResult>;
    private fetchSingleRailBalance;
    /**
     * Queries available float balances for a specific rail or across all configured rails.
     */
    getBalances(rail?: PayoutRail): Promise<RailBalance[]>;
    private verifyWebhookRaw;
    /**
     * Verifies a provider webhook signature synchronously and normalizes the event.
     * When a synchronous `webhookStore` (like `InMemoryWebhookStore`) is configured, also flags duplicates.
     */
    verifyWebhook(rail: PayoutRail, rawBody: string, signature: string): WebhookEvent;
    /**
     * Async variant of `verifyWebhook` supporting asynchronous `WebhookStore` backends (e.g. Redis / Postgres).
     */
    verifyWebhookAsync(rail: PayoutRail, rawBody: string, signature: string): Promise<WebhookEvent>;
    /**
     * Verifies a webhook signature, checks duplicate/out-of-order state guards,
     * and confirms the authoritative payout state & amount directly against the provider API.
     */
    verifyAndConfirmWebhook(rail: PayoutRail, rawBody: string, signature: string, options?: {
        stripeAccountId?: string;
        currentStatus?: PayoutStatus;
    }): Promise<WebhookEvent>;
    matchAccountNames(expectedName: string, resolvedName: string, threshold?: number): NameMatchResult;
    canTransitionStatus(currentStatus: PayoutStatus | undefined | null, nextStatus: PayoutStatus, allowReversal?: boolean): boolean;
    resolveBankAccount(bankCode: string, accountNumber: string, rail?: 'FLUTTERWAVE' | 'PAYSTACK', currency?: string): Promise<BankResolutionResult>;
    createConnectOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult>;
}

export { type BankAccountDetails, type BankResolutionResult, CURRENCY_COUNTRIES, type CircuitState, type DisburseParams, type DisburseResult, FlutterwaveAdapter, type HealthConfig, type IdempotencyRecord, type IdempotencyStore, InMemoryIdempotencyStore, InMemoryWebhookStore, type MobileMoneyDetails, MpesaDarajaAdapter, type MpesaDarajaConfig, type NameMatchResult, type OmniPayoutConfig, OmniPayoutEngine, type OnboardingLinkParams, type OnboardingLinkResult, PawaPayAdapter, PayoutAmbiguousError, type PayoutErrorCode, PayoutProviderError, type PayoutRail, type PayoutSpeed, type PayoutStatus, type PayoutStatusParams, type PayoutTelemetryEvent, PaystackAdapter, type ProviderFeeRule, type RailBalance, type RailHealth, RailHealthTracker, type RailLimit, type ReconcileOptions, type RetryConfig, type RoutingRule, StripeConnectAdapter, type WebhookDeduplicationConfig, type WebhookEvent, type WebhookStore, YellowCardAdapter, canTransitionStatus, classifyProviderError, constantTimeHexEqual, constantTimeStringEqual, currencyExponent, encryptMpesaInitiatorPassword, fetchWithTimeout, fromMinorUnits, isHttpStatusAmbiguous, matchAccountNames, normalizeMsisdn, resolveProviderCode, sanitizeBaseUrl, sleepMs, toDeterministicUuid, toMinorUnits, validateDisburseInputs, validateSafeIdentifier, withRetry };
