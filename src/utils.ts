import crypto from 'crypto';
import {
  IdempotencyRecord,
  IdempotencyStore,
  LocalLedgerRecord,
  NameMatchResult,
  PayoutErrorCode,
  PayoutRail,
  PayoutStatus,
  ReconciliationMatch,
  ReconciliationMismatch,
  ReconciliationReport,
  RetryConfig,
  SettlementRecord,
  WebhookStore,
} from './types';

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_REGEX = /^[A-Za-z]{3}$/;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

/**
 * Classifies provider HTTP status codes and error messages into consistent, actionable PayoutErrorCodes.
 */
export function classifyProviderError(
  statusCode: number | undefined,
  message: string,
  isAmbiguous: boolean
): { code: PayoutErrorCode; retryable: boolean } {
  if (isAmbiguous) {
    return { code: 'AMBIGUOUS_TIMEOUT', retryable: false };
  }
  const lower = (message || '').toLowerCase();

  if (statusCode === 401 || statusCode === 403 || /invalid.*key|unauthorized|authentication|forbidden/.test(lower)) {
    return { code: 'AUTH_FAILED', retryable: false };
  }
  if (statusCode === 429 || /rate\s*limit|too\s*many\s*requests/.test(lower)) {
    return { code: 'RATE_LIMITED', retryable: true };
  }
  if (statusCode === 409 || /duplicate|already\s*exists/.test(lower)) {
    return { code: 'DUPLICATE_REFERENCE', retryable: false };
  }
  if (/insufficient\s*(funds|balance|float)|low\s*balance/.test(lower)) {
    return { code: 'INSUFFICIENT_FLOAT', retryable: false };
  }
  if (/limit\s*exceeded|maximum.*amount|minimum.*amount|amount.*exceeds/.test(lower)) {
    return { code: 'LIMIT_EXCEEDED', retryable: false };
  }
  if (/invalid.*(account|recipient|iban|msisdn|phone|bank)|account.*not.*found|resolve.*failed/.test(lower)) {
    return { code: 'INVALID_ACCOUNT', retryable: false };
  }
  if (statusCode === 503 || statusCode === 501 || /service\s*unavailable|maintenance|gateway\s*down/.test(lower)) {
    return { code: 'PROVIDER_DOWN', retryable: true };
  }
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return { code: 'VALIDATION_ERROR', retryable: false };
  }
  return { code: 'PROVIDER_ERROR', retryable: false };
}

export class PayoutProviderError extends Error {
  public readonly rail: PayoutRail;
  public readonly code: PayoutErrorCode;
  public readonly statusCode?: number;
  public readonly isAmbiguous: boolean;
  public readonly retryable: boolean;

  constructor(opts: {
    message: string;
    rail: PayoutRail;
    statusCode?: number;
    isAmbiguous: boolean;
    code?: PayoutErrorCode;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = 'PayoutProviderError';
    this.rail = opts.rail;
    this.statusCode = opts.statusCode;
    this.isAmbiguous = opts.isAmbiguous;
    const classified = classifyProviderError(opts.statusCode, opts.message, opts.isAmbiguous);
    this.code = opts.code ?? classified.code;
    this.retryable = opts.retryable ?? classified.retryable;
  }
}

export class PayoutAmbiguousError extends Error {
  public readonly rail: PayoutRail;
  public readonly reference: string;
  public readonly code: PayoutErrorCode = 'AMBIGUOUS_TIMEOUT';
  public readonly isAmbiguous = true;
  public readonly retryable = false;

