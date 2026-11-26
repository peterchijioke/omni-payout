import { StripeConnectAdapter } from './adapters/stripe.adapter';
import { FlutterwaveAdapter } from './adapters/flutterwave.adapter';
import { PaystackAdapter } from './adapters/paystack.adapter';
import { PawaPayAdapter } from './adapters/pawapay.adapter';
import { YellowCardAdapter } from './adapters/yellowcard.adapter';
import { MpesaDarajaAdapter } from './adapters/mpesa.adapter';
import { RailHealthTracker } from './health';
import {
  PayoutAmbiguousError,
  PayoutProviderError,
  validateDisburseInputs,
} from './utils';
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
  RailHealth,
  WebhookEvent,
} from './types';

const AFRICAN_CURRENCIES = new Set(['NGN', 'KES', 'GHS', 'UGX', 'TZS', 'RWF', 'XOF', 'XAF', 'ZAR']);
const REFERENCE_LOOKUP_RAILS = new Set<PayoutRail>(['PAYSTACK', 'PAWAPAY', 'YELLOW_CARD']);

export class OmniPayoutEngine {
  readonly #stripe?: StripeConnectAdapter;
  readonly #flutterwave?: FlutterwaveAdapter;
  readonly #paystack?: PaystackAdapter;
  readonly #pawapay?: PawaPayAdapter;
  readonly #yellowCard?: YellowCardAdapter;
  readonly #mpesaDaraja?: MpesaDarajaAdapter;
  readonly #health: RailHealthTracker;

