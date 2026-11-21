package omnipayout

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var africanCurrencies = map[string]bool{
	"NGN": true, "KES": true, "GHS": true, "UGX": true,
	"TZS": true, "RWF": true, "XOF": true, "XAF": true, "ZAR": true,
}

// Engine is the central multi-rail payout client.
type Engine struct {
	config     Config
	httpClient *http.Client
}

// NewEngine initializes a new multi-rail payout engine.
func NewEngine(cfg Config) *Engine {
	return &Engine{
		config:     cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// ResolveRail determines the optimal payment rail based on parameters or currency.
func (e *Engine) ResolveRail(params DisburseParams) PayoutRail {
	if params.Rail != "" {
		return params.Rail
	}
	if params.StripeAccountID != "" {
		return RailStripeConnect
	}
	if params.BankDetails != nil || params.MobileMoneyDetails != nil {
		return RailFlutterwave
	}
	if africanCurrencies[strings.ToUpper(params.Currency)] {
		return RailFlutterwave
	}
	return RailStripeConnect
}

// Disburse executes a disbursement across the resolved payment rail.
func (e *Engine) Disburse(params DisburseParams) (*DisburseResult, error) {
	if params.Amount <= 0 {
		return nil, fmt.Errorf("disbursement amount must be greater than zero")
	}
	if params.Reference == "" {
		return nil, fmt.Errorf("unique reference is required")
	}

	rail := e.ResolveRail(params)

	switch rail {
	case RailStripeConnect:
		return e.disburseStripe(params)
	case RailFlutterwave:
		return e.disburseFlutterwave(params)
	default:
		return nil, fmt.Errorf("unsupported rail: %s", rail)
	}
}

func (e *Engine) disburseStripe(params DisburseParams) (*DisburseResult, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}
	if params.StripeAccountID == "" {
		return nil, fmt.Errorf("stripeAccountId is required for Stripe Connect disbursements")
	}

	amountInCents := int64(math.Round(params.Amount * 100))

	form := url.Values{}
	form.Set("amount", fmt.Sprintf("%d", amountInCents))
	form.Set("currency", strings.ToLower(params.Currency))
	form.Set("destination", params.StripeAccountID)
	form.Set("metadata[reference]", params.Reference)
	if params.Narration != "" {
		form.Set("description", params.Narration)
	}

	req, err := http.NewRequest("POST", "https://api.stripe.com/v1/transfers", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var stripeResp struct {
		ID    string `json:"id"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(bodyBytes, &stripeResp)

	if resp.StatusCode >= 400 || stripeResp.Error != nil {
		msg := "stripe transfer failed"
		if stripeResp.Error != nil {
			msg = stripeResp.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}

	txID := stripeResp.ID

	// Instant payout execution if requested
	if params.Speed == SpeedInstant {
		payoutForm := url.Values{}
		payoutForm.Set("amount", fmt.Sprintf("%d", amountInCents))
		payoutForm.Set("currency", strings.ToLower(params.Currency))
		payoutForm.Set("method", "instant")

		payoutReq, _ := http.NewRequest("POST", "https://api.stripe.com/v1/payouts", strings.NewReader(payoutForm.Encode()))
		payoutReq.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
		payoutReq.Header.Set("Stripe-Account", params.StripeAccountID)
		payoutReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

		pResp, pErr := e.httpClient.Do(payoutReq)
		if pErr == nil {
			defer pResp.Body.Close()
			var pData struct {
				ID string `json:"id"`
			}
			pBytes, _ := io.ReadAll(pResp.Body)
			_ = json.Unmarshal(pBytes, &pData)
			if pData.ID != "" {
				txID = pData.ID
			}
		}
	}

	return &DisburseResult{
		Success:       true,
		TransactionID: txID,
		Reference:     params.Reference,
		Status:        "SUCCESSFUL",
		Rail:          RailStripeConnect,
		Amount:        params.Amount,
		Currency:      strings.ToUpper(params.Currency),
	}, nil
}

func (e *Engine) disburseFlutterwave(params DisburseParams) (*DisburseResult, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is not configured")
	}

	payload := map[string]interface{}{
		"amount":    params.Amount,
		"currency":  strings.ToUpper(params.Currency),
		"reference": params.Reference,
		"narration": params.Narration,
	}

	if params.BankDetails != nil {
		payload["account_bank"] = params.BankDetails.BankCode
		payload["account_number"] = params.BankDetails.AccountNumber
		payload["debit_currency"] = strings.ToUpper(params.Currency)
	} else if params.MobileMoneyDetails != nil {
		payload["account_bank"] = strings.ToLower(params.MobileMoneyDetails.Network)
		payload["account_number"] = params.MobileMoneyDetails.Phone
	} else {
		return nil, fmt.Errorf("either bankDetails or mobileMoneyDetails is required for African payouts")
	}

	jsonBytes, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", "https://api.flutterwave.com/v3/transfers", bytes.NewBuffer(jsonBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.FlutterwaveSecretKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var flwResp struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Data    *struct {
			ID     int64   `json:"id"`
			Status string  `json:"status"`
			Fee    float64 `json:"fee"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &flwResp)

	if resp.StatusCode >= 400 || flwResp.Status == "error" {
		return nil, fmt.Errorf("flutterwave transfer error: %s", flwResp.Message)
	}

	txID := params.Reference
	fee := 0.0
	status := "PENDING"
	if flwResp.Data != nil {
		txID = fmt.Sprintf("%d", flwResp.Data.ID)
		fee = flwResp.Data.Fee
		if flwResp.Data.Status == "SUCCESSFUL" {
			status = "SUCCESSFUL"
		}
	}

	return &DisburseResult{
		Success:       true,
		TransactionID: txID,
		Reference:     params.Reference,
		Status:        status,
		Rail:          RailFlutterwave,
		Amount:        params.Amount,
		Currency:      strings.ToUpper(params.Currency),
		Fee:           fee,
	}, nil
}

// ResolveBankAccount verifies a Nigerian / African bank account name via NIP inquiry.
func (e *Engine) ResolveBankAccount(bankCode, accountNumber string) (*BankResolutionResult, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is required for account resolution")
	}

	body := map[string]string{
		"account_bank":   bankCode,
		"account_number": accountNumber,
	}
	jsonBytes, _ := json.Marshal(body)

	req, err := http.NewRequest("POST", "https://api.flutterwave.com/v3/accounts/resolve", bytes.NewBuffer(jsonBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.FlutterwaveSecretKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var res struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Data    struct {
			AccountName   string `json:"account_name"`
			AccountNumber string `json:"account_number"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &res)

	if resp.StatusCode >= 400 || res.Status == "error" {
		return nil, fmt.Errorf("account resolution failed: %s", res.Message)
	}

	return &BankResolutionResult{
		AccountName:   res.Data.AccountName,
		AccountNumber: res.Data.AccountNumber,
		BankCode:      bankCode,
	}, nil
}
