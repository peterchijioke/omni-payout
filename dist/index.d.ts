type PayoutRail = 'STRIPE_CONNECT' | 'FLUTTERWAVE';
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
}

declare class StripeConnectAdapter {
    private readonly secretKey;
    constructor(secretKey: string);
    private request;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, stripeAccountId?: string, reference?: string): Promise<DisburseResult>;
    createOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult>;
}

declare class FlutterwaveAdapter {
    private readonly secretKey;
    constructor(secretKey: string);
    private request;
    resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult>;
    disburse(params: DisburseParams): Promise<DisburseResult>;
    getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult>;
}

declare class OmniPayoutEngine {
    private readonly stripe?;
    private readonly flutterwave?;
    constructor(config: OmniPayoutConfig);
    /**
     * Automatically resolves the best payout rail based on explicit parameters or currency.
     */
    resolveRail(params: DisburseParams): PayoutRail;
    /**
     * Unified disbursement method across all international and domestic rails.
     */
    disburse(params: DisburseParams): Promise<DisburseResult>;
    /**
     * Fetches the latest settlement status for a previously initiated payout.
     */
    getPayoutStatus(params: PayoutStatusParams): Promise<DisburseResult>;
    /**
     * Resolves a Nigerian / African bank account name using NIP inquiry.
     */
    resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult>;
    /**
     * Generates a Stripe Connect Express onboarding URL for US/European merchants and couriers.
     */
    createConnectOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult>;
}

export { type BankAccountDetails, type BankResolutionResult, type DisburseParams, type DisburseResult, FlutterwaveAdapter, type MobileMoneyDetails, type OmniPayoutConfig, OmniPayoutEngine, type OnboardingLinkParams, type OnboardingLinkResult, type PayoutRail, type PayoutSpeed, type PayoutStatus, type PayoutStatusParams, StripeConnectAdapter };
