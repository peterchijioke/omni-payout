import {
  BankResolutionResult,
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
  validateSafeIdentifier,
} from '../utils';

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
  readonly #secretKey: string;
  readonly #webhookSecret?: string;
  readonly #timeoutMs: number;

  constructor(secretKey: string, webhookSecret?: string, timeoutMs = 30_000) {
    if (!secretKey) throw new Error('Flutterwave secret key is required');
    this.#secretKey = secretKey;
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
  }

  private async request(
    endpoint: string,
    options: RequestInit = {},
    isMutatingDisburse = false
  ): Promise<any> {
    const url = `https://api.flutterwave.com/v3${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secretKey}`,
      ...(options.headers as Record<string, string>),
    };
    if (options.method && options.method.toUpperCase() !== 'GET' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetchWithTimeout(
      url,
      { ...options, headers },
      this.#timeoutMs,
      'FLUTTERWAVE',
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok || data.status === 'error') {
      const status = res.status || (res.ok ? 400 : 500);
      throw new PayoutProviderError({
        message: data?.message || `Flutterwave request failed with status ${status}`,
        rail: 'FLUTTERWAVE',
        statusCode: status,
        isAmbiguous: isMutatingDisburse && !res.ok && isHttpStatusAmbiguous(status),
      });
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

    const currency = params.currency.toUpperCase();
    if (params.bankDetails) {
      payload = {
        account_bank: resolveProviderCode(params.bankDetails.bankCode, currency, 'FLUTTERWAVE', false),
        account_number: params.bankDetails.accountNumber,
        amount: params.amount,
        currency,
        reference: params.reference,
        narration: params.narration || 'Marketplace disbursement',
        debit_currency: currency,
      };
    } else if (params.mobileMoneyDetails) {
      payload = {
        account_bank: resolveProviderCode(params.mobileMoneyDetails.network, currency, 'FLUTTERWAVE', true),
        account_number: normalizeMsisdn(params.mobileMoneyDetails.phone, currency),
        amount: params.amount,
        currency,
        reference: params.reference,
        narration: params.narration || 'Mobile Money payout',
      };
    } else {
      throw new Error(
        'Either bankDetails or mobileMoneyDetails must be provided for African disbursements'
      );
    }

    const res = await this.request(
      '/transfers',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true
    );

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
    const safeId = validateSafeIdentifier(transactionId, 'transactionId');
    const res = await this.request(`/transfers/${safeId}`, {
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
      pending:
        row.ledger_balance !== undefined
          ? Number(row.ledger_balance) - Number(row.available_balance || 0)
          : undefined,
    }));
  }

  async exportSettlements(params: SettlementExportParams): Promise<SettlementRecord[]> {
    const query = new URLSearchParams({
      from: params.from.toISOString().slice(0, 10),
      to: params.to.toISOString().slice(0, 10),
    });
    const res = await this.request(`/transfers?${query.toString()}`, { method: 'GET' });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row: any) => ({
      rail: 'FLUTTERWAVE' as const,
      transactionId: String(row.id || ''),
      reference: String(row.reference || row.id || ''),
      status: normalizeFlutterwaveStatus(row.status),
      providerStatus: row.status,
      amount: Number(row.amount || 0),
      currency: String(row.currency || '').toUpperCase(),
      fee: row.fee !== undefined ? Number(row.fee) : undefined,
      createdAt: row.created_at ? new Date(row.created_at) : undefined,
    }));
  }

  verifyWebhook(rawBody: string, verifHash: string): WebhookEvent {
    if (!this.#webhookSecret) {
      throw new Error('Flutterwave webhookSecret is required to verify webhooks');
    }
    if (!constantTimeStringEqual(verifHash, this.#webhookSecret)) {
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
      fee: data.fee !== undefined ? Number(data.fee) : undefined,
      error:
        status === 'FAILED' ? data.complete_message || 'Flutterwave transfer failed' : undefined,
      rawPayload: payload,
    };
  }
}
