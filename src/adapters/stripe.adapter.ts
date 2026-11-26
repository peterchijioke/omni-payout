import crypto from 'crypto';
import {
  DisburseParams,
  DisburseResult,
  OnboardingLinkParams,
  OnboardingLinkResult,
  PayoutStatus,
  RailBalance,
  WebhookEvent,
} from '../types';

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
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret?: string
  ) {
    if (!secretKey) throw new Error('Stripe secret key is required');
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `https://api.stripe.com/v1${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      ...(options.headers as Record<string, string>),
    };
    if (options.method && options.method.toUpperCase() !== 'GET' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Stripe request failed with status ${res.status}`);
    }
    return data;
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (!params.stripeAccountId) {
      throw new Error('stripeAccountId is required for Stripe Connect disbursements');
    }

    // Convert decimal amount to cents/smallest currency unit
    const amountInCents = Math.round(params.amount * 100);

    // 1. Transfer funds from platform to connected account (idempotent per reference)
    const transferBody = new URLSearchParams({
      amount: String(amountInCents),
      currency: params.currency.toLowerCase(),
      destination: params.stripeAccountId,
      'metadata[reference]': params.reference,
    });
    if (params.narration) {
      transferBody.set('description', params.narration);
    }

    const transfer = await this.request('/transfers', {
      method: 'POST',
      headers: {
        'Idempotency-Key': `${params.reference}:transfer`,
      },
      body: transferBody.toString(),
    });

    let transactionId = transfer.id;
    let providerStatus: string | undefined = transfer.status;
    let status: PayoutStatus = normalizeStripeStatus(transfer.status, 'SUCCESSFUL');
    let failureMessage: string | undefined;
    let rawResponse: any = transfer;

    // 2. If instant payout requested, trigger an instant payout on the connected account
    if (params.speed === 'instant') {
      const payoutBody = new URLSearchParams({
        amount: String(amountInCents),
        currency: params.currency.toLowerCase(),
        method: 'instant',
        'metadata[reference]': params.reference,
      });

      const payout = await this.request('/payouts', {
        method: 'POST',
        headers: {
          'Stripe-Account': params.stripeAccountId,
          'Idempotency-Key': `${params.reference}:payout`,
        },
        body: payoutBody.toString(),
      });
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
      currency: params.currency.toUpperCase(),
      error: status === 'FAILED' ? failureMessage || 'Stripe payout failed' : undefined,
      rawResponse,
    };
  }

  async getPayoutStatus(
    transactionId: string,
    stripeAccountId?: string,
    reference?: string
  ): Promise<DisburseResult> {
    const isPayout = transactionId.startsWith('po_');
    const endpoint = isPayout ? `/payouts/${transactionId}` : `/transfers/${transactionId}`;
    const headers: Record<string, string> = {};
    if (isPayout && stripeAccountId) {
      headers['Stripe-Account'] = stripeAccountId;
    }

    const data = await this.request(endpoint, { method: 'GET', headers });
    const status = normalizeStripeStatus(data.status, isPayout ? 'PENDING' : 'SUCCESSFUL');

    return {
      success: status !== 'FAILED',
      transactionId: data.id || transactionId,
      reference: data.metadata?.reference || reference || transactionId,
      status,
      providerStatus: data.status,
      rail: 'STRIPE_CONNECT',
      amount: typeof data.amount === 'number' ? data.amount / 100 : 0,
      currency: (data.currency || '').toUpperCase(),
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
        available: typeof entry.amount === 'number' ? entry.amount / 100 : 0,
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
      existing.pending = typeof entry.amount === 'number' ? entry.amount / 100 : 0;
      byCurrency.set(currency, existing);
    }

    return Array.from(byCurrency.values());
  }

  verifyWebhook(rawBody: string, signatureHeader: string): WebhookEvent {
    if (!this.webhookSecret) {
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

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(signedPayload)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
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

    return {
      rail: 'STRIPE_CONNECT',
      eventType,
      transactionId: String(obj.id || ''),
      reference: String(obj.metadata?.reference || obj.id || ''),
      status,
      providerStatus: obj.status,
      amount: typeof obj.amount === 'number' ? obj.amount / 100 : 0,
      currency: String(obj.currency || '').toUpperCase(),
      error: status === 'FAILED' ? obj.failure_message || 'Stripe payout failed' : undefined,
      rawPayload: payload,
    };
  }
}
