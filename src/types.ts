export type PayoutRail =
  | 'STRIPE_CONNECT'
  | 'FLUTTERWAVE'
  | 'PAYSTACK'
  | 'PAWAPAY'
  | 'YELLOW_CARD'
  | 'MPESA_DARAJA';

export type PayoutSpeed = 'standard' | 'instant';

export type PayoutStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type PayoutErrorCode =
  | 'VALIDATION_ERROR'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IN_PROGRESS'
  | 'AUTH_FAILED'
  | 'INVALID_ACCOUNT'
  | 'INSUFFICIENT_FLOAT'
  | 'LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'PROVIDER_DOWN'
  | 'AMBIGUOUS_TIMEOUT'
  | 'DUPLICATE_REFERENCE'
  | 'DUPLICATE_WEBHOOK'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'RECONCILIATION_TIMEOUT'
  | 'PROVIDER_ERROR';

export type RoutingStrategy = 'priority' | 'lowest_fee' | 'health_first';

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
  country?: string;
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
  metadata?: Record<string, string>;
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
  rawResponse?: unknown;
}

export interface PayoutStatusParams {
  transactionId: string;
  rail: PayoutRail;
  stripeAccountId?: string;
  reference?: string;
}

export interface ReconcileOptions {
  /** Initial polling delay in milliseconds (default: 2000ms). */
  intervalMs?: number;
  /** Maximum polling attempts before throwing RECONCILIATION_TIMEOUT (default: 10). */
  maxAttempts?: number;
  /** Exponential backoff multiplier between polls (default: 1.5). */
  backoffMultiplier?: number;
  /** Maximum interval cap between polls in milliseconds (default: 15000ms). */
  maxIntervalMs?: number;
}

export interface RailBalance {
  rail: PayoutRail;
  currency: string;
  available: number;
  pending?: number;
}

