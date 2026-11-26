import crypto from 'crypto';
import {
  BankResolutionResult,
  DisburseParams,
  DisburseResult,
  PayoutStatus,
  RailBalance,
  WebhookEvent,
} from '../types';
import {
  PayoutProviderError,
  constantTimeHexEqual,
  fetchWithTimeout,
  fromMinorUnits,
  isHttpStatusAmbiguous,
  normalizeMsisdn,
  resolveProviderCode,
  toMinorUnits,
  validateSafeIdentifier,
} from '../utils';

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
  readonly #secretKey: string;
  readonly #webhookSecret?: string;
  readonly #timeoutMs: number;

  constructor(secretKey: string, webhookSecret?: string, timeoutMs = 30_000) {
    if (!secretKey) throw new Error('Paystack secret key is required');
    this.#secretKey = secretKey;
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
  }

  private async request(
    endpoint: string,
    options: RequestInit = {},
    isMutatingDisburse = false
  ): Promise<any> {
    const url = `https://api.paystack.co${endpoint}`;
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
      'PAYSTACK',
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok || data?.status === false) {
      const status = res.status || (res.ok ? 400 : 500);
      throw new PayoutProviderError({
        message: data?.message || `Paystack request failed with status ${status}`,
        rail: 'PAYSTACK',
        statusCode: status,
        isAmbiguous: isMutatingDisburse && !res.ok && isHttpStatusAmbiguous(status),
      });
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
      throw new Error(
        'Either bankDetails or mobileMoneyDetails must be provided for Paystack disbursements'
      );
    }

    const currency = params.currency.toUpperCase();
    const amountInSubunit = toMinorUnits(params.amount, currency);

    // 1. Create or retrieve transfer recipient (pre-execution, not fund-moving)
    const recipientPayload: Record<string, any> = params.bankDetails
      ? {
          type: currency === 'GHS' ? 'ghipss' : currency === 'ZAR' ? 'basa' : 'nuban',
          name: params.bankDetails.accountName || params.bankDetails.accountNumber,
          account_number: params.bankDetails.accountNumber,
          bank_code: resolveProviderCode(params.bankDetails.bankCode, currency, 'PAYSTACK', false),
          currency,
        }
      : {
          type: 'mobile_money',
          name: normalizeMsisdn(params.mobileMoneyDetails!.phone, currency),
          account_number: normalizeMsisdn(params.mobileMoneyDetails!.phone, currency),
          bank_code: resolveProviderCode(params.mobileMoneyDetails!.network, currency, 'PAYSTACK', true),
          currency,
        };

    const recipientRes = await this.request(
      '/transferrecipient',
      {
        method: 'POST',
        body: JSON.stringify(recipientPayload),
      },
      false
    );

    const recipientCode = recipientRes.data?.recipient_code;
    if (!recipientCode) {
      throw new Error('Paystack failed to return a transfer recipient_code');
    }

    // 2. Initiate transfer (Paystack enforces idempotency on `reference`)
    const transferRes = await this.request(
      '/transfer',
      {
        method: 'POST',
        body: JSON.stringify({
          source: 'balance',
          amount: amountInSubunit,
          recipient: recipientCode,
          currency,
          reference: params.reference,
          reason: params.narration || 'Marketplace disbursement',
        }),
      },
      true
    );

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
      ? `/transfer/verify/${validateSafeIdentifier(reference, 'reference')}`
      : `/transfer/${validateSafeIdentifier(transactionId, 'transactionId')}`;

    const res = await this.request(endpoint, { method: 'GET' });
    const transferData = res.data || {};
    const status = normalizePaystackStatus(transferData.status);
    const currency = String(transferData.currency || 'NGN').toUpperCase();

    return {
      success: status !== 'FAILED',
      transactionId: String(transferData.transfer_code || transferData.id || transactionId),
      reference: transferData.reference || reference || transactionId,
      status,
      providerStatus: transferData.status,
      rail: 'PAYSTACK',
      amount:
        typeof transferData.amount === 'number'
          ? fromMinorUnits(transferData.amount, currency)
          : 0,
      currency,
      fee:
        typeof transferData.fee === 'number'
          ? fromMinorUnits(transferData.fee, currency)
          : undefined,
      error: status === 'FAILED' ? transferData.failures || res.message : undefined,
      rawResponse: res,
    };
  }

  async getBalances(): Promise<RailBalance[]> {
    const res = await this.request('/balance', { method: 'GET' });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row: any) => {
      const currency = String(row.currency || 'NGN').toUpperCase();
      return {
        rail: 'PAYSTACK' as const,
        currency,
        available: typeof row.balance === 'number' ? fromMinorUnits(row.balance, currency) : 0,
      };
    });
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const secret = this.#webhookSecret || this.#secretKey;
    const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

    if (!constantTimeHexEqual(signature, expected)) {
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
    const currency = String(data.currency || 'NGN').toUpperCase();

    return {
      rail: 'PAYSTACK',
      eventType,
      transactionId: String(data.transfer_code || data.id || ''),
      reference: String(data.reference || ''),
      status,
      providerStatus: rawStatus,
      amount: typeof data.amount === 'number' ? fromMinorUnits(data.amount, currency) : 0,
      currency,
      fee: typeof data.fee === 'number' ? fromMinorUnits(data.fee, currency) : undefined,
      error:
        status === 'FAILED' ? data.reason || data.failures || 'Paystack transfer failed' : undefined,
      rawPayload: payload,
    };
  }
}
