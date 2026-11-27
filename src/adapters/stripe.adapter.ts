import crypto from 'crypto';
import {
  DisburseParams,
  DisburseResult,
  OnboardingLinkParams,
  OnboardingLinkResult,
  PayoutStatus,
  RailBalance,
  SettlementExportParams,
  SettlementRecord,
  WebhookEvent,
} from '../types';
import {
  PayoutProviderError,
  constantTimeHexEqual,
  fetchWithTimeout,
  fromMinorUnits,
  isHttpStatusAmbiguous,
  toMinorUnits,
  validateSafeIdentifier,
} from '../utils';

function normalizeStripeStatus(
  rawStatus: string | undefined,
  defaultStatus: PayoutStatus
): PayoutStatus {
  if (!rawStatus) return defaultStatus;
  switch (rawStatus.toLowerCase()) {
    case 'paid':
    case 'succeeded':
    case 'successful':
      return 'SUCCESSFUL';
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

export class StripeConnectAdapter {
  readonly #secretKey: string;
  readonly #webhookSecret?: string;
  readonly #webhookToleranceSec: number;
  readonly #timeoutMs: number;

  constructor(
    secretKey: string,
    webhookSecret?: string,
    timeoutMs = 30_000,
    webhookToleranceSec = 300
  ) {
    if (!secretKey) throw new Error('Stripe secret key is required');
    this.#secretKey = secretKey;
    this.#webhookSecret = webhookSecret;
    this.#timeoutMs = timeoutMs;
    this.#webhookToleranceSec = webhookToleranceSec > 0 ? webhookToleranceSec : 300;
  }

  private async request(
    endpoint: string,
    options: RequestInit = {},
    isMutatingDisburse = false
  ): Promise<any> {
    const url = `https://api.stripe.com/v1${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secretKey}`,
      ...(options.headers as Record<string, string>),
    };
    if (options.method && options.method.toUpperCase() !== 'GET' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await fetchWithTimeout(
      url,
      { ...options, headers },
      this.#timeoutMs,
      'STRIPE_CONNECT',
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok) {
      const status = res.status || 500;
      throw new PayoutProviderError({
        message: data?.error?.message || `Stripe request failed with status ${status}`,
        rail: 'STRIPE_CONNECT',
        statusCode: status,
        isAmbiguous: isMutatingDisburse && isHttpStatusAmbiguous(status),
      });
    }
    return data;
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (!params.stripeAccountId) {
      throw new Error('stripeAccountId is required for Stripe Connect disbursements');
    }

    const currency = params.currency.toUpperCase();
    const amountInMinor = toMinorUnits(params.amount, currency);

    // 1. Transfer funds from platform to connected account (idempotent per reference)
    const transferBody = new URLSearchParams({
      amount: String(amountInMinor),
      currency: currency.toLowerCase(),
      destination: params.stripeAccountId,
      'metadata[reference]': params.reference,
    });
    if (params.narration) {
      transferBody.set('description', params.narration);
    }

    const transfer = await this.request(
      '/transfers',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': `${params.reference}:transfer`,
        },
        body: transferBody.toString(),
      },
      true
    );

    let transactionId = transfer.id;
    let providerStatus: string | undefined = transfer.status;
    let status: PayoutStatus = normalizeStripeStatus(transfer.status, 'SUCCESSFUL');
    let failureMessage: string | undefined;
    let rawResponse: any = transfer;

    // 2. If instant payout requested, trigger an instant payout on the connected account
    if (params.speed === 'instant') {
      const payoutBody = new URLSearchParams({
        amount: String(amountInMinor),
        currency: currency.toLowerCase(),
        method: 'instant',
        'metadata[reference]': params.reference,
      });

      const payout = await this.request(
        '/payouts',
        {
          method: 'POST',
          headers: {
            'Stripe-Account': params.stripeAccountId,
            'Idempotency-Key': `${params.reference}:payout`,
          },
          body: payoutBody.toString(),
        },
        true
      );
      transactionId = payout.id;
      providerStatus = payout.status;
      status = normalizeStripeStatus(payout.status, 'PENDING');
      failureMessage = payout.failure_message || undefined;
      rawResponse = payout;
    }

    return {
      success: status !== 'FAILED',
      transactionId,
      reference: params.reference,
      status,
      providerStatus,
      rail: 'STRIPE_CONNECT',
      amount: params.amount,
      currency,
      error: status === 'FAILED' ? failureMessage || 'Stripe payout failed' : undefined,
      rawResponse,
    };
  }

  async getPayoutStatus(
    transactionId: string,
    stripeAccountId?: string,
    reference?: string
  ): Promise<DisburseResult> {
    const safeId = validateSafeIdentifier(transactionId, 'transactionId');
    const isPayout = transactionId.trim().startsWith('po_');
    const endpoint = isPayout ? `/payouts/${safeId}` : `/transfers/${safeId}`;
    const headers: Record<string, string> = {};
    if (isPayout && stripeAccountId) {
      headers['Stripe-Account'] = stripeAccountId;
    }

    const data = await this.request(endpoint, { method: 'GET', headers });
    const status = normalizeStripeStatus(data.status, isPayout ? 'PENDING' : 'SUCCESSFUL');
    const currency = String(data.currency || 'USD').toUpperCase();

    return {
      success: status !== 'FAILED',
      transactionId: data.id || transactionId,
      reference: data.metadata?.reference || reference || transactionId,
      status,
      providerStatus: data.status,
      rail: 'STRIPE_CONNECT',
      amount: typeof data.amount === 'number' ? fromMinorUnits(data.amount, currency) : 0,
      currency,
      error: status === 'FAILED' ? data.failure_message || 'Stripe payout failed' : undefined,
      rawResponse: data,
    };
  }

  async createOnboardingLink(params: OnboardingLinkParams): Promise<OnboardingLinkResult> {
    const body = new URLSearchParams({
      account: params.accountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: params.type || 'account_onboarding',
    });

    const data = await this.request('/account_links', {
      method: 'POST',
      body: body.toString(),
    });

    return {
      url: data.url,
      expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : undefined,
    };
  }

  async getBalances(): Promise<RailBalance[]> {
    const data = await this.request('/balance', { method: 'GET' });
    const byCurrency = new Map<string, RailBalance>();

    for (const entry of data.available || []) {
      const currency = String(entry.currency || '').toUpperCase();
      byCurrency.set(currency, {
        rail: 'STRIPE_CONNECT',
        currency,
        available: typeof entry.amount === 'number' ? fromMinorUnits(entry.amount, currency) : 0,
        pending: 0,
      });
    }
    for (const entry of data.pending || []) {
      const currency = String(entry.currency || '').toUpperCase();
      const existing = byCurrency.get(currency) || {
        rail: 'STRIPE_CONNECT' as const,
        currency,
        available: 0,
        pending: 0,
      };
      existing.pending =
        typeof entry.amount === 'number' ? fromMinorUnits(entry.amount, currency) : 0;
      byCurrency.set(currency, existing);
    }

    return Array.from(byCurrency.values());
  }

  async exportSettlements(params: SettlementExportParams): Promise<SettlementRecord[]> {
    const query = new URLSearchParams({
      'created[gte]': String(Math.floor(params.from.getTime() / 1000)),
      'created[lte]': String(Math.floor(params.to.getTime() / 1000)),
      limit: String(Math.min(Math.max(params.limit ?? 100, 1), 100)),
    });
    const isPayouts = Boolean(params.stripeAccountId);
    const endpoint = isPayouts ? `/payouts?${query.toString()}` : `/transfers?${query.toString()}`;
    const headers: Record<string, string> = isPayouts
      ? { 'Stripe-Account': params.stripeAccountId! }
      : {};

    const res = await this.request(endpoint, { method: 'GET', headers });
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows.map((row: any) => {
      const currency = String(row.currency || 'USD').toUpperCase();
      return {
        rail: 'STRIPE_CONNECT' as const,
        transactionId: String(row.id || ''),
        reference: String(row.metadata?.reference || row.id || ''),
        status: normalizeStripeStatus(row.status, isPayouts ? 'PENDING' : 'SUCCESSFUL'),
        providerStatus: row.status,
        amount: typeof row.amount === 'number' ? fromMinorUnits(row.amount, currency) : 0,
        currency,
        fee: typeof row.fee === 'number' ? fromMinorUnits(row.fee, currency) : undefined,
        createdAt: typeof row.created === 'number' ? new Date(row.created * 1000) : undefined,
      };
    });
  }

  verifyWebhook(rawBody: string, signatureHeader: string): WebhookEvent {
    if (!this.#webhookSecret) {
      throw new Error('Stripe webhookSecret is required to verify webhooks');
    }

    const parts = Object.fromEntries(
      (signatureHeader || '')
        .split(',')
        .map((part) => part.trim().split('='))
        .filter((pair) => pair.length === 2)
    );
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) {
      throw new Error('Invalid Stripe-Signature header format');
    }

    const tsNum = Number(timestamp);
    if (!Number.isInteger(tsNum) || tsNum <= 0) {
      throw new Error('Invalid Stripe webhook timestamp');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > this.#webhookToleranceSec) {
      throw new Error('Stripe webhook timestamp outside tolerance window (possible replay attack)');
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = crypto
      .createHmac('sha256', this.#webhookSecret)
      .update(signedPayload)
      .digest('hex');

    if (!constantTimeHexEqual(signature, expected)) {
      throw new Error('Invalid Stripe webhook signature');
    }

    const payload = JSON.parse(rawBody);
    const eventType = String(payload.type || '');
    const obj = payload.data?.object || {};
    const defaultStatus: PayoutStatus =
      eventType === 'payout.paid'
        ? 'SUCCESSFUL'
        : eventType === 'payout.failed' || eventType === 'payout.canceled'
          ? 'FAILED'
          : 'PENDING';
    const status = normalizeStripeStatus(obj.status, defaultStatus);
    const currency = String(obj.currency || 'USD').toUpperCase();

    return {
      rail: 'STRIPE_CONNECT',
      eventType,
      transactionId: String(obj.id || ''),
      reference: String(obj.metadata?.reference || obj.id || ''),
      status,
      providerStatus: obj.status,
      amount: typeof obj.amount === 'number' ? fromMinorUnits(obj.amount, currency) : 0,
      currency,
      fee: typeof obj.fee === 'number' ? fromMinorUnits(obj.fee, currency) : undefined,
      error: status === 'FAILED' ? obj.failure_message || 'Stripe payout failed' : undefined,
      rawPayload: payload,
    };
  }
}
