type PayoutRail = 'STRIPE_CONNECT' | 'FLUTTERWAVE' | 'PAYSTACK';
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

declare class OmniPayoutEngine {
    private readonly stripe?;
    private readonly flutterwave?;
    private readonly paystack?;
    constructor(config: OmniPayoutConfig);
    /**
     * Automatically resolves the best primary payout rail based on explicit parameters or currency.
     */
    resolveRail(params: DisburseParams): PayoutRail;
    private disburseOnRail;
    /**
     * Unified disbursement method with optional pre-flight balance checks and automatic failover.
     */
    disburse(params: DisburseParams): Promise<DisburseResult>;
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

export { type BankAccountDetails, type BankResolutionResult, type DisburseParams, type DisburseResult, FlutterwaveAdapter, type MobileMoneyDetails, type OmniPayoutConfig, OmniPayoutEngine, type OnboardingLinkParams, type OnboardingLinkResult, type PayoutRail, type PayoutSpeed, type PayoutStatus, type PayoutStatusParams, PaystackAdapter, type RailBalance, StripeConnectAdapter, type WebhookEvent };
