import crypto from 'crypto';
import {
  DisburseParams,
  DisburseResult,
  PayoutStatus,
  RailBalance,
  SettlementExportParams,
  SettlementRecord,
  WebhookEvent,
} from '../types';
import {
  PayoutProviderError,
  constantTimeStringEqual,
  fetchWithTimeout,
  isHttpStatusAmbiguous,
  normalizeMsisdn,
  resolveProviderCode,
  sanitizeBaseUrl,
  validateSafeIdentifier,
} from '../utils';

function normalizeYellowCardStatus(rawStatus?: string): PayoutStatus {
  if (!rawStatus) return 'PENDING';
  switch (rawStatus.toLowerCase()) {
    case 'complete':
    case 'completed':
    case 'settled':
    case 'successful':
      return 'SUCCESSFUL';
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'rejected':
    case 'expired':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

export class YellowCardAdapter {
  readonly #apiKey: string;
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #webhookSecret?: string;
  readonly #timeoutMs: number;

  constructor(
    apiKey: string,
    secretKey: string,
    baseUrl?: string,
    webhookSecret?: string,
    timeoutMs = 30_000
  ) {
    if (!apiKey || !secretKey) {
      throw new Error('Yellow Card apiKey and secretKey are required');
    }
    this.#apiKey = apiKey;
    this.#secretKey = secretKey;
    this.#baseUrl = sanitizeBaseUrl(baseUrl, 'https://api.yellowcard.io');
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
  }

  private buildAuthHeaders(method: string, path: string, body?: string): Record<string, string> {
    const timestamp = new Date().toISOString();
    const upperMethod = method.toUpperCase();
    const hmac = crypto.createHmac('sha256', this.#secretKey);
    hmac.update(timestamp);
    hmac.update(path);
    hmac.update(upperMethod);
    if (body) {
      const bodyHash = crypto.createHash('sha256').update(body).digest('base64');
      hmac.update(bodyHash);
    }
    const signature = hmac.digest('base64');

    return {
      'X-YC-Timestamp': timestamp,
      Authorization: `YcHmacV1 ${this.#apiKey}:${signature}`,
    };
  }

  private async request(
    path: string,
    method: string,
    bodyObj?: Record<string, any>,
    isMutatingDisburse = false
  ): Promise<any> {
    const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const headers: Record<string, string> = {
      ...this.buildAuthHeaders(method, path, body),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };

    const res = await fetchWithTimeout(
      `${this.#baseUrl}${path}`,
      { method, headers, body },
      this.#timeoutMs,
      'YELLOW_CARD',
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok) {
      const status = res.status || 500;
      throw new PayoutProviderError({
        message:
          data?.message || data?.error || `Yellow Card request failed with status ${status}`,
        rail: 'YELLOW_CARD',
        statusCode: status,
        isAmbiguous: isMutatingDisburse && isHttpStatusAmbiguous(status),
      });
    }
    return data;
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (!params.bankDetails && !params.mobileMoneyDetails) {
      throw new Error(
        'Either bankDetails or mobileMoneyDetails is required for Yellow Card disbursements'
      );
    }

    const currency = params.currency.toUpperCase();
    const resolvedBank = params.bankDetails
      ? resolveProviderCode(params.bankDetails.bankCode, currency, 'YELLOW_CARD', false)
      : '';
    const destination = params.bankDetails
      ? {
          accountType: 'bank',
          accountNumber: params.bankDetails.accountNumber,
          accountName: params.bankDetails.accountName || params.bankDetails.accountNumber,
          accountBank: resolvedBank,
          networkId: params.metadata?.networkId || resolvedBank,
        }
      : {
          accountType: 'momo',
          accountNumber: normalizeMsisdn(params.mobileMoneyDetails!.phone, currency),
          networkId:
            params.metadata?.networkId ||
            resolveProviderCode(params.mobileMoneyDetails!.network, currency, 'YELLOW_CARD', true),
        };

    const payload: Record<string, any> = {
      sequenceId: params.reference,
      channelId: params.metadata?.channelId || `${currency}_PAYOUT`,
      localAmount: params.amount,
      currency,
      reason: params.narration || 'Marketplace disbursement',
      destination,
      forceAccept: true,
    };

    const data = await this.request('/business/payments', 'POST', payload, true);
    const status = normalizeYellowCardStatus(data.status);

    return {
      success: status !== 'FAILED',
      transactionId: String(data.id || params.reference),
      reference: String(data.sequenceId || params.reference),
      status,
      providerStatus: data.status,
      rail: 'YELLOW_CARD',
      amount: params.amount,
      currency,
      error:
        status === 'FAILED'
          ? data.failureReason || data.message || 'Yellow Card payout failed'
          : undefined,
      rawResponse: data,
    };
  }

  async getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult> {
    const path = reference
      ? `/business/payments/sequence-id/${validateSafeIdentifier(reference, 'reference')}`
      : `/business/payments/${validateSafeIdentifier(transactionId, 'transactionId')}`;

    const data = await this.request(path, 'GET');
    const status = normalizeYellowCardStatus(data.status);

    return {
      success: status !== 'FAILED',
      transactionId: String(data.id || transactionId),
      reference: String(data.sequenceId || reference || transactionId),
      status,
      providerStatus: data.status,
      rail: 'YELLOW_CARD',
      amount: Number(data.localAmount ?? data.amount ?? 0),
      currency: String(data.currency || '').toUpperCase(),
      error: status === 'FAILED' ? data.failureReason || 'Yellow Card payout failed' : undefined,
      rawResponse: data,
    };
  }

  async getBalances(): Promise<RailBalance[]> {
    const res = await this.request('/business/account', 'GET');
    const accounts = Array.isArray(res.accounts)
      ? res.accounts
      : Array.isArray(res.balances)
        ? res.balances
        : [res];
    return accounts
      .filter((row: any) => row && (row.currency || row.code))
      .map((row: any) => ({
        rail: 'YELLOW_CARD' as const,
        currency: String(row.currency || row.code || '').toUpperCase(),
        available: Number(row.availableBalance ?? row.balance ?? 0),
        pending: row.pendingBalance !== undefined ? Number(row.pendingBalance) : undefined,
      }));
  }

  async exportSettlements(params: SettlementExportParams): Promise<SettlementRecord[]> {
    const query = new URLSearchParams({
      startDate: params.from.toISOString(),
      endDate: params.to.toISOString(),
    });
    const res = await this.request(`/business/payments?${query.toString()}`, 'GET');
    const rows = Array.isArray(res.payments) ? res.payments : Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : [];
    return rows.map((row: any) => ({
      rail: 'YELLOW_CARD' as const,
      transactionId: String(row.id || ''),
      reference: String(row.sequenceId || row.reference || row.id || ''),
      status: normalizeYellowCardStatus(row.status),
      providerStatus: row.status,
      amount: Number(row.localAmount ?? row.amount ?? 0),
      currency: String(row.currency || '').toUpperCase(),
      fee: row.fee !== undefined ? Number(row.fee) : row.serviceFee !== undefined ? Number(row.serviceFee) : undefined,
      createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
    }));
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const secret = this.#webhookSecret || this.#secretKey;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

    if (!constantTimeStringEqual(signature, expected)) {
      throw new Error('Invalid Yellow Card webhook signature');
    }

    const payload = JSON.parse(rawBody);
    const status = normalizeYellowCardStatus(payload.status);

    return {
      rail: 'YELLOW_CARD',
      eventType: String(
        payload.event || `payment.${String(payload.status || 'updated').toLowerCase()}`
      ),
      transactionId: String(payload.id || ''),
      reference: String(payload.sequenceId || payload.reference || ''),
      status,
      providerStatus: payload.status,
      amount: Number(payload.localAmount ?? payload.amount ?? 0),
      currency: String(payload.currency || '').toUpperCase(),
      fee:
        payload.fee !== undefined
          ? Number(payload.fee)
          : payload.serviceFee !== undefined
            ? Number(payload.serviceFee)
            : undefined,
      error: status === 'FAILED' ? payload.failureReason || 'Yellow Card payout failed' : undefined,
      rawPayload: payload,
    };
  }
}
