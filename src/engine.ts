import { StripeConnectAdapter } from './adapters/stripe.adapter';
import { FlutterwaveAdapter } from './adapters/flutterwave.adapter';
import { PaystackAdapter } from './adapters/paystack.adapter';
import { PawaPayAdapter } from './adapters/pawapay.adapter';
import { YellowCardAdapter } from './adapters/yellowcard.adapter';
import { MpesaDarajaAdapter } from './adapters/mpesa.adapter';
import { RailHealthTracker } from './health';
import {
  CURRENCY_COUNTRIES,
  PayoutAmbiguousError,
  PayoutProviderError,
  canTransitionStatus,
  formatSettlementsCsv,
  matchAccountNames,
  reconcileBatch,
  resolveProviderCode,
  sleepMs,
  toMinorUnits,
  validateDisburseInputs,
  withRetry,
} from './utils';
import {
  BankResolutionResult,
  DisburseParams,
  DisburseResult,
  IdempotencyStore,
  LocalLedgerRecord,
  NameMatchResult,
  OnboardingLinkParams,
  OnboardingLinkResult,
  OmniPayoutConfig,
  PayoutRail,
  PayoutStatus,
  PayoutStatusParams,
  PayoutTelemetryEvent,
  RailBalance,
  RailHealth,
  RailLimit,
  ReconcileOptions,
  ReconciliationReport,
  RetryConfig,
  RoutingRule,
  SettlementExportParams,
  SettlementRecord,
  WebhookDeduplicationConfig,
  WebhookEvent,
  WebhookStore,
} from './types';

const AFRICAN_CURRENCIES = new Set(['NGN', 'KES', 'GHS', 'UGX', 'TZS', 'RWF', 'XOF', 'XAF', 'ZAR']);
const REFERENCE_LOOKUP_RAILS = new Set<PayoutRail>(['PAYSTACK', 'PAWAPAY', 'YELLOW_CARD']);

function computeDisburseFingerprint(params: DisburseParams): string {
  const currency = params.currency.toUpperCase();
  const minor = toMinorUnits(params.amount, currency);
  const dest = params.stripeAccountId
    ? `stripe:${params.stripeAccountId}`
    : params.bankDetails
      ? `bank:${params.bankDetails.bankCode}:${params.bankDetails.accountNumber}`
      : params.mobileMoneyDetails
        ? `momo:${params.mobileMoneyDetails.network}:${params.mobileMoneyDetails.phone}`
        : 'default';
  return `${currency}:${minor}:${dest}`;
}

export class OmniPayoutEngine {
  readonly #stripe?: StripeConnectAdapter;
  readonly #flutterwave?: FlutterwaveAdapter;
  readonly #paystack?: PaystackAdapter;
  readonly #pawapay?: PawaPayAdapter;
  readonly #yellowCard?: YellowCardAdapter;
  readonly #mpesaDaraja?: MpesaDarajaAdapter;
  readonly #health: RailHealthTracker;
  readonly #retryConfig?: RetryConfig;
  readonly #routingRules: RoutingRule[];
  readonly #railLimits: Partial<Record<PayoutRail, RailLimit>>;
  readonly #idempotencyStore?: IdempotencyStore;
  readonly #idempotencyTtlMs: number;
  readonly #webhookStore?: WebhookStore;
  readonly #webhookDedup?: WebhookDeduplicationConfig;
  readonly #onTelemetry?: (event: PayoutTelemetryEvent) => void;
  readonly #balanceCacheTtlMs: number;
  readonly #balanceCache = new Map<PayoutRail, { balances: RailBalance[]; expiresAt: number }>();
  readonly #inFlight = new Map<string, { fingerprint: string; promise: Promise<DisburseResult> }>();

