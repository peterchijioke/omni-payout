import crypto from 'crypto';
import { NameMatchResult, PayoutRail, PayoutStatus } from './types';

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_REGEX = /^[A-Za-z]{3}$/;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

export class PayoutProviderError extends Error {
  public readonly rail: PayoutRail;
  public readonly statusCode?: number;
  public readonly isAmbiguous: boolean;

  constructor(opts: {
    message: string;
    rail: PayoutRail;
    statusCode?: number;
    isAmbiguous: boolean;
  }) {
    super(opts.message);
    this.name = 'PayoutProviderError';
    this.rail = opts.rail;
    this.statusCode = opts.statusCode;
    this.isAmbiguous = opts.isAmbiguous;
  }
}

export class PayoutAmbiguousError extends Error {
  public readonly rail: PayoutRail;
  public readonly reference: string;
  public readonly isAmbiguous = true;

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

export function toMinorUnits(amount: number, currency: string): number {
  const exp = currencyExponent(currency);
  const factor = Math.pow(10, exp);
  return Math.round(Number((amount * factor).toPrecision(15)));
}

export function fromMinorUnits(minorAmount: number, currency: string): number {
  const exp = currencyExponent(currency);
  const factor = Math.pow(10, exp);
  return minorAmount / factor;
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

/**
 * Deterministically converts any reference string into a valid RFC 4122 UUID
 * so PawaPay accepts human-readable references while preserving retry idempotency.
 */
export function toDeterministicUuid(reference: string): string {
  const trimmed = reference.trim();
  if (UUID_REGEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const hash = crypto.createHash('sha256').update(`omni-payout:pawapay:${trimmed}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Set version 4 (0100) and RFC 4122 variant (10xx)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Determines whether an HTTP status code from a POST disbursement is ambiguous
 * (i.e. the upstream bank/MNO may still have received and processed it).
 * 4xx and 501/503 are pre-execution rejections; 500/502/504 and network timeouts are ambiguous.
 */
export function isHttpStatusAmbiguous(statusCode: number): boolean {
  if (statusCode >= 400 && statusCode < 500) return false;
  if (statusCode === 501 || statusCode === 503) return false;
  return statusCode >= 500;
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

/**
 * Normalizes phone numbers (`+254 712-345-678`, `0712345678`, `00254712345678`)
 * into bare ITU-T E.164 MSISDN digits (`254712345678`) required by M-Pesa Daraja & PawaPay.
 */
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

/**
 * Encrypts a plaintext Safaricom M-Pesa initiator password using the Daraja X.509 certificate
 * (RSA PKCS#1 v1.5 padding, Base64-encoded) to produce `SecurityCredential`.
 */
export function encryptMpesaInitiatorPassword(
  initiatorPassword: string,
  certificatePem: string
): string {
  if (!initiatorPassword || !certificatePem) {
    throw new Error('Both initiatorPassword and certificatePem are required to generate SecurityCredential');
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

/**
 * Compares an expected beneficiary name against a resolved bank account name,
 * handling word-order differences (e.g. "Peter Chukwu" vs "CHUKWU CHIJIOKE PETER") and honorifics.
 */
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

  // Containment score relative to the shorter name handles middle-name presence cleanly
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

/**
 * Guards payout state machines against out-of-order webhooks
 * (e.g. a delayed PENDING webhook arriving after SUCCESSFUL or FAILED).
 */
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
  // Ghana (GHS) canonical aliases
  GCB_GHS: { FLUTTERWAVE: 'GH040100', PAYSTACK: '040100', YELLOW_CARD: 'GCB' },
  ECOBANK_GHS: { FLUTTERWAVE: 'GH130100', PAYSTACK: '130100', YELLOW_CARD: 'ECOBANK' },
  ABSA_GHS: { FLUTTERWAVE: 'GH030100', PAYSTACK: '030100', YELLOW_CARD: 'ABSA' },
  STANBIC_GHS: { FLUTTERWAVE: 'GH190100', PAYSTACK: '190100', YELLOW_CARD: 'STANBIC' },
  FIDELITY_GHS: { FLUTTERWAVE: 'GH240100', PAYSTACK: '240100', YELLOW_CARD: 'FIDELITY' },
  // Kenya (KES) canonical aliases
  EQUITY_KES: { FLUTTERWAVE: '68', PAYSTACK: '68', YELLOW_CARD: 'EQUITY' },
  KCB_KES: { FLUTTERWAVE: '01', PAYSTACK: '01', YELLOW_CARD: 'KCB' },
  COOP_KES: { FLUTTERWAVE: '11', PAYSTACK: '11', YELLOW_CARD: 'COOP' },
  ABSA_KES: { FLUTTERWAVE: '03', PAYSTACK: '03', YELLOW_CARD: 'ABSA' },
  // South Africa (ZAR) canonical aliases
  FNB_ZAR: { FLUTTERWAVE: '250655', PAYSTACK: '250655', YELLOW_CARD: 'FNB' },
  ABSA_ZAR: { FLUTTERWAVE: '632005', PAYSTACK: '632005', YELLOW_CARD: 'ABSA' },
  STANDARD_BANK_ZAR: { FLUTTERWAVE: '051001', PAYSTACK: '051001', YELLOW_CARD: 'SBSA' },
  CAPITEC_ZAR: { FLUTTERWAVE: '470010', PAYSTACK: '470010', YELLOW_CARD: 'CAPITEC' },
  NEDBANK_ZAR: { FLUTTERWAVE: '198765', PAYSTACK: '198765', YELLOW_CARD: 'NEDBANK' },
};

/**
 * Resolves canonical mobile-money network codes or cross-corridor bank aliases
 * to the target provider's expected code during multi-rail failover.
 */
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

