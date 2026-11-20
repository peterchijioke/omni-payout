import { BankResolutionResult, DisburseParams, DisburseResult } from '../types';

export class FlutterwaveAdapter {
  constructor(private readonly secretKey: string) {
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

    const isSuccess = res.status === 'success';
    const transferData = res.data || {};

    return {
      success: isSuccess,
      transactionId: String(transferData.id || params.reference),
      reference: params.reference,
      status: transferData.status === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'PENDING',
      rail: 'FLUTTERWAVE',
      amount: params.amount,
      currency: params.currency.toUpperCase(),
      fee: transferData.fee ? Number(transferData.fee) : undefined,
      rawResponse: res,
    };
  }
}
