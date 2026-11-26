export type PayoutRail =
  | 'STRIPE_CONNECT'
  | 'FLUTTERWAVE'
  | 'PAYSTACK'
  | 'PAWAPAY'
  | 'YELLOW_CARD'
  | 'MPESA_DARAJA';

export type PayoutSpeed = 'standard' | 'instant';

export type PayoutStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export interface BankAccountDetails {
  bankCode: string;
  accountNumber: string;
  accountName?: string;
}

export interface MobileMoneyDetails {
  phone: string;
  network: 'MTN' | 'AIRTEL' | 'VODAFONE' | 'MPESA' | 'ORANGE' | 'WAVE';
}

export interface DisburseParams {
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

export interface DisburseResult {
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

export interface PayoutStatusParams {
  transactionId: string;
  rail: PayoutRail;
  stripeAccountId?: string;
  reference?: string;
}

export interface RailBalance {
  rail: PayoutRail;
  currency: string;
  available: number;
  pending?: number;
}

export interface RailHealth {
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

export interface HealthConfig {
  failureThreshold?: number;
  cooldownMs?: number;
  maxLatencyMs?: number;
}

export interface WebhookEvent {
  rail: PayoutRail;
  eventType: string;
  transactionId: string;
  reference: string;
  status: PayoutStatus;
  providerStatus?: string;
  amount: number;
  currency: string;
  fee?: number;
  error?: string;
  rawPayload?: any;
}

export interface NameMatchResult {
  matched: boolean;
  score: number;
  normalizedExpected: string;
  normalizedActual: string;
}

export interface BankResolutionResult {
  accountName: string;
  accountNumber: string;
  bankCode: string;
}

export interface OnboardingLinkParams {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
  type?: 'account_onboarding' | 'account_update';
}

export interface OnboardingLinkResult {
  url: string;
  expiresAt?: Date;
}

export interface OmniPayoutConfig {
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
    /** Pre-encrypted Base64 credential, OR omit and provide initiatorPassword + certificatePem. */
    securityCredential?: string;
    initiatorPassword?: string;
    certificatePem?: string;
    resultUrl: string;
    queueTimeoutUrl: string;
    baseUrl?: string;
    webhookSecret?: string;
  };
  health?: HealthConfig;
}