  constructor(rail: PayoutRail, reference: string, causeMessage: string) {
    super(
      `Ambiguous payout state on ${rail} for reference "${reference}" (${causeMessage}). ` +
        `Failover halted to prevent double payout; verify status with getPayoutStatus() before retrying on another rail.`
    );
    this.name = 'PayoutAmbiguousError';
    this.rail = rail;
    this.reference = reference;
  }
}

export function currencyExponent(currency: string): number {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return 3;
  return 2;
}

/**
 * Converts a major-unit decimal amount into exact integer minor units using string-based
 * decimal shifting (avoiding IEEE-754 floating-point drift on fractional currencies).
 */
export function toMinorUnits(amount: number | string, currency: string): number {
  const exp = currencyExponent(currency);
  const str = typeof amount === 'number' ? amount.toFixed(exp + 4) : String(amount).trim();
  const negative = str.startsWith('-');
  const unsigned = negative ? str.slice(1) : str;
  const [wholePart = '0', fracPart = ''] = unsigned.split('.');

  if (exp === 0) {
    const rounded = Math.round(Number(unsigned));
    return negative ? -rounded : rounded;
  }

  const paddedFrac = (fracPart + '0'.repeat(exp + 1)).slice(0, exp + 1);
  const mainDigits = paddedFrac.slice(0, exp);
  const guardDigit = Number(paddedFrac[exp] || '0');
  let minor = Number(wholePart) * Math.pow(10, exp) + Number(mainDigits);
  if (guardDigit >= 5) {
    minor += 1;
  }
  return negative ? -minor : minor;
}

export function fromMinorUnits(minorAmount: number, currency: string): number {
  const exp = currencyExponent(currency);
  if (exp === 0) return minorAmount;
  const factor = Math.pow(10, exp);
  return Number((minorAmount / factor).toFixed(exp));
}

export function validateDisburseInputs(amount: number, currency: string, reference: string): void {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('Disbursement amount must be a finite number greater than zero');
  }
  if (!currency || !CURRENCY_REGEX.test(currency)) {
    throw new Error('Currency must be a valid 3-letter ISO currency code');
  }
  if (!reference || typeof reference !== 'string' || reference.trim().length === 0) {
    throw new Error('Unique reference is required for idempotent disbursement');
  }
  if (reference.length > 200 || CONTROL_CHAR_REGEX.test(reference)) {
    throw new Error('Invalid reference: must be <= 200 characters with no control characters');
  }
}

export function validateSafeIdentifier(value: string, fieldName: string): string {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  if (
    value.length > 200 ||
    CONTROL_CHAR_REGEX.test(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..')
  ) {
    throw new Error(`Invalid ${fieldName}: contains unsafe path characters`);
  }
  return encodeURIComponent(value.trim());
}

export function sanitizeBaseUrl(baseUrl: string | undefined, defaultUrl: string): string {
  if (!baseUrl) return defaultUrl;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid baseUrl: ${baseUrl}`);
  }
  const isLocal =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new Error(`Insecure baseUrl protocol "${parsed.protocol}"; HTTPS is required`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('baseUrl must not embed credentials');
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
}

export function toDeterministicUuid(reference: string): string {
  const trimmed = reference.trim();
  if (UUID_REGEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const hash = crypto.createHash('sha256').update(`omni-payout:pawapay:${trimmed}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isHttpStatusAmbiguous(statusCode: number): boolean {
  if (statusCode >= 400 && statusCode < 500) return false;
  if (statusCode === 501 || statusCode === 503) return false;
  return statusCode >= 500;
}

export async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an operation with configurable exponential backoff and optional full jitter,
 * retrying ONLY errors explicitly marked `retryable: true` and `isAmbiguous: false`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryConfig?: RetryConfig,
  onRetry?: (err: PayoutProviderError, attempt: number) => void
): Promise<T> {
  const maxRetries = retryConfig?.maxRetries ?? 0;
  if (maxRetries <= 0) {
    return fn();
  }
  const baseDelayMs = retryConfig?.baseDelayMs ?? 250;
  const maxDelayMs = retryConfig?.maxDelayMs ?? 5_000;
  const useJitter = retryConfig?.jitter ?? true;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const canRetry =
        attempt < maxRetries &&
        err instanceof PayoutProviderError &&
        err.retryable &&
        !err.isAmbiguous;
      if (!canRetry) {
        throw err;
      }
      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const delay = useJitter ? Math.floor(Math.random() * expDelay) : expDelay;
      attempt += 1;
      onRetry?.(err, attempt);
      await sleepMs(delay);
    }
  }
}

/**
 * Optional bounded in-memory reference implementation of `IdempotencyStore` for single-node setups or testing.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  constructor(private readonly maxEntries = 5_000) {}

  get(reference: string): IdempotencyRecord | null {
    const entry = this.entries.get(reference);
    if (!entry) return null;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.entries.delete(reference);
      return null;
    }
    return entry.record;
  }

  set(reference: string, record: IdempotencyRecord, ttlMs = 86_400_000): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(reference)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(reference, {
      record,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    });
  }

  delete(reference: string): void {
    this.entries.delete(reference);
  }
}

/**
 * Optional bounded in-memory reference implementation of `WebhookStore` for single-node setups or testing.
 */
