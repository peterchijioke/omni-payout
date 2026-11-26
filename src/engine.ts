import { StripeConnectAdapter } from './adapters/stripe.adapter';
import { FlutterwaveAdapter } from './adapters/flutterwave.adapter';
import { PaystackAdapter } from './adapters/paystack.adapter';
import {
  BankResolutionResult,
  DisburseParams,
  DisburseResult,
  OnboardingLinkParams,
  OnboardingLinkResult,
  OmniPayoutConfig,
  PayoutRail,
  PayoutStatusParams,
  RailBalance,
  WebhookEvent,
} from './types';

const AFRICAN_CURRENCIES = new Set(['NGN', 'KES', 'GHS', 'UGX', 'TZS', 'RWF', 'XOF', 'XAF', 'ZAR']);

export class OmniPayoutEngine {
  private readonly stripe?: StripeConnectAdapter;
  private readonly flutterwave?: FlutterwaveAdapter;
  private readonly paystack?: PaystackAdapter;

  constructor(config: OmniPayoutConfig) {
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
  resolveRail(params: DisburseParams): PayoutRail {
    if (params.rail) return params.rail;
    if (params.stripeAccountId) return 'STRIPE_CONNECT';
    if (
      params.bankDetails ||
      params.mobileMoneyDetails ||
      AFRICAN_CURRENCIES.has(params.currency.toUpperCase())
    ) {
      if (!this.flutterwave && this.paystack) return 'PAYSTACK';
      return 'FLUTTERWAVE';
    }
    return 'STRIPE_CONNECT';
  }

  private async disburseOnRail(rail: PayoutRail, params: DisburseParams): Promise<DisburseResult> {
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

    if (rail === 'PAYSTACK') {
      if (!this.paystack) {
        throw new Error('Paystack provider is not configured (missing secretKey)');
      }
      return this.paystack.disburse(params);
    }

    throw new Error(`Unsupported payout rail: ${rail}`);
  }

  /**
   * Unified disbursement method with optional pre-flight balance checks and automatic failover.
   */
  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (params.amount <= 0) {
      throw new Error('Disbursement amount must be greater than zero');
    }
    if (!params.reference) {
      throw new Error('Unique reference is required for idempotent disbursement');
    }

    const primaryRail = this.resolveRail(params);
    const candidateRails: PayoutRail[] = [primaryRail];
    for (const fallback of params.fallbackRails || []) {
      if (!candidateRails.includes(fallback)) {
        candidateRails.push(fallback);
      }
    }

    const attemptedRails: PayoutRail[] = [];
    let lastError: Error | undefined;
    let lastFailedResult: DisburseResult | undefined;
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
        } catch (err: any) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (hasFallback) {
            continue;
          }
          throw lastError;
        }
      }

      try {
        const result = await this.disburseOnRail(rail, params);
        if (result.status === 'FAILED' && hasFallback) {
          lastFailedResult = result;
          lastError = new Error(result.error || `${rail} disbursement returned FAILED`);
          continue;
        }
        return {
          ...result,
          attemptedRails,
          failoverFrom: rail !== primaryRail ? primaryRail : undefined,
        };
      } catch (err: any) {
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
        attemptedRails,
      };
    }

    throw lastError || new Error('All configured payout rails failed');
  }

  /**
   * Fetches the latest settlement status for a previously initiated payout.
   */
  async getPayoutStatus(params: PayoutStatusParams): Promise<DisburseResult> {
    if (!params.transactionId) {
      throw new Error('transactionId is required to check payout status');
    }

    if (params.rail === 'STRIPE_CONNECT') {
      if (!this.stripe) {
        throw new Error('Stripe Connect provider is not configured (missing secretKey)');
      }
      return this.stripe.getPayoutStatus(
        params.transactionId,
        params.stripeAccountId,
        params.reference
      );
    }

    if (params.rail === 'FLUTTERWAVE') {
      if (!this.flutterwave) {
        throw new Error('Flutterwave provider is not configured (missing secretKey)');
      }
      return this.flutterwave.getPayoutStatus(params.transactionId, params.reference);
    }

    if (params.rail === 'PAYSTACK') {
      if (!this.paystack) {
        throw new Error('Paystack provider is not configured (missing secretKey)');
      }
      return this.paystack.getPayoutStatus(params.transactionId, params.reference);
    }

    throw new Error(`Unsupported payout rail: ${params.rail}`);
  }

  /**
   * Queries available float balances for a specific rail or across all configured rails.
   */
  async getBalances(rail?: PayoutRail): Promise<RailBalance[]> {
    if (rail === 'STRIPE_CONNECT') {
      if (!this.stripe) throw new Error('Stripe Connect provider is not configured (missing secretKey)');
      return this.stripe.getBalances();
    }
    if (rail === 'FLUTTERWAVE') {
      if (!this.flutterwave) throw new Error('Flutterwave provider is not configured (missing secretKey)');
      return this.flutterwave.getBalances();
    }
    if (rail === 'PAYSTACK') {
      if (!this.paystack) throw new Error('Paystack provider is not configured (missing secretKey)');
      return this.paystack.getBalances();
    }

    const tasks: Promise<RailBalance[]>[] = [];
    if (this.stripe) tasks.push(this.stripe.getBalances());
    if (this.flutterwave) tasks.push(this.flutterwave.getBalances());
    if (this.paystack) tasks.push(this.paystack.getBalances());

    const results = await Promise.all(tasks);
    return results.flat();
  }

  /**
   * Verifies a provider webhook signature and normalizes the event into a unified WebhookEvent.
   */
  verifyWebhook(rail: PayoutRail, rawBody: string, signature: string): WebhookEvent {
    if (rail === 'STRIPE_CONNECT') {
      if (!this.stripe) throw new Error('Stripe Connect provider is not configured');
      return this.stripe.verifyWebhook(rawBody, signature);
    }
    if (rail === 'FLUTTERWAVE') {
      if (!this.flutterwave) throw new Error('Flutterwave provider is not configured');
      return this.flutterwave.verifyWebhook(rawBody, signature);
    }
    if (rail === 'PAYSTACK') {
      if (!this.paystack) throw new Error('Paystack provider is not configured');
      return this.paystack.verifyWebhook(rawBody, signature);
    }

    throw new Error(`Unsupported payout rail: ${rail}`);
  }

  /**
   * Resolves a Nigerian / African bank account name using Flutterwave or Paystack.
   */
  async resolveBankAccount(
    bankCode: string,
    accountNumber: string,
    rail?: 'FLUTTERWAVE' | 'PAYSTACK'
  ): Promise<BankResolutionResult> {
    if (rail === 'PAYSTACK' || (!rail && !this.flutterwave && this.paystack)) {
      if (!this.paystack) {
        throw new Error('Paystack provider is not configured for bank resolution');
      }
      return this.paystack.resolveBankAccount(bankCode, accountNumber);
    }

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
