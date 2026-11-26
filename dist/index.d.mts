type PayoutRail = 'STRIPE_CONNECT' | 'FLUTTERWAVE' | 'PAYSTACK' | 'PAWAPAY' | 'YELLOW_CARD' | 'MPESA_DARAJA';
type PayoutSpeed = 'standard' | 'instant';
type PayoutStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';
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
    metadata?: Record<string, any>;
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
    rawResponse?: any;
}
interface PayoutStatusParams {
    transactionId: string;
    rail: PayoutRail;
    stripeAccountId?: string;
    reference?: string;
}
interface RailBalance {
    rail: PayoutRail;
    currency: string;
    available: number;
    pending?: number;
}
interface RailHealth {
    rail: PayoutRail;
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
interface WebhookEvent {
    rail: PayoutRail;
    eventType: string;
    transactionId: string;
    reference: string;
    status: PayoutStatus;
    providerStatus?: string;
    amount: number;
    currency: string;
    error?: string;
    rawPayload?: any;
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
    /** Per-request HTTP timeout in milliseconds (defaults to 30000ms). */
    timeoutMs?: number;
    stripe?: {
        secretKey: string;
        webhookSecret?: string;
        /** Maximum allowed webhook timestamp age in seconds (defaults to 300s). */
        webhookToleranceSec?: number;
    };
    flutterwave?: {
        secretKey: string;
        publicKey?: string;
        webhookSecret?: string;
    };
    paystack?: {
        secretKey: string;
        webhookSecret?: string;
    };
    pawapay?: {
        apiToken: string;
        baseUrl?: string;
        webhookSecret?: string;
    };
    yellowCard?: {
        apiKey: string;
        secretKey: string;
        baseUrl?: string;
        webhookSecret?: string;
    };
    mpesaDaraja?: {
        consumerKey: string;
        consumerSecret: string;
        shortCode: string;
        initiatorName: string;
        securityCredential: string;
        resultUrl: string;
        queueTimeoutUrl: string;
        baseUrl?: string;
        webhookSecret?: string;
    };
    health?: HealthConfig;
}

declare class PayoutProviderError extends Error {
    readonly rail: PayoutRail;
    readonly statusCode?: number;
    readonly isAmbiguous: boolean;
    constructor(opts: {
        message: string;
        rail: PayoutRail;
        statusCode?: number;
        isAmbiguous: boolean;
    });
}
declare class PayoutAmbiguousError extends Error {
    readonly rail: PayoutRail;
    readonly reference: string;
    readonly isAmbiguous = true;
    constructor(rail: PayoutRail, reference: string, causeMessage: string);
}
declare function currencyExponent(currency: string): number;
declare function toMinorUnits(amount: number, currency: string): number;
declare function fromMinorUnits(minorAmount: number, currency: string): number;
declare function validateDisburseInputs(amount: number, currency: string, reference: string): void;
declare function validateSafeIdentifier(value: string, fieldName: string): string;
declare function sanitizeBaseUrl(baseUrl: string | undefined, defaultUrl: string): string;
/**
 * Deterministically converts any reference string into a valid RFC 4122 UUID
 * so PawaPay accepts human-readable references while preserving retry idempotency.
 */
declare function toDeterministicUuid(reference: string): string;
/**
 * Determines whether an HTTP status code from a POST disbursement is ambiguous
 * (i.e. the upstream bank/MNO may still have received and processed it).
 * 4xx and 501/503 are pre-execution rejections; 500/502/504 and network timeouts are ambiguous.
 */
declare function isHttpStatusAmbiguous(statusCode: number): boolean;
declare function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number, rail: PayoutRail, isMutatingPost?: boolean): Promise<Response>;
declare function constantTimeHexEqual(providedSig: string, expectedHex: string): boolean;
declare function constantTimeStringEqual(provided: string, expected: string): boolean;

declare class RailHealthTracker {
    private readonly failureThreshold;
    private readonly cooldownMs;
    private readonly maxLatencyMs;
    private readonly stats;
    constructor(config?: HealthConfig);
    private getOrCreate;
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
    securityCredential: string;
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
    private getConfiguredRails;
    /**
     * Automatically resolves the best primary payout rail based on explicit parameters or currency.
     */
    resolveRail(params: DisburseParams): PayoutRail;
    private disburseOnRail;
    /**
     * Unified disbursement method with input sanitization, circuit-breaker health checks,
     * pre-flight float balance checks, and timeout-safe failover (preventing double payouts).
     */
    disburse(params: DisburseParams): Promise<DisburseResult>;
    /**
     * Returns live uptime/latency health and circuit-breaker state for one or all configured rails.
     */
    getRailHealth(rail?: PayoutRail): RailHealth[];
    /**
     * Fetches the latest settlement status for a previously initiated payout.
     */
    getPayoutStatus(params: PayoutStatusParams): Promise<DisburseResult>;
    /**
     * Queries available float balances for a specific rail or across all configured rails.
     */
    getBalances(rail?: PayoutRail): Promise<RailBalance[]>;
    /**
     * Verifies a provider webhook signature and normalizes the event into a unified WebhookEvent.
     */
    verifyWebhook(rail: PayoutRail, rawBody: string, signature: string): WebhookEvent;
    /**
     * Resolves a Nigerian / African bank account name using Flutterwave or Paystack.
     */
    resolveBankAccount(bankCode: string, accountNumber: string, rail?: 'FLUTTERWAVE' | 'PAYSTACK'): Promise<BankResolutionResult>;
    /**
     * Generates a Stripe Connect Express onboarding URL for US/European merchants and couriers.
     */
    createConnectOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult>;
}

export { type BankAccountDetails, type BankResolutionResult, type DisburseParams, type DisburseResult, FlutterwaveAdapter, type HealthConfig, type MobileMoneyDetails, MpesaDarajaAdapter, type MpesaDarajaConfig, type OmniPayoutConfig, OmniPayoutEngine, type OnboardingLinkParams, type OnboardingLinkResult, PawaPayAdapter, PayoutAmbiguousError, PayoutProviderError, type PayoutRail, type PayoutSpeed, type PayoutStatus, type PayoutStatusParams, PaystackAdapter, type RailBalance, type RailHealth, RailHealthTracker, StripeConnectAdapter, type WebhookEvent, YellowCardAdapter, constantTimeHexEqual, constantTimeStringEqual, currencyExponent, fetchWithTimeout, fromMinorUnits, isHttpStatusAmbiguous, sanitizeBaseUrl, toDeterministicUuid, toMinorUnits, validateDisburseInputs, validateSafeIdentifier };
