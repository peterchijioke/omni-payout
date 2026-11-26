import crypto from 'crypto';
import {
  BankResolutionResult,
  DisburseParams,
  DisburseResult,
  PayoutStatus,
  RailBalance,
  WebhookEvent,
} from '../types';

function normalizeFlutterwaveStatus(rawStatus?: string): PayoutStatus {
  if (!rawStatus) return 'PENDING';
  switch (rawStatus.toUpperCase()) {
    case 'SUCCESSFUL':
    case 'SUCCESS':
      return 'SUCCESSFUL';
    case 'FAILED':
    case 'FAIL':
    case 'CANCELLED':
    case 'CANCELED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

export class FlutterwaveAdapter {
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret?: string
  ) {
    if (!secretKey) throw new Error('Flutterwave secret key is required');
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `https://api.flutterwave.com/v3${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok || data.status === 'error') {
      throw new Error(data?.message || `Flutterwave request failed with status ${res.status}`);
    }
    return data;
  }

  async resolveBankAccount(bankCode: string, accountNumber: string): Promise<BankResolutionResult> {
    const res = await this.request('/accounts/resolve', {
      method: 'POST',
      body: JSON.stringify({
        account_bank: bankCode,
        account_number: accountNumber,
      }),
    });

    return {
      accountName: res.data.account_name,
      accountNumber: res.data.account_number,
      bankCode,
    };
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    let payload: Record<string, any>;

    if (params.bankDetails) {
      payload = {
        account_bank: params.bankDetails.bankCode,
        account_number: params.bankDetails.accountNumber,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        reference: params.reference,
        narration: params.narration || 'Marketplace disbursement',
        debit_currency: params.currency.toUpperCase(),
      };
    } else if (params.mobileMoneyDetails) {
      payload = {
        account_bank: params.mobileMoneyDetails.network.toLowerCase(),
        account_number: params.mobileMoneyDetails.phone,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        reference: params.reference,
        narration: params.narration || 'Mobile Money payout',
      };
    } else {
      throw new Error('Either bankDetails or mobileMoneyDetails must be provided for African disbursements');
    }

    const res = await this.request('/transfers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const transferData = res.data || {};
    const status = normalizeFlutterwaveStatus(transferData.status);
    const isSuccess = res.status === 'success' && status !== 'FAILED';

    return {
      success: isSuccess,
      transactionId: String(transferData.id || params.reference),
      reference: transferData.reference || params.reference,
      status,
      providerStatus: transferData.status,
      rail: 'FLUTTERWAVE',
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      fee: transferData.fee ? Number(transferData.fee) : undefined,
      error: status === 'FAILED' ? transferData.complete_message || res.message : undefined,
      rawResponse: res,
    };
  }

  async getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult> {
    const res = await this.request(`/transfers/${transactionId}`, {
      method: 'GET',
    });

    const transferData = res.data || {};
    const status = normalizeFlutterwaveStatus(transferData.status);
    const isSuccess = res.status === 'success' && status !== 'FAILED';

    return {
      success: isSuccess,
      transactionId: String(transferData.id || transactionId),
      reference: transferData.reference || reference || transactionId,
      status,
      providerStatus: transferData.status,
      rail: 'FLUTTERWAVE',
      amount: transferData.amount ? Number(transferData.amount) : 0,
      currency: (transferData.currency || '').toUpperCase(),
      fee: transferData.fee ? Number(transferData.fee) : undefined,
      error: status === 'FAILED' ? transferData.complete_message || res.message : undefined,
      rawResponse: res,
    };
  }

  async getBalances(): Promise<RailBalance[]> {
    const res = await this.request('/balances', { method: 'GET' });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row: any) => ({
      rail: 'FLUTTERWAVE' as const,
      currency: String(row.currency || '').toUpperCase(),
      available: Number(row.available_balance || 0),
      pending: row.ledger_balance !== undefined ? Number(row.ledger_balance) - Number(row.available_balance || 0) : undefined,
    }));
  }

  verifyWebhook(rawBody: string, verifHash: string): WebhookEvent {
    if (!this.webhookSecret) {
      throw new Error('Flutterwave webhookSecret is required to verify webhooks');
    }

    const sigBuf = Buffer.from(verifHash || '', 'utf8');
    const expBuf = Buffer.from(this.webhookSecret, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('Invalid Flutterwave webhook signature');
    }

    const payload = JSON.parse(rawBody);
    const eventType = String(payload.event || '');
    const data = payload.data || {};
    const status = normalizeFlutterwaveStatus(data.status);

    return {
      rail: 'FLUTTERWAVE',
      eventType,
      transactionId: String(data.id || ''),
      reference: String(data.reference || ''),
      status,
      providerStatus: data.status,
      amount: data.amount ? Number(data.amount) : 0,
      currency: String(data.currency || '').toUpperCase(),
      error: status === 'FAILED' ? data.complete_message || 'Flutterwave transfer failed' : undefined,
      rawPayload: payload,
    };
  }
}