export class InMemoryWebhookStore implements WebhookStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = 5_000) {}

  hasSeen(eventKey: string): boolean {
    const exp = this.seen.get(eventKey);
    if (exp === undefined) return false;
    if (exp > 0 && Date.now() > exp) {
      this.seen.delete(eventKey);
      return false;
    }
    return true;
  }

  markSeen(eventKey: string, ttlMs = 86_400_000): void {
    if (this.seen.size >= this.maxEntries && !this.seen.has(eventKey)) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
    this.seen.set(eventKey, ttlMs > 0 ? Date.now() + ttlMs : 0);
  }
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  rail: PayoutRail,
  isMutatingPost = false
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOptions: RequestInit = options.signal
      ? options
      : { ...options, signal: controller.signal };
    return await fetch(url, fetchOptions);
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    const message = isAbort
      ? `${rail} request timed out after ${timeoutMs}ms`
      : err?.message || `${rail} network request failed`;
    throw new PayoutProviderError({
      message,
      rail,
      isAmbiguous: isMutatingPost,
      retryable: !isMutatingPost,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function constantTimeHexEqual(providedSig: string, expectedHex: string): boolean {
  if (!providedSig || !expectedHex) return false;
  const a = Buffer.from(providedSig.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expectedHex.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function constantTimeStringEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const CURRENCY_DIAL_CODES: Record<string, string> = {
  NGN: '234',
  KES: '254',
  GHS: '233',
  UGX: '256',
  TZS: '255',
  RWF: '250',
  ZAR: '27',
  ZMW: '260',
  XAF: '237',
  XOF: '225',
};

export const CURRENCY_COUNTRIES: Record<string, string> = {
  NGN: 'NG',
  KES: 'KE',
  GHS: 'GH',
  UGX: 'UG',
  TZS: 'TZ',
  RWF: 'RW',
  ZAR: 'ZA',
  ZMW: 'ZM',
  USD: 'US',
  GBP: 'GB',
};

export function normalizeMsisdn(phone: string, currency?: string): string {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Mobile money phone number is required');
  }
  let cleaned = phone.trim().replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  } else if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('0') && currency) {
    const dial = CURRENCY_DIAL_CODES[currency.toUpperCase()];
    if (dial) {
      cleaned = dial + cleaned.slice(1);
    }
  }

  if (!/^\d{7,15}$/.test(cleaned)) {
    throw new Error(`Invalid mobile money phone number: "${phone}"`);
  }
  return cleaned;
}

export function encryptMpesaInitiatorPassword(
  initiatorPassword: string,
  certificatePem: string
): string {
  if (!initiatorPassword || !certificatePem) {
    throw new Error(
      'Both initiatorPassword and certificatePem are required to generate SecurityCredential'
    );
  }
  const encrypted = crypto.publicEncrypt(
    {
      key: certificatePem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(initiatorPassword, 'utf8')
  );
  return encrypted.toString('base64');
}

const HONORIFIC_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'chief', 'alhaji', 'hajia', 'engr', 'sir', 'lady',
]);

function tokenizeAccountName(name: string): string[] {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !HONORIFIC_TOKENS.has(tok));
}

export function matchAccountNames(
  expectedName: string,
  resolvedName: string,
  threshold = 0.66
): NameMatchResult {
  const expectedTokens = tokenizeAccountName(expectedName);
  const actualTokens = tokenizeAccountName(resolvedName);
  const normalizedExpected = expectedTokens.join(' ');
  const normalizedActual = actualTokens.join(' ');

  if (expectedTokens.length === 0 || actualTokens.length === 0) {
    return { matched: false, score: 0, normalizedExpected, normalizedActual };
  }

  const actualSet = new Set(actualTokens);
  const expectedSet = new Set(expectedTokens);
  let intersection = 0;
  for (const tok of expectedSet) {
    if (actualSet.has(tok)) intersection++;
  }

  const minSize = Math.min(expectedSet.size, actualSet.size);
  const unionSize = new Set([...expectedSet, ...actualSet]).size;
  const containment = intersection / minSize;
  const jaccard = intersection / unionSize;
  const score = Number((containment * 0.75 + jaccard * 0.25).toFixed(4));

  return {
    matched: score >= threshold,
    score,
    normalizedExpected,
    normalizedActual,
  };
}