  constructor(config: OmniPayoutConfig) {
    const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 30_000;

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

  private getConfiguredRails(): PayoutRail[] {
    const rails: PayoutRail[] = [];
    if (this.#stripe) rails.push('STRIPE_CONNECT');
    if (this.#flutterwave) rails.push('FLUTTERWAVE');
    if (this.#paystack) rails.push('PAYSTACK');
    if (this.#pawapay) rails.push('PAWAPAY');
    if (this.#yellowCard) rails.push('YELLOW_CARD');
    if (this.#mpesaDaraja) rails.push('MPESA_DARAJA');
    return rails;
  }

  /**
   * Automatically resolves the best primary payout rail based on explicit parameters or currency.
   */
  resolveRail(params: DisburseParams): PayoutRail {
    if (params.rail) return params.rail;
    if (params.stripeAccountId) return 'STRIPE_CONNECT';

    const currency = params.currency.toUpperCase();
    if (params.mobileMoneyDetails) {
      if (this.#flutterwave) return 'FLUTTERWAVE';
      if (currency === 'KES' && params.mobileMoneyDetails.network === 'MPESA' && this.#mpesaDaraja) {
        return 'MPESA_DARAJA';
      }
      if (this.#pawapay) return 'PAWAPAY';
      if (this.#yellowCard) return 'YELLOW_CARD';
      if (this.#paystack) return 'PAYSTACK';
      return 'FLUTTERWAVE';
    }

    if (params.bankDetails || AFRICAN_CURRENCIES.has(currency)) {
      if (this.#flutterwave) return 'FLUTTERWAVE';
      if (this.#paystack) return 'PAYSTACK';
      if (this.#yellowCard) return 'YELLOW_CARD';
      return 'FLUTTERWAVE';
    }
    return 'STRIPE_CONNECT';
  }

  private async disburseOnRail(rail: PayoutRail, params: DisburseParams): Promise<DisburseResult> {
    if (rail === 'STRIPE_CONNECT') {
      if (!this.#stripe) {
        throw new Error('Stripe Connect provider is not configured (missing secretKey)');
      }
      return this.#stripe.disburse(params);
    }
    if (rail === 'FLUTTERWAVE') {
      if (!this.#flutterwave) {
        throw new Error('Flutterwave provider is not configured (missing secretKey)');
      }
      return this.#flutterwave.disburse(params);
    }
    if (rail === 'PAYSTACK') {
      if (!this.#paystack) {
        throw new Error('Paystack provider is not configured (missing secretKey)');
      }
      return this.#paystack.disburse(params);
    }
    if (rail === 'PAWAPAY') {
      if (!this.#pawapay) {
        throw new Error('PawaPay provider is not configured (missing apiToken)');
      }
      return this.#pawapay.disburse(params);
    }
    if (rail === 'YELLOW_CARD') {
      if (!this.#yellowCard) {
        throw new Error('Yellow Card provider is not configured (missing apiKey/secretKey)');
      }
      return this.#yellowCard.disburse(params);
    }
    if (rail === 'MPESA_DARAJA') {
      if (!this.#mpesaDaraja) {
        throw new Error('M-Pesa Daraja provider is not configured (missing consumerKey/consumerSecret)');
      }
      return this.#mpesaDaraja.disburse(params);
    }

    throw new Error(`Unsupported payout rail: ${rail}`);
  }

  /**
   * Unified disbursement method with input sanitization, circuit-breaker health checks,
   * pre-flight float balance checks, and timeout-safe failover (preventing double payouts).
   */
  async disburse(params: DisburseParams): Promise<DisburseResult> {
    validateDisburseInputs(params.amount, params.currency, params.reference);

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
        } catch (err: any) {
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

        if (result.status === 'FAILED') {
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
          failoverFrom: rail !== primaryRail ? primaryRail : undefined,
        };
      } catch (err: any) {
        const latencyMs = Date.now() - startMs;
        lastError = err instanceof Error ? err : new Error(String(err));
        this.#health.recordFailure(rail, latencyMs, lastError.message);

        const isAmbiguous = err instanceof PayoutProviderError && err.isAmbiguous;
        if (isAmbiguous && !params.allowUnsafeTimeoutFailover) {
          // Attempt automatic reconciliation by reference on rails that support it
          if (REFERENCE_LOOKUP_RAILS.has(rail)) {
            try {
              const reconciled = await this.getPayoutStatus({
                transactionId: params.reference,
                reference: params.reference,
                rail,
              });
              if (reconciled.status === 'FAILED') {
                if (hasFallback) {
                  lastFailedResult = reconciled;
                  continue;
                }
              }
              return {
                ...reconciled,
                attemptedRails,
                failoverFrom: rail !== primaryRail ? primaryRail : undefined,
              };
            } catch (statusErr: any) {
              if (statusErr instanceof PayoutProviderError && statusErr.statusCode === 404) {
                // Confirmed never recorded on this rail — safe to fail over!
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
        attemptedRails,
      };
    }

    throw lastError || new Error('All configured payout rails failed');
  }

  /**
   * Returns live uptime/latency health and circuit-breaker state for one or all configured rails.
   */
  getRailHealth(rail?: PayoutRail): RailHealth[] {
    if (rail) {
      return [this.#health.getHealth(rail)];
    }
    return this.getConfiguredRails().map((r) => this.#health.getHealth(r));
  }

  /**
   * Fetches the latest settlement status for a previously initiated payout.
   */
  async getPayoutStatus(params: PayoutStatusParams): Promise<DisburseResult> {
    if (!params.transactionId) {
      throw new Error('transactionId is required to check payout status');
    }

    if (params.rail === 'STRIPE_CONNECT') {
      if (!this.#stripe) throw new Error('Stripe Connect provider is not configured (missing secretKey)');
      return this.#stripe.getPayoutStatus(params.transactionId, params.stripeAccountId, params.reference);
    }
    if (params.rail === 'FLUTTERWAVE') {
      if (!this.#flutterwave) throw new Error('Flutterwave provider is not configured (missing secretKey)');
      return this.#flutterwave.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === 'PAYSTACK') {
      if (!this.#paystack) throw new Error('Paystack provider is not configured (missing secretKey)');
      return this.#paystack.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === 'PAWAPAY') {
      if (!this.#pawapay) throw new Error('PawaPay provider is not configured (missing apiToken)');
      return this.#pawapay.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === 'YELLOW_CARD') {
      if (!this.#yellowCard) throw new Error('Yellow Card provider is not configured');
      return this.#yellowCard.getPayoutStatus(params.transactionId, params.reference);
    }
    if (params.rail === 'MPESA_DARAJA') {
      if (!this.#mpesaDaraja) throw new Error('M-Pesa Daraja provider is not configured');
      return this.#mpesaDaraja.getPayoutStatus(params.transactionId, params.reference);
    }

    throw new Error(`Unsupported payout rail: ${params.rail}`);
  }

  /**
   * Queries available float balances for a specific rail or across all configured rails.
   */
  async getBalances(rail?: PayoutRail): Promise<RailBalance[]> {
    if (rail === 'STRIPE_CONNECT') {
      if (!this.#stripe) throw new Error('Stripe Connect provider is not configured (missing secretKey)');
      return this.#stripe.getBalances();
    }
    if (rail === 'FLUTTERWAVE') {
      if (!this.#flutterwave) throw new Error('Flutterwave provider is not configured (missing secretKey)');
      return this.#flutterwave.getBalances();
    }
    if (rail === 'PAYSTACK') {
      if (!this.#paystack) throw new Error('Paystack provider is not configured (missing secretKey)');
      return this.#paystack.getBalances();
    }
    if (rail === 'PAWAPAY') {
      if (!this.#pawapay) throw new Error('PawaPay provider is not configured (missing apiToken)');
      return this.#pawapay.getBalances();
    }
    if (rail === 'YELLOW_CARD') {
      if (!this.#yellowCard) throw new Error('Yellow Card provider is not configured');
      return this.#yellowCard.getBalances();
    }
    if (rail === 'MPESA_DARAJA') {
      if (!this.#mpesaDaraja) throw new Error('M-Pesa Daraja provider is not configured');
      return this.#mpesaDaraja.getBalances();
    }

    const tasks: Promise<RailBalance[]>[] = [];
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
  verifyWebhook(rail: PayoutRail, rawBody: string, signature: string): WebhookEvent {
    if (rail === 'STRIPE_CONNECT') {
      if (!this.#stripe) throw new Error('Stripe Connect provider is not configured');
      return this.#stripe.verifyWebhook(rawBody, signature);
    }
    if (rail === 'FLUTTERWAVE') {
      if (!this.#flutterwave) throw new Error('Flutterwave provider is not configured');
      return this.#flutterwave.verifyWebhook(rawBody, signature);
    }
    if (rail === 'PAYSTACK') {
      if (!this.#paystack) throw new Error('Paystack provider is not configured');
      return this.#paystack.verifyWebhook(rawBody, signature);
    }
    if (rail === 'PAWAPAY') {
      if (!this.#pawapay) throw new Error('PawaPay provider is not configured');
      return this.#pawapay.verifyWebhook(rawBody, signature);
    }
    if (rail === 'YELLOW_CARD') {
      if (!this.#yellowCard) throw new Error('Yellow Card provider is not configured');
      return this.#yellowCard.verifyWebhook(rawBody, signature);
    }
    if (rail === 'MPESA_DARAJA') {
      if (!this.#mpesaDaraja) throw new Error('M-Pesa Daraja provider is not configured');
      return this.#mpesaDaraja.verifyWebhook(rawBody, signature);
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
    if (rail === 'PAYSTACK' || (!rail && !this.#flutterwave && this.#paystack)) {
      if (!this.#paystack) {
        throw new Error('Paystack provider is not configured for bank resolution');
      }
      return this.#paystack.resolveBankAccount(bankCode, accountNumber);
    }

    if (!this.#flutterwave) {
      throw new Error('Flutterwave provider is not configured for bank resolution');
    }
    return this.#flutterwave.resolveBankAccount(bankCode, accountNumber);
  }

  /**
   * Generates a Stripe Connect Express onboarding URL for US/European merchants and couriers.
   */
  async createConnectOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult> {
    if (!this.#stripe) {
      throw new Error('Stripe Connect provider is not configured for onboarding links');
    }
    return this.#stripe.createOnboardingLink(params);
  }
}
