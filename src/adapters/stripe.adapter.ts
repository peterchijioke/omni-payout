import { DisburseParams, DisburseResult, OnboardingLinkParams, OnboardingLinkResult } from '../types';

export class StripeConnectAdapter {
  constructor(private readonly secretKey: string) {
    if (!secretKey) throw new Error('Stripe secret key is required');
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `https://api.stripe.com/v1${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...options.headers,
    };

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

    // 1. Transfer funds from platform to connected account
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
      body: transferBody.toString(),
    });

    let transactionId = transfer.id;

    // 2. If instant payout requested, trigger an instant payout on the connected account
    if (params.speed === 'instant') {
      const payoutBody = new URLSearchParams({
        amount: String(amountInCents),
        currency: params.currency.toLowerCase(),
        method: 'instant',
      });

      const payout = await this.request('/payouts', {
        method: 'POST',
        headers: { 'Stripe-Account': params.stripeAccountId },
        body: payoutBody.toString(),
      });
      transactionId = payout.id;
    }

    return {
      success: true,
      transactionId,
      reference: params.reference,
      status: 'SUCCESSFUL',
      rail: 'STRIPE_CONNECT',
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      rawResponse: transfer,
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
}
