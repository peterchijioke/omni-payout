import { StripeConnectAdapter } from './adapters/stripe.adapter';
import { FlutterwaveAdapter } from './adapters/flutterwave.adapter';
import {
  BankResolutionResult,
  DisburseParams,
  DisburseResult,
  OnboardingLinkParams,
  OnboardingLinkResult,
  OmniPayoutConfig,
  PayoutRail,
} from './types';

const AFRICAN_CURRENCIES = new Set(['NGN', 'KES', 'GHS', 'UGX', 'TZS', 'RWF', 'XOF', 'XAF', 'ZAR']);

export class OmniPayoutEngine {
  private readonly stripe?: StripeConnectAdapter;
  private readonly flutterwave?: FlutterwaveAdapter;

  constructor(config: OmniPayoutConfig) {
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
  resolveRail(params: DisburseParams): PayoutRail {
    if (params.rail) return params.rail;
    if (params.stripeAccountId) return 'STRIPE_CONNECT';
    if (params.bankDetails || params.mobileMoneyDetails) return 'FLUTTERWAVE';
    if (AFRICAN_CURRENCIES.has(params.currency.toUpperCase())) return 'FLUTTERWAVE';
    return 'STRIPE_CONNECT';
  }

  /**
   * Unified disbursement method across all international and domestic rails.
   */
  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (params.amount <= 0) {
      throw new Error('Disbursement amount must be greater than zero');
    }
    if (!params.reference) {
      throw new Error('Unique reference is required for idempotent disbursement');
    }

    const rail = this.resolveRail(params);

    if (rail === 'STRIPE_CONNECT') {
      if (!this.stripe) {
        throw new Error('Stripe Connect provider is not configured (missing secretKey)');
      }
      return this.stripe.disburse(params);
    }

    if (rail === 'FLUTTERWAVE') {
      if (!this.flutterwave) {
        throw new Error('Flutterwave provider is not configured (missing secretKey)');
      }
      return this.flutterwave.disburse(params);
    }

    throw new Error(`Unsupported payout rail: ${rail}`);
  }

  /**
   * Resolves a Nigerian / African bank account name using NIP inquiry.
   */
  async resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult> {
    if (!this.flutterwave) {
      throw new Error('Flutterwave provider is not configured for bank resolution');
    }
    return this.flutterwave.resolveBankAccount(bankCode, accountNumber);
  }

  /**
   * Generates a Stripe Connect Express onboarding URL for US/European merchants and couriers.
   */
  async createConnectOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult> {
    if (!this.stripe) {
      throw new Error('Stripe Connect provider is not configured for onboarding links');
    }
    return this.stripe.createOnboardingLink(params);
  }
}
