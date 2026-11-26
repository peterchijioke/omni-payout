import { DisburseParams, DisburseResult, PayoutStatus, RailBalance, WebhookEvent } from '../types';
import {
  PayoutProviderError,
  constantTimeStringEqual,
  fetchWithTimeout,
  isHttpStatusAmbiguous,
  sanitizeBaseUrl,
} from '../utils';

export interface MpesaDarajaConfig {
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  initiatorName: string;
  securityCredential: string;
  resultUrl: string;
  queueTimeoutUrl: string;
  baseUrl?: string;
  webhookSecret?: string;
}

export class MpesaDarajaAdapter {
  readonly #config: MpesaDarajaConfig;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  #cachedToken?: string;
  #tokenExpiresAt = 0;

  constructor(config: MpesaDarajaConfig, timeoutMs = 30_000) {
    if (!config.consumerKey || !config.consumerSecret) {
      throw new Error('M-Pesa Daraja consumerKey and consumerSecret are required');
    }
    this.#config = { ...config };
    this.#baseUrl = sanitizeBaseUrl(config.baseUrl, 'https://api.safaricom.co.ke');
    this.#timeoutMs = timeoutMs;
  }

  private async getAccessToken(): Promise<string> {
    if (this.#cachedToken && Date.now() < this.#tokenExpiresAt) {
      return this.#cachedToken;
    }

    const basic = Buffer.from(
      `${this.#config.consumerKey}:${this.#config.consumerSecret}`
    ).toString('base64');
    const res = await fetchWithTimeout(
      `${this.#baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: 'GET',
        headers: { Authorization: `Basic ${basic}` },
      },
      this.#timeoutMs,
      'MPESA_DARAJA',
      false
    );
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      throw new PayoutProviderError({
        message: data?.errorMessage || `M-Pesa OAuth failed with status ${res.status}`,
        rail: 'MPESA_DARAJA',
        statusCode: res.status || 401,
        isAmbiguous: false,
      });
    }

    this.#cachedToken = data.access_token;
    const expiresInSec = Number(data.expires_in || 3500);
    this.#tokenExpiresAt = Date.now() + Math.max(expiresInSec - 60, 60) * 1000;
    return data.access_token;
  }

  private async request(
    path: string,
    body: Record<string, any>,
    isMutatingDisburse = false
  ): Promise<any> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(
      `${this.#baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      this.#timeoutMs,
      'MPESA_DARAJA',
      isMutatingDisburse
    );
    const data = await res.json();
    if (!res.ok || (data.ResponseCode && data.ResponseCode !== '0')) {
      const status = res.status || (res.ok ? 400 : 500);
      throw new PayoutProviderError({
        message:
          data?.errorMessage ||
          data?.ResponseDescription ||
          `M-Pesa Daraja request failed with status ${status}`,
        rail: 'MPESA_DARAJA',
        statusCode: status,
        isAmbiguous: isMutatingDisburse && !res.ok && isHttpStatusAmbiguous(status),
      });
    }
    return data;
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    if (!params.mobileMoneyDetails) {
      throw new Error('mobileMoneyDetails is required for M-Pesa Daraja disbursements');
    }

    const data = await this.request(
      '/mpesa/b2c/v3/paymentrequest',
      {
        OriginatorConversationID: params.reference,
        InitiatorName: this.#config.initiatorName,
        SecurityCredential: this.#config.securityCredential,
        CommandID: params.metadata?.commandId || 'BusinessPayment',
        Amount: Math.round(params.amount),
        PartyA: this.#config.shortCode,
        PartyB: params.mobileMoneyDetails.phone,
        Remarks: params.narration || 'Marketplace payout',
        QueueTimeOutURL: this.#config.queueTimeoutUrl,
        ResultURL: this.#config.resultUrl,
        Occasion: params.reference,
      },
      true
    );

    return {
      success: true,
      transactionId: String(
        data.ConversationID || data.OriginatorConversationID || params.reference
      ),
      reference: String(data.OriginatorConversationID || params.reference),
      status: 'PENDING',
      providerStatus: 'ACCEPTED',
      rail: 'MPESA_DARAJA',
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      rawResponse: data,
    };
  }

  async getPayoutStatus(transactionId: string, reference?: string): Promise<DisburseResult> {
    const data = await this.request('/mpesa/transactionstatus/v1/query', {
      Initiator: this.#config.initiatorName,
      SecurityCredential: this.#config.securityCredential,
      CommandID: 'TransactionStatusQuery',
      TransactionID: transactionId,
      OriginatorConversationID: reference || transactionId,
      PartyA: this.#config.shortCode,
      IdentifierType: '4',
      ResultURL: this.#config.resultUrl,
      QueueTimeOutURL: this.#config.queueTimeoutUrl,
      Remarks: 'Payout status check',
      Occasion: reference || transactionId,
    });

    return {
      success: true,
      transactionId: String(data.ConversationID || transactionId),
      reference: String(data.OriginatorConversationID || reference || transactionId),
      status: 'PENDING',
      providerStatus: 'QUERY_ACCEPTED',
      rail: 'MPESA_DARAJA',
      amount: 0,
      currency: 'KES',
      rawResponse: data,
    };
  }

  async getBalances(): Promise<RailBalance[]> {
    const data = await this.request('/mpesa/accountbalance/v1/query', {
      Initiator: this.#config.initiatorName,
      SecurityCredential: this.#config.securityCredential,
      CommandID: 'AccountBalance',
      PartyA: this.#config.shortCode,
      IdentifierType: '4',
      Remarks: 'Float balance check',
      QueueTimeOutURL: this.#config.queueTimeoutUrl,
      ResultURL: this.#config.resultUrl,
    });

    if (typeof data.availableBalance === 'number') {
      return [
        {
          rail: 'MPESA_DARAJA',
          currency: String(data.currency || 'KES').toUpperCase(),
          available: data.availableBalance,
        },
      ];
    }

    return [];
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    if (!this.#config.webhookSecret) {
      throw new Error('M-Pesa Daraja webhookSecret is required to verify webhooks');
    }
    if (!constantTimeStringEqual(signature, this.#config.webhookSecret)) {
      throw new Error('Invalid M-Pesa Daraja webhook signature');
    }

    const payload = JSON.parse(rawBody);
    const result = payload.Result || payload;
    const resultCode = Number(result.ResultCode);
    const status: PayoutStatus = resultCode === 0 ? 'SUCCESSFUL' : 'FAILED';

    let amount = 0;
    const params: any[] = result.ResultParameters?.ResultParameter || [];
    for (const p of params) {
      if (p.Key === 'TransactionAmount') {
        amount = Number(p.Value || 0);
      }
    }

    return {
      rail: 'MPESA_DARAJA',
      eventType: status === 'SUCCESSFUL' ? 'b2c.result.success' : 'b2c.result.failed',
      transactionId: String(result.TransactionID || result.ConversationID || ''),
      reference: String(result.OriginatorConversationID || result.TransactionID || ''),
      status,
      providerStatus: String(result.ResultCode ?? ''),
      amount,
      currency: 'KES',
      error: status === 'FAILED' ? result.ResultDesc || 'M-Pesa B2C payout failed' : undefined,
      rawPayload: payload,
    };
  }
}
