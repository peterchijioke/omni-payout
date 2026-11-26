import crypto from 'crypto';
import {
  BankResolutionResult,
  DisburseParams,
  DisburseResult,
  PayoutStatus,
  RailBalance,
  WebhookEvent,
} from '../types';

function normalizePaystackStatus(rawStatus?: string): PayoutStatus {
  if (!rawStatus) return 'PENDING';
  switch (rawStatus.toLowerCase()) {
    case 'success':
    case 'successful':
      return 'SUCCESSFUL';
    case 'failed':
    case 'reversed':
    case 'abandoned':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

export class PaystackAdapter {
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret?: string
  ) {
    if (!secretKey) throw new Error('Paystack secret key is required');
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `https://api.paystack.co${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      ...(options.headers as Record<string, string>),
    };
    if (options.method && options.method.toUpperCase() !== 'GET' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok || data?.status === false) {
      throw new Error(data?.message || `Paystack request failed with status ${res.status}`);
    }
    return data;
  }

  async resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult> {
    const query = new URLSearchParams({
      account_number: accountNumber,
      bank_code: bankCode,
    });
    const res = await this.request(`/bank/resolve?${query.toString()}`, {
      method: 'GET',
    });

    return {
      accountName: res.data?.account_name || '',
      accountNumber: res.data?.account_number || accountNumber,
      bankCode,
    };
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (!params.bankDetails && !params.mobileMoneyDetails) {
      throw new Error('Either bankDetails or mobileMoneyDetails must be provided for Paystack disbursements');
    }

    const currency = params.currency.toUpperCase();
    const amountInSubunit = Math.round(params.amount * 100);

    // 1. Create or retrieve transfer recipient
    const recipientPayload: Record<string, any> = params.bankDetails
      ? {
          type: currency === 'GHS' ? 'ghipss' : currency === 'ZAR' ? 'basa' : 'nuban',
          name: params.bankDetails.accountName || params.bankDetails.accountNumber,
          account_number: params.bankDetails.accountNumber,
          bank_code: params.bankDetails.bankCode,
          currency,
        }
      : {
          type: 'mobile_money',
          name: params.mobileMoneyDetails!.phone,
          account_number: params.mobileMoneyDetails!.phone,
          bank_code: params.mobileMoneyDetails!.network.toUpperCase(),
          currency,
        };

    const recipientRes = await this.request('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify(recipientPayload),
    });

    const recipientCode = recipientRes.data?.recipient_code;
    if (!recipientCode) {
      throw new Error('Paystack failed to return a transfer recipient_code');
    }

    // 2. Initiate transfer (Paystack enforces idempotency on `reference`)
    const transferRes = await this.request('/transfer', {
      method: 'POST',
      body: JSON.stringify({
        source: 'balance',
        amount: amountInSubunit,
        recipient: recipientCode,
        currency,
        reference: params.reference,
        reason: params.narration || 'Marketplace disbursement',
      }),
    });

    const transferData = transferRes.data || {};
    const status = normalizePaystackStatus(transferData.status);

    return {
      success: status !== 'FAILED',
      transactionId: String(transferData.transfer_code || transferData.id || params.reference),
      reference: transferData.reference || params.reference,
      status,
      providerStatus: transferData.status,
      rail: 'PAYSTACK',
      amount: params.amount,
      currency,
      error: status === 'FAILED' ? transferData.failures || transferRes.message : undefined,
      rawResponse: transferRes,
    };
  }

  async getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult> {
    const endpoint = reference
      ? `/transfer/verify/${encodeURIComponent(reference)}`
      : `/transfer/${encodeURIComponent(transactionId)}`;

    const res = await this.request(endpoint, { method: 'GET' });
    const transferData = res.data || {};
    const status = normalizePaystackStatus(transferData.status);

    return {
      success: status !== 'FAILED',
      transactionId: String(transferData.transfer_code || transferData.id || transactionId),
      reference: transferData.reference || reference || transactionId,
      status,
      providerStatus: transferData.status,
      rail: 'PAYSTACK',
      amount: typeof transferData.amount === 'number' ? transferData.amount / 100 : 0,
      currency: (transferData.currency || '').toUpperCase(),
      error: status === 'FAILED' ? transferData.failures || res.message : undefined,
      rawResponse: res,
    };
  }

  async getBalances(): Promise<RailBalance[]> {
    const res = await this.request('/balance', { method: 'GET' });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row: any) => ({
      rail: 'PAYSTACK' as const,
      currency: String(row.currency || '').toUpperCase(),
      available: typeof row.balance === 'number' ? row.balance / 100 : 0,
    }));
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const secret = this.webhookSecret || this.secretKey;
    const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

    const sigBuf = Buffer.from(signature || '', 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('Invalid Paystack webhook signature');
    }

    const payload = JSON.parse(rawBody);
    const eventType = String(payload.event || '');
    const data = payload.data || {};
    const rawStatus =
      data.status ||
      (eventType === 'transfer.success'
        ? 'success'
        : eventType === 'transfer.failed' || eventType === 'transfer.reversed'
          ? 'failed'
          : 'pending');
    const status = normalizePaystackStatus(rawStatus);

    return {
      rail: 'PAYSTACK',
      eventType,
      transactionId: String(data.transfer_code || data.id || ''),
      reference: String(data.reference || ''),
      status,
      providerStatus: rawStatus,
      amount: typeof data.amount === 'number' ? data.amount / 100 : 0,
      currency: String(data.currency || '').toUpperCase(),
      error: status === 'FAILED' ? data.reason || data.failures || 'Paystack transfer failed' : undefined,
      rawPayload: payload,
    };
  }
}