  constructor(config: OmniPayoutConfig) {
    const defaultTimeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 30_000;

    if (config.stripe?.secretKey) {
      this.#stripe = new StripeConnectAdapter(
        config.stripe.secretKey,
        config.stripe.webhookSecret,
        config.stripe.timeoutMs ?? defaultTimeoutMs,
        config.stripe.webhookToleranceSec
      );
    }
    if (config.flutterwave?.secretKey) {
      this.#flutterwave = new FlutterwaveAdapter(
        config.flutterwave.secretKey,
        config.flutterwave.webhookSecret,
        config.flutterwave.timeoutMs ?? defaultTimeoutMs
      );
    }
    if (config.paystack?.secretKey) {
      this.#paystack = new PaystackAdapter(
        config.paystack.secretKey,
        config.paystack.webhookSecret,
        config.paystack.timeoutMs ?? defaultTimeoutMs
      );
    }
    if (config.pawapay?.apiToken) {
      this.#pawapay = new PawaPayAdapter(
        config.pawapay.apiToken,
        config.pawapay.baseUrl,
        config.pawapay.webhookSecret,
        config.pawapay.timeoutMs ?? defaultTimeoutMs
      );
    }
    if (config.yellowCard?.apiKey && config.yellowCard?.secretKey) {
      this.#yellowCard = new YellowCardAdapter(
        config.yellowCard.apiKey,
        config.yellowCard.secretKey,
        config.yellowCard.baseUrl,
        config.yellowCard.webhookSecret,
        config.yellowCard.timeoutMs ?? defaultTimeoutMs
      );
    }
    if (config.mpesaDaraja?.consumerKey && config.mpesaDaraja?.consumerSecret) {
      this.#mpesaDaraja = new MpesaDarajaAdapter(
        config.mpesaDaraja,
        config.mpesaDaraja.timeoutMs ?? defaultTimeoutMs
      );
    }

    this.#health = new RailHealthTracker(config.health);
    this.#retryConfig = config.retry;
    this.#routingRules = config.routingRules ? [...config.routingRules] : [];
    this.#railLimits = config.railLimits ? { ...config.railLimits } : {};
    this.#idempotencyStore = config.idempotencyStore;
    this.#idempotencyTtlMs = config.idempotencyTtlMs ?? 86_400_000;
    this.#webhookStore = config.webhookStore;
    this.#webhookDedup = config.webhookDeduplication;
    this.#onTelemetry = config.onTelemetry;
    this.#balanceCacheTtlMs = config.balanceCacheTtlMs ?? 0;
  }

  private emit(event: PayoutTelemetryEvent): void {
    try {
      this.#onTelemetry?.(event);
    } catch {
      // Never let telemetry observer errors disrupt payment execution
    }
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
   * Evaluates smart routing rules (by country, currency, amount limits, and provider fees)
   * and returns the ordered candidate rail chain `[primary, ...fallbacks]`.
   */
  resolveRoute(params: DisburseParams): PayoutRail[] {
    const currency = params.currency.toUpperCase();
    const country = (params.country || CURRENCY_COUNTRIES[currency] || '').toUpperCase();

    if (!params.rail && this.#routingRules.length > 0) {
      for (const rule of this.#routingRules) {
        if (
          rule.currencies &&
          rule.currencies.length > 0 &&
          !rule.currencies.some((c) => c.toUpperCase() === currency)
        ) {
          continue;
        }
        if (
          rule.countries &&
          rule.countries.length > 0 &&
          (!country || !rule.countries.some((c) => c.toUpperCase() === country))
        ) {
          continue;
        }
        if (rule.minAmount !== undefined && params.amount < rule.minAmount) {
          continue;
        }
        if (rule.maxAmount !== undefined && params.amount > rule.maxAmount) {
          continue;
        }
        if (rule.rails.length > 0) {
          const ordered = [...rule.rails];
          const strategy = rule.strategy ?? (rule.fees ? 'lowest_fee' : 'priority');
          if (strategy === 'lowest_fee' && rule.fees) {
            const fees = rule.fees;
            ordered.sort((a, b) => {
              const fa = fees[a];
              const fb = fees[b];
              const costA = fa
                ? (fa.flat ?? 0) + (params.amount * (fa.percent ?? 0)) / 100
                : Number.MAX_SAFE_INTEGER;
              const costB = fb
                ? (fb.flat ?? 0) + (params.amount * (fb.percent ?? 0)) / 100
                : Number.MAX_SAFE_INTEGER;
              return costA - costB;
            });
          } else if (strategy === 'health_first') {
            const stateRank = (s: string) => (s === 'CLOSED' ? 0 : s === 'HALF_OPEN' ? 1 : 2);
            ordered.sort((a, b) => {
              const ha = this.#health.getHealth(a);
              const hb = this.#health.getHealth(b);
              const rankDiff = stateRank(ha.state) - stateRank(hb.state);
              if (rankDiff !== 0) return rankDiff;
              return ha.avgLatencyMs - hb.avgLatencyMs;
            });
          }
          for (const fb of params.fallbackRails || []) {
            if (!ordered.includes(fb)) ordered.push(fb);
          }
          return ordered;
        }
      }
    }

    let primary: PayoutRail;
    if (params.rail) {
      primary = params.rail;
    } else if (params.stripeAccountId) {
      primary = 'STRIPE_CONNECT';
    } else if (params.mobileMoneyDetails) {
      if (this.#flutterwave) primary = 'FLUTTERWAVE';
      else if (
        currency === 'KES' &&
        params.mobileMoneyDetails.network === 'MPESA' &&
        this.#mpesaDaraja
      ) {
        primary = 'MPESA_DARAJA';
      } else if (this.#pawapay) primary = 'PAWAPAY';
      else if (this.#yellowCard) primary = 'YELLOW_CARD';
      else if (this.#paystack) primary = 'PAYSTACK';
      else primary = 'FLUTTERWAVE';
    } else if (params.bankDetails || AFRICAN_CURRENCIES.has(currency)) {
      if (this.#flutterwave) primary = 'FLUTTERWAVE';
      else if (this.#paystack) primary = 'PAYSTACK';
      else if (this.#yellowCard) primary = 'YELLOW_CARD';
      else primary = 'FLUTTERWAVE';
    } else {
      primary = 'STRIPE_CONNECT';
    }

    const candidates: PayoutRail[] = [primary];
    for (const fb of params.fallbackRails || []) {
      if (!candidates.includes(fb)) {
        candidates.push(fb);
      }
    }
    return candidates;
  }

  /**
   * Resolves the primary payout rail for the given disbursement parameters.
   */
  resolveRail(params: DisburseParams): PayoutRail {
    return this.resolveRoute(params)[0];
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
   * Unified disbursement method with concurrent singleflight deduplication, optional pluggable
   * `IdempotencyStore`, smart routing, half-open circuit breakers, retry backoff, and timeout-safe failover.
   */
  async disburse(params: DisburseParams): Promise<DisburseResult> {
    validateDisburseInputs(params.amount, params.currency, params.reference);
    const refKey = params.reference.trim();
    const fingerprint = computeDisburseFingerprint(params);

    // 1. Register in-flight singleflight synchronously BEFORE any await so concurrent calls coalesce
    const active = this.#inFlight.get(refKey);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        throw new PayoutProviderError({
          message: `Idempotency conflict: reference "${refKey}" is already in flight with different parameters`,
          rail: this.resolveRail(params),
          code: 'IDEMPOTENCY_CONFLICT',
          isAmbiguous: false,
          retryable: false,
        });
      }
      return active.promise;
    }

    const promise = this.executeDisbursePipeline(params, refKey, fingerprint);
    this.#inFlight.set(refKey, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(refKey);
    }
  }

  private async executeDisbursePipeline(
    params: DisburseParams,
    refKey: string,
    fingerprint: string
  ): Promise<DisburseResult> {
    // Optional pluggable persistence check (Redis / Postgres / InMemoryIdempotencyStore)
    if (this.#idempotencyStore) {
      const existing = await this.#idempotencyStore.get(refKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new PayoutProviderError({
            message: `Idempotency conflict: reference "${refKey}" was previously used with different parameters`,
            rail: this.resolveRail(params),
            code: 'IDEMPOTENCY_CONFLICT',
            isAmbiguous: false,
            retryable: false,
          });
        }
        if (existing.result) {
          return existing.result;
        }
        if (existing.state === 'IN_PROGRESS') {
          throw new PayoutProviderError({
            message: `Payout "${refKey}" is currently in progress on another instance`,
            rail: existing.rail || this.resolveRail(params),
            code: 'IN_PROGRESS',
            isAmbiguous: false,
            retryable: true,
          });
        }
        if (existing.state === 'AMBIGUOUS' && !params.allowUnsafeTimeoutFailover) {
          const origRail = existing.rail || this.resolveRail(params);
          if (REFERENCE_LOOKUP_RAILS.has(origRail)) {
            try {
              const reconciled = await this.getPayoutStatus({
                transactionId: refKey,
                reference: refKey,
                rail: origRail,
              });
              if (reconciled.status !== 'FAILED') {
                await this.#idempotencyStore.set(
                  refKey,
                  { fingerprint, state: 'COMPLETED', rail: origRail, updatedAt: Date.now(), result: reconciled },
                  this.#idempotencyTtlMs
                );
                return reconciled;
              }
            } catch (statusErr: any) {
              if (!(statusErr instanceof PayoutProviderError && statusErr.statusCode === 404)) {
                throw new PayoutAmbiguousError(origRail, refKey, 'prior instance left payout in AMBIGUOUS state');
              }
            }
          } else {
            throw new PayoutAmbiguousError(origRail, refKey, 'prior instance left payout in AMBIGUOUS state');
          }
        }
      }
    }
    const candidateRails = this.resolveRoute(params);
    const primaryRail = candidateRails[0];
    const attemptedRails: PayoutRail[] = [];
    let lastError: Error | undefined;
    let lastFailedResult: DisburseResult | undefined;
    const currency = params.currency.toUpperCase();

    for (let i = 0; i < candidateRails.length; i++) {
      const rail = candidateRails[i];
      const hasFallback = i < candidateRails.length - 1;

      // Per-rail min/max transaction limit check
      const limit = this.#railLimits[rail];
      if (limit) {
        if (
          (limit.minAmount !== undefined && params.amount < limit.minAmount) ||
          (limit.maxAmount !== undefined && params.amount > limit.maxAmount)
        ) {
          const limitErr = new PayoutProviderError({
            message: `Amount ${params.amount} ${currency} is outside configured limits for ${rail}`,
            rail,
            code: 'LIMIT_EXCEEDED',
            isAmbiguous: false,
            retryable: false,
          });
          lastError = limitErr;
          if (hasFallback) continue;
          throw limitErr;
        }
      }

      // Circuit-breaker check (supports CLOSED -> OPEN -> HALF_OPEN single probe)
      const prevState = this.#health.getHealth(rail).state;
      if (!this.#health.tryAcquire(rail) && hasFallback) {
        lastError = new PayoutProviderError({
          message: `Rail ${rail} circuit breaker is open (unhealthy)`,
          rail,
          code: 'PROVIDER_DOWN',
          isAmbiguous: false,
          retryable: false,
        });
        continue;
      }

      attemptedRails.push(rail);

      if (params.checkBalanceBeforeDisburse) {
        try {
          const balances = await this.getBalances(rail);
          const match = balances.find((b) => b.currency === currency);
          if (match && match.available < params.amount) {
            const insufficientErr = new PayoutProviderError({
              message: `Insufficient ${currency} balance on ${rail}: available ${match.available}, required ${params.amount}`,
              rail,
              code: 'INSUFFICIENT_FLOAT',
              isAmbiguous: false,
              retryable: false,
            });
            lastError = insufficientErr;
            if (hasFallback) continue;
            throw insufficientErr;
          }
        } catch (err: any) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (hasFallback) continue;
          throw lastError;
        }
      }

      // Persist pre-dispatch IN_PROGRESS lock for multi-instance safety when IdempotencyStore is configured
      if (this.#idempotencyStore) {
        await this.#idempotencyStore.set(
          refKey,
          { fingerprint, state: 'IN_PROGRESS', rail, updatedAt: Date.now() },
          this.#idempotencyTtlMs
        );
      }

      const startMs = Date.now();
      try {
        const result = await withRetry(
          () => this.disburseOnRail(rail, params),
          this.#retryConfig,
          (retryErr, attempt) => {
            this.emit({
              type: 'disburse.retry',
              rail,
              reference: refKey,
              errorCode: retryErr.code,
              message: `Retry attempt ${attempt}: ${retryErr.message}`,
            });
          }
        );
        const latencyMs = Date.now() - startMs;

        if (result.status === 'FAILED') {
          this.#health.recordFailure(rail, latencyMs, result.error || `${rail} disbursement failed`);
          const nextState = this.#health.getHealth(rail).state;
          if (nextState !== prevState) {
            this.emit({ type: 'circuit.state_change', rail, circuitState: nextState });
          }
          this.emit({ type: 'disburse.failed', rail, reference: refKey, latencyMs, message: result.error });

          if (hasFallback) {
            lastFailedResult = result;
            lastError = new Error(result.error || `${rail} disbursement returned FAILED`);
            continue;
          }
          if (this.#idempotencyStore) {
            await this.#idempotencyStore.delete?.(refKey);
          }
        } else {
          this.#health.recordSuccess(rail, latencyMs);
          const nextState = this.#health.getHealth(rail).state;
          if (nextState !== prevState) {
            this.emit({ type: 'circuit.state_change', rail, circuitState: nextState });
          }
        }

        const finalResult: DisburseResult = {
          ...result,
          attemptedRails,
          failoverFrom: rail !== primaryRail ? primaryRail : undefined,
        };

        if (rail !== primaryRail) {
          this.emit({
            type: 'disburse.failover',
            rail,
            failoverFrom: primaryRail,
            reference: refKey,
            latencyMs,
          });
        }
        this.emit({ type: 'disburse.success', rail, reference: refKey, latencyMs });

        if (this.#idempotencyStore && finalResult.status !== 'FAILED') {
          await this.#idempotencyStore.set(
            refKey,
            { fingerprint, state: 'COMPLETED', rail, updatedAt: Date.now(), result: finalResult },
            this.#idempotencyTtlMs
          );
        }

        return finalResult;
      } catch (err: any) {
        const latencyMs = Date.now() - startMs;
        lastError = err instanceof Error ? err : new Error(String(err));
        this.#health.recordFailure(rail, latencyMs, lastError.message);
        const nextState = this.#health.getHealth(rail).state;
        if (nextState !== prevState) {
          this.emit({ type: 'circuit.state_change', rail, circuitState: nextState });
        }
        this.emit({
          type: 'disburse.failed',
          rail,
          reference: refKey,
          latencyMs,
          errorCode: err instanceof PayoutProviderError ? err.code : 'PROVIDER_ERROR',
          message: lastError.message,
        });

        const isAmbiguous = err instanceof PayoutProviderError && err.isAmbiguous;
        if (isAmbiguous && !params.allowUnsafeTimeoutFailover) {
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
              const recovered: DisburseResult = {
                ...reconciled,
                attemptedRails,
                failoverFrom: rail !== primaryRail ? primaryRail : undefined,
              };
              if (this.#idempotencyStore && recovered.status !== 'FAILED') {
                await this.#idempotencyStore.set(
                  refKey,
                  { fingerprint, state: 'COMPLETED', rail, updatedAt: Date.now(), result: recovered },
                  this.#idempotencyTtlMs
                );
              }
              return recovered;
            } catch (statusErr: any) {
              if (statusErr instanceof PayoutProviderError && statusErr.statusCode === 404) {
                if (hasFallback) continue;
                if (this.#idempotencyStore) await this.#idempotencyStore.delete?.(refKey);
                throw lastError;
              }
            }
          }
          // Persist AMBIGUOUS state so other instances/restarts NEVER blindly fail over on retry
          if (this.#idempotencyStore) {
            await this.#idempotencyStore.set(
              refKey,
              { fingerprint, state: 'AMBIGUOUS', rail, updatedAt: Date.now() },
              this.#idempotencyTtlMs
            );
          }
          throw new PayoutAmbiguousError(rail, params.reference, lastError.message);
        }

        if (hasFallback) {
          continue;
        }
        if (this.#idempotencyStore) {
          await this.#idempotencyStore.delete?.(refKey);
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
   * Polls `getPayoutStatus` with configurable exponential backoff until the payout reaches
   * a terminal state (`SUCCESSFUL` or `FAILED`), or throws `RECONCILIATION_TIMEOUT`.
   */
  async waitForSettlement(
    params: PayoutStatusParams,
    options?: ReconcileOptions
  ): Promise<DisburseResult> {
    const maxAttempts = options?.maxAttempts ?? 10;
    const initialInterval = options?.intervalMs ?? 2_000;
    const multiplier = options?.backoffMultiplier ?? 1.5;
    const maxInterval = options?.maxIntervalMs ?? 15_000;

    let delay = initialInterval;
    let latest: DisburseResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      latest = await this.getPayoutStatus(params);
      if (latest.status === 'SUCCESSFUL' || latest.status === 'FAILED') {
        return latest;
      }
      if (attempt < maxAttempts) {
        await sleepMs(delay);
        delay = Math.min(maxInterval, Math.round(delay * multiplier));
      }
    }

    throw new PayoutProviderError({
      message: `Payout "${params.reference || params.transactionId}" on ${params.rail} remained PENDING after ${maxAttempts} reconciliation attempts`,
      rail: params.rail,
      code: 'RECONCILIATION_TIMEOUT',
      isAmbiguous: false,
      retryable: true,
    });
  }

  /**
   * Returns live uptime/latency health and circuit-breaker state (`CLOSED` / `OPEN` / `HALF_OPEN`).
   */
  getRailHealth(rail?: PayoutRail): RailHealth[] {
    if (rail) {
      return [this.#health.getHealth(rail)];
    }
    return this.getConfiguredRails().map((r) => this.#health.getHealth(r));
  }

  /**
   * Invalidates cached float balances (when `balanceCacheTtlMs > 0`).
   */
  invalidateBalanceCache(rail?: PayoutRail): void {
    if (rail) {
      this.#balanceCache.delete(rail);
    } else {
      this.#balanceCache.clear();
    }
  }

  /**
   * Fetches the latest settlement status for a previously initiated payout.
   */
  async getPayoutStatus(params: PayoutStatusParams): Promise<DisburseResult> {
    if (!params.transactionId) {
      throw new Error('transactionId is required to check payout status');
    }

    return withRetry(async () => {
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
    }, this.#retryConfig);
  }

  private async fetchSingleRailBalance(rail: PayoutRail): Promise<RailBalance[]> {
    if (this.#balanceCacheTtlMs > 0) {
      const cached = this.#balanceCache.get(rail);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.balances;
      }
    }

    const balances = await withRetry(async () => {
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
      throw new Error(`Unsupported payout rail: ${rail}`);
    }, this.#retryConfig);

    if (this.#balanceCacheTtlMs > 0) {
      this.#balanceCache.set(rail, {
        balances,
        expiresAt: Date.now() + this.#balanceCacheTtlMs,
      });
    }
    return balances;
  }

  /**
   * Queries available float balances for a specific rail or across all configured rails.
   */
  async getBalances(rail?: PayoutRail): Promise<RailBalance[]> {
    if (rail) {
      return this.fetchSingleRailBalance(rail);
    }
    const configured = this.getConfiguredRails();
    const results = await Promise.all(configured.map((r) => this.fetchSingleRailBalance(r)));
    return results.flat();
  }

  private verifyWebhookRaw(rail: PayoutRail, rawBody: string, signature: string): WebhookEvent {
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
   * Verifies a provider webhook signature synchronously and normalizes the event.
   * When a synchronous `webhookStore` (like `InMemoryWebhookStore`) is configured, also flags duplicates.
   */
  verifyWebhook(rail: PayoutRail, rawBody: string, signature: string): WebhookEvent {
    const event = this.verifyWebhookRaw(rail, rawBody, signature);

    if (this.#webhookStore) {
      const eventKey = `${rail}:${event.eventType}:${event.transactionId || event.reference}:${event.status}`;
      const seen = this.#webhookStore.hasSeen(eventKey);
      if (typeof seen === 'boolean') {
        if (seen) {
          this.emit({ type: 'webhook.duplicate', rail, reference: event.reference });
          if (this.#webhookDedup?.rejectDuplicates) {
            throw new PayoutProviderError({
              message: `Duplicate webhook event detected on ${rail} for "${event.reference}"`,
              rail,
              code: 'DUPLICATE_WEBHOOK',
              isAmbiguous: false,
              retryable: false,
            });
          }
          return { ...event, duplicate: true };
        }
        void this.#webhookStore.markSeen(eventKey, this.#webhookDedup?.ttlMs ?? 86_400_000);
      }
    }

    this.emit({ type: 'webhook.verified', rail, reference: event.reference });
    return event;
  }

  /**
   * Async variant of `verifyWebhook` supporting asynchronous `WebhookStore` backends (e.g. Redis / Postgres).
   */
  async verifyWebhookAsync(rail: PayoutRail, rawBody: string, signature: string): Promise<WebhookEvent> {
    const event = this.verifyWebhookRaw(rail, rawBody, signature);

    if (this.#webhookStore) {
      const eventKey = `${rail}:${event.eventType}:${event.transactionId || event.reference}:${event.status}`;
      const seen = await this.#webhookStore.hasSeen(eventKey);
      if (seen) {
        this.emit({ type: 'webhook.duplicate', rail, reference: event.reference });
        if (this.#webhookDedup?.rejectDuplicates) {
          throw new PayoutProviderError({
            message: `Duplicate webhook event detected on ${rail} for "${event.reference}"`,
            rail,
            code: 'DUPLICATE_WEBHOOK',
            isAmbiguous: false,
            retryable: false,
          });
        }
        return { ...event, duplicate: true };
      }
      await this.#webhookStore.markSeen(eventKey, this.#webhookDedup?.ttlMs ?? 86_400_000);
    }

    this.emit({ type: 'webhook.verified', rail, reference: event.reference });
    return event;
  }

  /**
   * Verifies a webhook signature, checks duplicate/out-of-order state guards,
   * and confirms the authoritative payout state & amount directly against the provider API.
   */
  async verifyAndConfirmWebhook(
    rail: PayoutRail,
    rawBody: string,
    signature: string,
    options?: { stripeAccountId?: string; currentStatus?: PayoutStatus }
  ): Promise<WebhookEvent> {
    const event = await this.verifyWebhookAsync(rail, rawBody, signature);
    if (event.duplicate) {
      return event;
    }

    const isReversal = /reversed/i.test(event.eventType);
    if (
      options?.currentStatus &&
      !canTransitionStatus(options.currentStatus, event.status, isReversal)
    ) {
      return {
        ...event,
        status: options.currentStatus,
      };
    }

    const confirmed = await this.getPayoutStatus({
      transactionId: event.transactionId || event.reference,
      reference: event.reference || undefined,
      rail,
      stripeAccountId: options?.stripeAccountId,
    });

    if (event.amount > 0 && confirmed.amount > 0 && Math.abs(event.amount - confirmed.amount) > 0.01) {
      throw new Error(
        `Webhook amount mismatch on ${rail}: webhook reported ${event.amount}, provider API reported ${confirmed.amount}`
      );
    }
    if (event.currency && confirmed.currency && event.currency !== confirmed.currency) {
      throw new Error(
        `Webhook currency mismatch on ${rail}: webhook reported ${event.currency}, provider API reported ${confirmed.currency}`
      );
    }

    const finalStatus =
      options?.currentStatus &&
      !canTransitionStatus(options.currentStatus, confirmed.status, isReversal)
        ? options.currentStatus
        : confirmed.status;

    return {
      ...event,
      status: finalStatus,
      providerStatus: confirmed.providerStatus || event.providerStatus,
      amount: confirmed.amount || event.amount,
      currency: confirmed.currency || event.currency,
      fee: confirmed.fee ?? event.fee,
      error: confirmed.error || event.error,
    };
  }

  matchAccountNames(
    expectedName: string,
    resolvedName: string,
    threshold = 0.66
  ): NameMatchResult {
    return matchAccountNames(expectedName, resolvedName, threshold);
  }

  canTransitionStatus(
    currentStatus: PayoutStatus | undefined | null,
    nextStatus: PayoutStatus,
    allowReversal = false
  ): boolean {
    return canTransitionStatus(currentStatus, nextStatus, allowReversal);
  }

  async resolveBankAccount(
    bankCode: string,
    accountNumber: string,
    rail?: 'FLUTTERWAVE' | 'PAYSTACK',
    currency = 'NGN'
  ): Promise<BankResolutionResult> {
    if (rail === 'PAYSTACK') {
      if (!this.#paystack) {
        throw new Error('Paystack provider is not configured for bank resolution');
      }
      return this.#paystack.resolveBankAccount(
        resolveProviderCode(bankCode, currency, 'PAYSTACK', false),
        accountNumber
      );
    }
    if (rail === 'FLUTTERWAVE') {
      if (!this.#flutterwave) {
        throw new Error('Flutterwave provider is not configured for bank resolution');
      }
      return this.#flutterwave.resolveBankAccount(
        resolveProviderCode(bankCode, currency, 'FLUTTERWAVE', false),
        accountNumber
      );
    }

    if (this.#flutterwave) {
      try {
        return await this.#flutterwave.resolveBankAccount(
          resolveProviderCode(bankCode, currency, 'FLUTTERWAVE', false),
          accountNumber
        );
      } catch (err) {
        if (this.#paystack) {
          return this.#paystack.resolveBankAccount(
            resolveProviderCode(bankCode, currency, 'PAYSTACK', false),
            accountNumber
          );
        }
        throw err;
      }
    }

    if (this.#paystack) {
      return this.#paystack.resolveBankAccount(
        resolveProviderCode(bankCode, currency, 'PAYSTACK', false),
        accountNumber
      );
    }

    throw new Error('Neither Flutterwave nor Paystack is configured for bank resolution');
  }

  async createConnectOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult> {
    if (!this.#stripe) {
      throw new Error('Stripe Connect provider is not configured for onboarding links');
    }
    return this.#stripe.createOnboardingLink(params);
  }

  /**
   * Independently exports settled/pending payout records directly from a provider (or all configured
   * bulk-exportable providers) for a date range — enabling "two paths, same numbers" auditing.
   */
  async exportSettlements(params: SettlementExportParams): Promise<SettlementRecord[]> {
    if (!(params.from instanceof Date) || !(params.to instanceof Date) || params.from > params.to) {
      throw new Error('Valid from and to Date bounds (from <= to) are required for settlement export');
    }

    const fetchForRail = async (rail: PayoutRail): Promise<SettlementRecord[]> =>
      withRetry(async () => {
        if (rail === 'STRIPE_CONNECT') {
          if (!this.#stripe) throw new Error('Stripe Connect provider is not configured');
          return this.#stripe.exportSettlements(params);
        }
        if (rail === 'FLUTTERWAVE') {
          if (!this.#flutterwave) throw new Error('Flutterwave provider is not configured');
          return this.#flutterwave.exportSettlements(params);
        }
        if (rail === 'PAYSTACK') {
          if (!this.#paystack) throw new Error('Paystack provider is not configured');
          return this.#paystack.exportSettlements(params);
        }
        if (rail === 'YELLOW_CARD') {
          if (!this.#yellowCard) throw new Error('Yellow Card provider is not configured');
          return this.#yellowCard.exportSettlements(params);
        }
        throw new PayoutProviderError({
          message: `Bulk settlement export is not supported directly by ${rail}; reconcile individual references via getPayoutStatus()`,
          rail,
          code: 'PROVIDER_ERROR',
          isAmbiguous: false,
          retryable: false,
        });
      }, this.#retryConfig);

    if (params.rail) {
      return fetchForRail(params.rail);
    }

    const exportable: PayoutRail[] = [];
    if (this.#stripe) exportable.push('STRIPE_CONNECT');
    if (this.#flutterwave) exportable.push('FLUTTERWAVE');
    if (this.#paystack) exportable.push('PAYSTACK');
    if (this.#yellowCard) exportable.push('YELLOW_CARD');

    const batches = await Promise.all(exportable.map((r) => fetchForRail(r)));
    return batches.flat();
  }

  /**
   * Pure two-path reconciliation diff comparing your local ledger (including AMBIGUOUS payouts)
   * against an independent provider settlement export.
   */
  reconcileBatch(
    localRecords: LocalLedgerRecord[],
    providerRecords: SettlementRecord[]
  ): ReconciliationReport {
    return reconcileBatch(localRecords, providerRecords);
  }

  /**
   * Exports normalized SettlementRecords as a formula-injection-safe RFC 4180 CSV for accounting.
   */
  formatSettlementsCsv(records: SettlementRecord[]): string {
    return formatSettlementsCsv(records);
  }
}
