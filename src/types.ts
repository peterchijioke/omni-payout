export type PayoutRail = 'STRIPE_CONNECT' | 'FLUTTERWAVE' | 'PAYSTACK';

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

export interface WebhookEvent {
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