export function canTransitionStatus(
  currentStatus: PayoutStatus | undefined | null,
  nextStatus: PayoutStatus,
  allowReversal = false
): boolean {
  if (!currentStatus || currentStatus === 'PENDING') {
    return true;
  }
  if (currentStatus === nextStatus) {
    return true;
  }
  if (currentStatus === 'SUCCESSFUL' && nextStatus === 'FAILED' && allowReversal) {
    return true;
  }
  return false;
}

const PAYSTACK_MOMO_BANK_CODES: Record<string, string> = {
  MTN: 'MTN',
  VODAFONE: 'VOD',
  TELECEL: 'VOD',
  AIRTEL: 'ATL',
  AIRTELTIGO: 'ATL',
  MPESA: 'MPESA',
  ORANGE: 'ORANGE',
  WAVE: 'WAVE',
};

const CROSS_RAIL_BANK_CODES: Record<string, Partial<Record<PayoutRail, string>>> = {
  GCB_GHS: { FLUTTERWAVE: 'GH040100', PAYSTACK: '040100', YELLOW_CARD: 'GCB' },
  ECOBANK_GHS: { FLUTTERWAVE: 'GH130100', PAYSTACK: '130100', YELLOW_CARD: 'ECOBANK' },
  ABSA_GHS: { FLUTTERWAVE: 'GH030100', PAYSTACK: '030100', YELLOW_CARD: 'ABSA' },
  STANBIC_GHS: { FLUTTERWAVE: 'GH190100', PAYSTACK: '190100', YELLOW_CARD: 'STANBIC' },
  FIDELITY_GHS: { FLUTTERWAVE: 'GH240100', PAYSTACK: '240100', YELLOW_CARD: 'FIDELITY' },
  EQUITY_KES: { FLUTTERWAVE: '68', PAYSTACK: '68', YELLOW_CARD: 'EQUITY' },
  KCB_KES: { FLUTTERWAVE: '01', PAYSTACK: '01', YELLOW_CARD: 'KCB' },
  COOP_KES: { FLUTTERWAVE: '11', PAYSTACK: '11', YELLOW_CARD: 'COOP' },
  ABSA_KES: { FLUTTERWAVE: '03', PAYSTACK: '03', YELLOW_CARD: 'ABSA' },
  FNB_ZAR: { FLUTTERWAVE: '250655', PAYSTACK: '250655', YELLOW_CARD: 'FNB' },
  ABSA_ZAR: { FLUTTERWAVE: '632005', PAYSTACK: '632005', YELLOW_CARD: 'ABSA' },
  STANDARD_BANK_ZAR: { FLUTTERWAVE: '051001', PAYSTACK: '051001', YELLOW_CARD: 'SBSA' },
  CAPITEC_ZAR: { FLUTTERWAVE: '470010', PAYSTACK: '470010', YELLOW_CARD: 'CAPITEC' },
  NEDBANK_ZAR: { FLUTTERWAVE: '198765', PAYSTACK: '198765', YELLOW_CARD: 'NEDBANK' },
};

export function resolveProviderCode(
  code: string,
  currency: string,
  rail: PayoutRail,
  isMobileMoney = false
): string {
  const upperCode = code.trim().toUpperCase();
  const upperCur = currency.trim().toUpperCase();

  if (isMobileMoney) {
    if (rail === 'PAYSTACK') {
      return PAYSTACK_MOMO_BANK_CODES[upperCode] || upperCode;
    }
    if (rail === 'FLUTTERWAVE') {
      return upperCode.toLowerCase();
    }
    return upperCode;
  }

  const compositeKey = upperCode.endsWith(`_${upperCur}`)
    ? upperCode
    : `${upperCode}_${upperCur}`;
  const mapped = CROSS_RAIL_BANK_CODES[compositeKey]?.[rail];
  return mapped || code.trim();
}

/**
 * Pure, stateless two-path reconciliation diff engine ("two paths, same numbers").
 * Compares your application's local ledger (including AMBIGUOUS / PENDING payouts)
 * against an independent per-provider settlement export.
 */
