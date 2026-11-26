import crypto from 'crypto';
import { DisburseParams, DisburseResult, PayoutStatus, RailBalance, WebhookEvent } from '../types';

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
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly secretKey: string,
    baseUrl?: string,
    private readonly webhookSecret?: string
  ) {
    if (!apiKey || !secretKey) {
      throw new Error('Yellow Card apiKey and secretKey are required');
    }
    this.baseUrl = (baseUrl || 'https://api.yellowcard.io').replace(/\/$/, '');
  }

  private buildAuthHeaders(method: string, path: string, body?: string): Record<string, string> {
    const timestamp = new Date().toISOString();
    const upperMethod = method.toUpperCase();
    const hmac = crypto.createHmac('sha256', this.secretKey);
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
      Authorization: `YcHmacV1 ${this.apiKey}:${signature}`,
    };
  }

  private async request(path: string, method: string, bodyObj?: Record<string, any>): Promise<any> {
    const body = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const headers: Record<string, string> = {
      ...this.buildAuthHeaders(method, path, body),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    };

    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.message || data?.error || `Yellow Card request failed with status ${res.status}`);
    }
    return data;
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (!params.bankDetails && !params.mobileMoneyDetails) {
      throw new Error('Either bankDetails or mobileMoneyDetails is required for Yellow Card disbursements');
    }

    const currency = params.currency.toUpperCase();
    const destination = params.bankDetails
      ? {
          accountType: 'bank',
          accountNumber: params.bankDetails.accountNumber,
          accountName: params.bankDetails.accountName || params.bankDetails.accountNumber,
          accountBank: params.bankDetails.bankCode,
          networkId: params.metadata?.networkId || params.bankDetails.bankCode,
        }
      : {
          accountType: 'momo',
          accountNumber: params.mobileMoneyDetails!.phone,
          networkId: params.metadata?.networkId || params.mobileMoneyDetails!.network,
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

    const data = await this.request('/business/payments', 'POST', payload);
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
      error: status === 'FAILED' ? data.failureReason || data.message || 'Yellow Card payout failed' : undefined,
      rawResponse: data,
    };
  }

  async getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult> {
    const path = reference
      ? `/business/payments/sequence-id/${encodeURIComponent(reference)}`
      : `/business/payments/${encodeURIComponent(transactionId)}`;

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

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const secret = this.webhookSecret || this.secretKey;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

    const sigBuf = Buffer.from(signature || '', 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('Invalid Yellow Card webhook signature');
    }

    const payload = JSON.parse(rawBody);
    const status = normalizeYellowCardStatus(payload.status);

    return {
      rail: 'YELLOW_CARD',
      eventType: String(payload.event || `payment.${String(payload.status || 'updated').toLowerCase()}`),
      transactionId: String(payload.id || ''),
      reference: String(payload.sequenceId || payload.reference || ''),
      status,
      providerStatus: payload.status,
      amount: Number(payload.localAmount ?? payload.amount ?? 0),
      currency: String(payload.currency || '').toUpperCase(),
      error: status === 'FAILED' ? payload.failureReason || 'Yellow Card payout failed' : undefined,
      rawPayload: payload,
    };
  }
}
