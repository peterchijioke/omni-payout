import crypto from 'crypto';
import { DisburseParams, DisburseResult, PayoutStatus, RailBalance, WebhookEvent } from '../types';

function normalizePawaPayStatus(rawStatus?: string): PayoutStatus {
  if (!rawStatus) return 'PENDING';
  switch (rawStatus.toUpperCase()) {
    case 'COMPLETED':
    case 'SUCCESSFUL':
      return 'SUCCESSFUL';
    case 'FAILED':
    case 'REJECTED':
    case 'CANCELLED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

function resolvePawaPayCorrespondent(network: string, currency: string): string {
  const key = `${network.toUpperCase()}_${currency.toUpperCase()}`;
  const map: Record<string, string> = {
    MPESA_KES: 'MPESA_KEN',
    MTN_GHS: 'MTN_MOMO_GHA',
    VODAFONE_GHS: 'VODAFONE_GHA',
    AIRTEL_GHS: 'AIRTELTIGO_GHA',
    MTN_UGX: 'MTN_MOMO_UGA',
    AIRTEL_UGX: 'AIRTEL_OAPI_UGA',
    MTN_RWF: 'MTN_MOMO_RWA',
    AIRTEL_RWF: 'AIRTEL_OAPI_RWA',
    AIRTEL_TZS: 'AIRTEL_TZA',
    ORANGE_XOF: 'ORANGE_CIV',
    MTN_XOF: 'MTN_MOMO_CIV',
    WAVE_XOF: 'WAVE_SEN',
  };
  return map[key] || `${network.toUpperCase()}_${currency.toUpperCase()}`;
}

export class PawaPayAdapter {
  private readonly baseUrl: string;

  constructor(
    private readonly apiToken: string,
    baseUrl?: string,
    private readonly webhookSecret?: string
  ) {
    if (!apiToken) throw new Error('PawaPay apiToken is required');
    this.baseUrl = (baseUrl || 'https://api.pawapay.io').replace(/\/$/, '');
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      ...(options.headers as Record<string, string>),
    };
    if (options.method && options.method.toUpperCase() !== 'GET' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        data?.failureReason?.failureMessage ||
          data?.message ||
          `PawaPay request failed with status ${res.status}`
      );
    }
    return data;
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (!params.mobileMoneyDetails) {
      throw new Error('mobileMoneyDetails is required for PawaPay disbursements');
    }

    const currency = params.currency.toUpperCase();
    const correspondent =
      params.metadata?.correspondent ||
      resolvePawaPayCorrespondent(params.mobileMoneyDetails.network, currency);

    const payload = {
      payoutId: params.reference,
      amount: String(params.amount),
      currency,
      correspondent,
      recipient: {
        type: 'MSISDN',
        address: {
          value: params.mobileMoneyDetails.phone,
        },
      },
      customerTimestamp: new Date().toISOString(),
      statementDescription: (params.narration || 'Marketplace payout').slice(0, 22),
    };

    const data = await this.request('/payouts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const rawStatus = data.status || 'ACCEPTED';
    const status = normalizePawaPayStatus(rawStatus);
    const errMsg = data.rejectionReason?.rejectionMessage || data.failureReason?.failureMessage;

    return {
      success: status !== 'FAILED',
      transactionId: String(data.payoutId || params.reference),
      reference: String(data.payoutId || params.reference),
      status,
      providerStatus: rawStatus,
      rail: 'PAWAPAY',
      amount: params.amount,
      currency,
      error: status === 'FAILED' ? errMsg || 'PawaPay payout rejected' : undefined,
      rawResponse: data,
    };
  }

  async getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult> {
    const id = reference || transactionId;
    const raw = await this.request(`/payouts/${encodeURIComponent(id)}`, { method: 'GET' });
    const data = Array.isArray(raw) ? raw[0] || {} : raw.data || raw;
    const status = normalizePawaPayStatus(data.status);

    return {
      success: status !== 'FAILED',
      transactionId: String(data.payoutId || transactionId),
      reference: String(data.payoutId || reference || transactionId),
      status,
      providerStatus: data.status,
      rail: 'PAWAPAY',
      amount: data.amount ? Number(data.amount) : 0,
      currency: String(data.currency || '').toUpperCase(),
      error: status === 'FAILED' ? data.failureReason?.failureMessage || 'PawaPay payout failed' : undefined,
      rawResponse: raw,
    };
  }

  async getBalances(): Promise<RailBalance[]> {
    const res = await this.request('/wallets/balances', { method: 'GET' });
    const rows = Array.isArray(res.balances) ? res.balances : Array.isArray(res) ? res : [];
    return rows.map((row: any) => ({
      rail: 'PAWAPAY' as const,
      currency: String(row.currency || '').toUpperCase(),
      available: Number(row.balance ?? row.availableBalance ?? 0),
    }));
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    if (this.webhookSecret) {
      const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
      const sigBuf = Buffer.from(signature || '', 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        throw new Error('Invalid PawaPay webhook signature');
      }
    }

    const payload = JSON.parse(rawBody);
    const status = normalizePawaPayStatus(payload.status);

    return {
      rail: 'PAWAPAY',
      eventType: `payout.${String(payload.status || 'updated').toLowerCase()}`,
      transactionId: String(payload.payoutId || ''),
      reference: String(payload.payoutId || ''),
      status,
      providerStatus: payload.status,
      amount: payload.amount ? Number(payload.amount) : 0,
      currency: String(payload.currency || '').toUpperCase(),
      error: status === 'FAILED' ? payload.failureReason?.failureMessage || 'PawaPay payout failed' : undefined,
      rawPayload: payload,
    };
  }
}