export function reconcileBatch(
  localRecords: LocalLedgerRecord[],
  providerRecords: SettlementRecord[]
): ReconciliationReport {
  const providerByRef = new Map<string, SettlementRecord>();
  let totalProviderAmount = 0;
  let totalProviderFees = 0;

  for (const p of providerRecords) {
    const ref = (p.reference || p.transactionId || '').trim();
    if (ref) providerByRef.set(ref, p);
    totalProviderAmount += p.amount || 0;
    totalProviderFees += p.fee || 0;
  }

  const matched: ReconciliationMatch[] = [];
  const statusMismatches: ReconciliationMismatch[] = [];
  const amountMismatches: ReconciliationMismatch[] = [];
  const missingOnProvider: LocalLedgerRecord[] = [];
  const seenProviderRefs = new Set<string>();
  let totalLocalAmount = 0;
  let resolvedAmbiguousCount = 0;

  for (const local of localRecords) {
    const ref = local.reference.trim();
    totalLocalAmount += local.amount || 0;
    const provider = providerByRef.get(ref);

    if (!provider) {
      missingOnProvider.push(local);
      continue;
    }

    seenProviderRefs.add(ref);
    const localCur = local.currency.toUpperCase();
    const provCur = provider.currency.toUpperCase();
    const amountDiff = Math.abs(local.amount - provider.amount) > 0.01 || (localCur && provCur && localCur !== provCur);
    const statusDiff = local.status !== provider.status;

    if (local.status === 'AMBIGUOUS') {
      resolvedAmbiguousCount++;
    }

    if (amountDiff) {
      amountMismatches.push({
        reference: ref,
        local,
        provider,
        reason: `Local ${local.amount} ${localCur} != provider ${provider.amount} ${provCur}`,
      });
    } else if (statusDiff) {
      statusMismatches.push({
        reference: ref,
        local,
        provider,
        reason:
          local.status === 'AMBIGUOUS'
            ? `Resolved AMBIGUOUS payout: provider status is ${provider.status}`
            : `Local status ${local.status} != provider status ${provider.status}`,
      });
    } else {
      matched.push({ local, provider });
    }
  }

  const missingInLedger: SettlementRecord[] = [];
  for (const p of providerRecords) {
    const ref = (p.reference || p.transactionId || '').trim();
    if (!seenProviderRefs.has(ref)) {
      missingInLedger.push(p);
    }
  }

  const discrepancyCount =
    statusMismatches.length +
    amountMismatches.length +
    missingOnProvider.length +
    missingInLedger.length;

  return {
    matched,
    statusMismatches,
    amountMismatches,
    missingOnProvider,
    missingInLedger,
    summary: {
      totalLocalCount: localRecords.length,
      totalProviderCount: providerRecords.length,
      matchedCount: matched.length,
      discrepancyCount,
      resolvedAmbiguousCount,
      totalLocalAmount: Number(totalLocalAmount.toFixed(2)),
      totalProviderAmount: Number(totalProviderAmount.toFixed(2)),
      totalProviderFees: Number(totalProviderFees.toFixed(2)),
    },
  };
}

function escapeCsvField(val: string | number | undefined): string {
  if (val === undefined || val === null) return '';
  let str = String(val);
  // Neutralize spreadsheet formula injection (=, +, -, @) for safe accounting exports
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formats normalized SettlementRecords as an RFC 4180 CSV string for accounting & audit imports,
 * with automatic spreadsheet formula-injection neutralization.
 */
export function formatSettlementsCsv(records: SettlementRecord[]): string {
  const header = 'rail,transactionId,reference,status,providerStatus,amount,currency,fee,createdAt';
  const rows = records.map((r) =>
    [
      escapeCsvField(r.rail),
      escapeCsvField(r.transactionId),
      escapeCsvField(r.reference),
      escapeCsvField(r.status),
      escapeCsvField(r.providerStatus ?? ''),
      escapeCsvField(r.amount),
      escapeCsvField(r.currency),
      escapeCsvField(r.fee ?? ''),
      escapeCsvField(r.createdAt ? r.createdAt.toISOString() : ''),
    ].join(',')
  );
  return [header, ...rows].join('\n');
}