export interface RailHealth {
  rail: PayoutRail;
  state: CircuitState;
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

export interface RetryConfig {
  /** Maximum retry attempts for retryable transient errors (default: 0). */
  maxRetries?: number;
  /** Base backoff delay in milliseconds (default: 250ms). */
  baseDelayMs?: number;
  /** Maximum backoff delay cap in milliseconds (default: 5000ms). */
  maxDelayMs?: number;
  /** Apply random full jitter to backoff delays (default: true). */
  jitter?: boolean;
}

export interface ProviderFeeRule {
  /** Flat fee in the payout currency (e.g. 10 NGN). */
  flat?: number;
  /** Percentage fee (e.g. 1.5 for 1.5%). */
  percent?: number;
}

export interface RailLimit {
  minAmount?: number;
  maxAmount?: number;
}

export interface RoutingRule {
  currencies?: string[];
  countries?: string[];
  minAmount?: number;
  maxAmount?: number;
  /** Ordered candidate rails when this rule matches. */
  rails: PayoutRail[];
  /** Routing priority mode: 'priority' (declared order), 'lowest_fee', or 'health_first' (reliability/latency). */
  strategy?: RoutingStrategy;
  /** Optional fee schedule used when strategy is 'lowest_fee' (or omitted with fees set). */
  fees?: Partial<Record<PayoutRail, ProviderFeeRule>>;
}

export interface WebhookDeduplicationConfig {
  /** Time-to-live for seen webhook event keys in milliseconds (default: 86400000ms / 24h). */
  ttlMs?: number;
  /** Throw DUPLICATE_WEBHOOK error instead of returning `duplicate: true` (default: false). */
  rejectDuplicates?: boolean;
}

export type IdempotencyState = 'IN_PROGRESS' | 'COMPLETED' | 'AMBIGUOUS';

export interface IdempotencyRecord {
  fingerprint: string;
  state?: IdempotencyState;
  rail?: PayoutRail;
  updatedAt?: number;
  result?: DisburseResult;
}

/**
 * Storage-agnostic idempotency adapter (plug in Redis, Postgres, DynamoDB, or InMemoryIdempotencyStore).
 * Omitted by default so `omni-payout` stays 100% stateless out of the box.
 */
export interface IdempotencyStore {
  get(reference: string): Promise<IdempotencyRecord | null | undefined> | IdempotencyRecord | null | undefined;
  set(reference: string, record: IdempotencyRecord, ttlMs?: number): Promise<void> | void;
  delete?(reference: string): Promise<void> | void;
}

/**
 * Storage-agnostic webhook deduplication adapter (plug in Redis, Postgres, or InMemoryWebhookStore).
 */
export interface WebhookStore {
  hasSeen(eventKey: string): Promise<boolean> | boolean;
  markSeen(eventKey: string, ttlMs?: number): Promise<void> | void;
}

/**
 * Monitoring-agnostic telemetry event emitted to plug into OpenTelemetry, Prometheus, Datadog, or logs.
 */
export interface PayoutTelemetryEvent {
  type:
    | 'disburse.success'
    | 'disburse.failed'
    | 'disburse.failover'
    | 'disburse.retry'
    | 'circuit.state_change'
    | 'webhook.verified'
    | 'webhook.duplicate';
  rail: PayoutRail;
  reference?: string;
  latencyMs?: number;
  errorCode?: PayoutErrorCode;
  circuitState?: CircuitState;
  failoverFrom?: PayoutRail;
  message?: string;
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
  duplicate?: boolean;
  error?: string;
  rawPayload?: unknown;
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

export interface SettlementExportParams {
  /** Omit to export concurrently across all configured rails that support bulk listing. */
  rail?: PayoutRail;
  from: Date;
  to: Date;
  limit?: number;
  /** Optional Stripe connected account ID to export `/v1/payouts` instead of platform `/v1/transfers`. */
  stripeAccountId?: string;
}

export interface SettlementRecord {
  rail: PayoutRail;
  transactionId: string;
  reference: string;
  status: PayoutStatus;
  providerStatus?: string;
  amount: number;
  currency: string;
  fee?: number;
  createdAt?: Date;
}

export interface LocalLedgerRecord {
  reference: string;
  rail?: PayoutRail;
  amount: number;
  currency: string;
  status: PayoutStatus | 'AMBIGUOUS';
  transactionId?: string;
}

export interface ReconciliationMatch {
  local: LocalLedgerRecord;
  provider: SettlementRecord;
}

export interface ReconciliationMismatch {
  reference: string;
  local: LocalLedgerRecord;
  provider: SettlementRecord;
  reason: string;
}

export interface ReconciliationSummary {
  totalLocalCount: number;
  totalProviderCount: number;
  matchedCount: number;
  discrepancyCount: number;
  resolvedAmbiguousCount: number;
  totalLocalAmount: number;
  totalProviderAmount: number;
  totalProviderFees: number;
}

export interface ReconciliationReport {
  matched: ReconciliationMatch[];
  statusMismatches: ReconciliationMismatch[];
  amountMismatches: ReconciliationMismatch[];
  missingOnProvider: LocalLedgerRecord[];
  missingInLedger: SettlementRecord[];
  summary: ReconciliationSummary;
}

export interface OmniPayoutConfig {
  /** Default HTTP request timeout in milliseconds across providers (default: 30000ms). */
  timeoutMs?: number;
  /** Optional TTL in milliseconds to cache `getBalances()` results for fast float checks (default: 0 / stateless). */
  balanceCacheTtlMs?: number;
  /** Optional TTL in milliseconds passed to `idempotencyStore.set()` (default: 86400000ms / 24h). */
  idempotencyTtlMs?: number;
  /** Optional storage-agnostic persistence adapter (Redis/Postgres/DynamoDB) for distributed idempotency. */
  idempotencyStore?: IdempotencyStore;
  /** Optional storage-agnostic adapter for duplicate webhook event detection. */
  webhookStore?: WebhookStore;
  /** Duplicate webhook handling options when `webhookStore` is provided. */
  webhookDeduplication?: WebhookDeduplicationConfig;
  /** Optional monitoring-agnostic hook for OpenTelemetry, Prometheus, Datadog, or structured logging. */
  onTelemetry?: (event: PayoutTelemetryEvent) => void;
  /** Configurable retry policy with exponential backoff and jitter. */
  retry?: RetryConfig;
  /** Configurable smart routing rules by country, currency, amount limits, and fees. */
  routingRules?: RoutingRule[];
  /** Per-rail transaction amount min/max limits. */
  railLimits?: Partial<Record<PayoutRail, RailLimit>>;
  stripe?: {
    secretKey: string;
    webhookSecret?: string;
    webhookToleranceSec?: number;
    timeoutMs?: number;
  };
  flutterwave?: {
    secretKey: string;
    publicKey?: string;
    webhookSecret?: string;
    timeoutMs?: number;
  };
  paystack?: {
    secretKey: string;
    webhookSecret?: string;
    timeoutMs?: number;
  };
  pawapay?: {
    apiToken: string;
    baseUrl?: string;
    webhookSecret?: string;
    timeoutMs?: number;
  };
  yellowCard?: {
    apiKey: string;
    secretKey: string;
    baseUrl?: string;
    webhookSecret?: string;
    timeoutMs?: number;
  };
  mpesaDaraja?: {
    consumerKey: string;
    consumerSecret: string;
    shortCode: string;
    initiatorName: string;
    securityCredential?: string;
    initiatorPassword?: string;
    certificatePem?: string;
    resultUrl: string;
    queueTimeoutUrl: string;
    baseUrl?: string;
    webhookSecret?: string;
    timeoutMs?: number;
  };
  health?: HealthConfig;
}
