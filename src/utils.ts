import crypto from 'crypto';
import { PayoutRail } from './types';

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
