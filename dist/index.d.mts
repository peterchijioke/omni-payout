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
    stripe?: {
        secretKey: string;
        webhookSecret?: string;
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
    private readonly secretKey;
    private readonly webhookSecret?;
    constructor(secretKey: string, webhookSecret?: string | undefined);
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, stripeAccountId?: string, reference?: string): Promise<DisburseResult>;
    createOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signatureHeader: string): WebhookEvent;
}

declare class FlutterwaveAdapter {
    private readonly secretKey;
    private readonly webhookSecret?;
    constructor(secretKey: string, webhookSecret?: string | undefined);
    private request;
    resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult>;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, verifHash: string): WebhookEvent;
}

declare class PaystackAdapter {
    private readonly secretKey;
    private readonly webhookSecret?;
    constructor(secretKey: string, webhookSecret?: string | undefined);
    private request;
    resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult>;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}

declare class PawaPayAdapter {
    private readonly apiToken;
    private readonly webhookSecret?;
    private readonly baseUrl;
    constructor(apiToken: string, baseUrl?: string, webhookSecret?: string | undefined);
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}

declare class YellowCardAdapter {
    private readonly apiKey;
    private readonly secretKey;
    private readonly webhookSecret?;
    private readonly baseUrl;
    constructor(apiKey: string, secretKey: string, baseUrl?: string, webhookSecret?: string | undefined);
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
    private readonly config;
    private readonly baseUrl;
    private cachedToken?;
    private tokenExpiresAt;
    constructor(config: MpesaDarajaConfig);
    private getAccessToken;
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
    getBalances(): Promise<RailBalance[]>;
    verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}

declare class OmniPayoutEngine {
    private readonly stripe?;
    private readonly flutterwave?;
    private readonly paystack?;
    private readonly pawapay?;
    private readonly yellowCard?;
    private readonly mpesaDaraja?;
    private readonly health;
    constructor(config: OmniPayoutConfig);
    private getConfiguredRails;
    /**
     * Automatically resolves the best primary payout rail based on explicit parameters or currency.
     */
    resolveRail(params: DisburseParams): PayoutRail;
    private disburseOnRail;
    /**
     * Unified disbursement method with circuit-breaker health checks, pre-flight balance checks, and automatic failover.
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

export { type BankAccountDetails, type BankResolutionResult, type DisburseParams, type DisburseResult, FlutterwaveAdapter, type HealthConfig, type MobileMoneyDetails, MpesaDarajaAdapter, type MpesaDarajaConfig, type OmniPayoutConfig, OmniPayoutEngine, type OnboardingLinkParams, type OnboardingLinkResult, PawaPayAdapter, type PayoutRail, type PayoutSpeed, type PayoutStatus, type PayoutStatusParams, PaystackAdapter, type RailBalance, type RailHealth, RailHealthTracker, StripeConnectAdapter, type WebhookEvent, YellowCardAdapter };
