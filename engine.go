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

func normalizeStripeStatus(rawStatus string, defaultStatus PayoutStatus) string {
	if rawStatus == "" {
		return string(defaultStatus)
	}
	switch strings.ToLower(rawStatus) {
	case "paid", "succeeded", "successful":
		return string(StatusSuccessful)
	case "failed", "canceled", "cancelled":
		return string(StatusFailed)
	default:
		return string(StatusPending)
	}
}

func normalizeFlutterwaveStatus(rawStatus string) string {
	if rawStatus == "" {
		return string(StatusPending)
	}
	switch strings.ToUpper(rawStatus) {
	case "SUCCESSFUL", "SUCCESS":
		return string(StatusSuccessful)
	case "FAILED", "FAIL", "CANCELLED", "CANCELED":
		return string(StatusFailed)
	default:
		return string(StatusPending)
	}
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
	req.Header.Set("Idempotency-Key", params.Reference+":transfer")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var stripeResp struct {
		ID             string `json:"id"`
		Status         string `json:"status"`
		FailureMessage string `json:"failure_message"`
		Error          *struct {
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
	providerStatus := stripeResp.Status
	status := normalizeStripeStatus(stripeResp.Status, StatusSuccessful)
	failureMsg := stripeResp.FailureMessage

	// Instant payout execution if requested
	if params.Speed == SpeedInstant {
		payoutForm := url.Values{}
		payoutForm.Set("amount", fmt.Sprintf("%d", amountInCents))
		payoutForm.Set("currency", strings.ToLower(params.Currency))
		payoutForm.Set("method", "instant")
		payoutForm.Set("metadata[reference]", params.Reference)

		payoutReq, err := http.NewRequest("POST", "https://api.stripe.com/v1/payouts", strings.NewReader(payoutForm.Encode()))
		if err != nil {
			return nil, err
		}
		payoutReq.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
		payoutReq.Header.Set("Stripe-Account", params.StripeAccountID)
		payoutReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		payoutReq.Header.Set("Idempotency-Key", params.Reference+":payout")

		pResp, pErr := e.httpClient.Do(payoutReq)
		if pErr != nil {
			return nil, pErr
		}
		defer pResp.Body.Close()

		var pData struct {
			ID             string `json:"id"`
			Status         string `json:"status"`
			FailureMessage string `json:"failure_message"`
			Error          *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		pBytes, _ := io.ReadAll(pResp.Body)
		_ = json.Unmarshal(pBytes, &pData)

		if pResp.StatusCode >= 400 || pData.Error != nil {
			msg := "stripe instant payout failed"
			if pData.Error != nil {
				msg = pData.Error.Message
			}
			return nil, fmt.Errorf("%s", msg)
		}

		if pData.ID != "" {
			txID = pData.ID
		}
		providerStatus = pData.Status
		status = normalizeStripeStatus(pData.Status, StatusPending)
		failureMsg = pData.FailureMessage
	}

	errMsg := ""
	if status == string(StatusFailed) {
		if failureMsg != "" {
			errMsg = failureMsg
		} else {
			errMsg = "stripe payout failed"
		}
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      params.Reference,
		Status:         status,
		ProviderStatus: providerStatus,
		Rail:           RailStripeConnect,
		Amount:         params.Amount,
		Currency:       strings.ToUpper(params.Currency),
		Error:          errMsg,
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
			ID              int64   `json:"id"`
			Status          string  `json:"status"`
			Reference       string  `json:"reference"`
			Fee             float64 `json:"fee"`
			CompleteMessage string  `json:"complete_message"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &flwResp)

	if resp.StatusCode >= 400 || flwResp.Status == "error" {
		return nil, fmt.Errorf("flutterwave transfer error: %s", flwResp.Message)
	}

	txID := params.Reference
	ref := params.Reference
	fee := 0.0
	providerStatus := ""
	status := string(StatusPending)
	errMsg := ""
	if flwResp.Data != nil {
		if flwResp.Data.ID != 0 {
			txID = fmt.Sprintf("%d", flwResp.Data.ID)
		}
		if flwResp.Data.Reference != "" {
			ref = flwResp.Data.Reference
		}
		fee = flwResp.Data.Fee
		providerStatus = flwResp.Data.Status
		status = normalizeFlutterwaveStatus(flwResp.Data.Status)
		if status == string(StatusFailed) {
			if flwResp.Data.CompleteMessage != "" {
				errMsg = flwResp.Data.CompleteMessage
			} else {
				errMsg = flwResp.Message
			}
		}
	}

	return &DisburseResult{
		Success:        flwResp.Status == "success" && status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: providerStatus,
		Rail:           RailFlutterwave,
		Amount:         params.Amount,
		Currency:       strings.ToUpper(params.Currency),
		Fee:            fee,
		Error:          errMsg,
	}, nil
}

// GetPayoutStatus fetches the latest settlement status for a previously initiated payout.
func (e *Engine) GetPayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	if params.TransactionID == "" {
		return nil, fmt.Errorf("transactionId is required to check payout status")
	}

	switch params.Rail {
	case RailStripeConnect:
		return e.getStripePayoutStatus(params)
	case RailFlutterwave:
		return e.getFlutterwavePayoutStatus(params)
	default:
		return nil, fmt.Errorf("unsupported rail: %s", params.Rail)
	}
}

func (e *Engine) getStripePayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}

	isPayout := strings.HasPrefix(params.TransactionID, "po_")
	endpoint := "https://api.stripe.com/v1/transfers/" + params.TransactionID
	defaultStatus := StatusSuccessful
	if isPayout {
		endpoint = "https://api.stripe.com/v1/payouts/" + params.TransactionID
		defaultStatus = StatusPending
	}

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
	if isPayout && params.StripeAccountID != "" {
		req.Header.Set("Stripe-Account", params.StripeAccountID)
	}

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var data struct {
		ID             string            `json:"id"`
		Status         string            `json:"status"`
		Amount         int64             `json:"amount"`
		Currency       string            `json:"currency"`
		FailureMessage string            `json:"failure_message"`
		Metadata       map[string]string `json:"metadata"`
		Error          *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(bodyBytes, &data)

	if resp.StatusCode >= 400 || data.Error != nil {
		msg := "stripe status lookup failed"
		if data.Error != nil {
			msg = data.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}

	status := normalizeStripeStatus(data.Status, defaultStatus)
	ref := data.Metadata["reference"]
	if ref == "" {
		ref = params.Reference
	}
	if ref == "" {
		ref = params.TransactionID
	}

	errMsg := ""
	if status == string(StatusFailed) {
		if data.FailureMessage != "" {
			errMsg = data.FailureMessage
		} else {
			errMsg = "stripe payout failed"
		}
	}

	txID := data.ID
	if txID == "" {
		txID = params.TransactionID
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: data.Status,
		Rail:           RailStripeConnect,
		Amount:         float64(data.Amount) / 100.0,
		Currency:       strings.ToUpper(data.Currency),
		Error:          errMsg,
	}, nil
}

func (e *Engine) getFlutterwavePayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is not configured")
	}

	req, err := http.NewRequest("GET", "https://api.flutterwave.com/v3/transfers/"+params.TransactionID, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.FlutterwaveSecretKey)

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
			ID              int64   `json:"id"`
			Status          string  `json:"status"`
			Reference       string  `json:"reference"`
			Amount          float64 `json:"amount"`
			Currency        string  `json:"currency"`
			Fee             float64 `json:"fee"`
			CompleteMessage string  `json:"complete_message"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &flwResp)

	if resp.StatusCode >= 400 || flwResp.Status == "error" {
		return nil, fmt.Errorf("flutterwave status lookup error: %s", flwResp.Message)
	}

	txID := params.TransactionID
	ref := params.Reference
	if ref == "" {
		ref = params.TransactionID
	}
	amount := 0.0
	currency := ""
	fee := 0.0
	providerStatus := ""
	status := string(StatusPending)
	errMsg := ""
	if flwResp.Data != nil {
		if flwResp.Data.ID != 0 {
			txID = fmt.Sprintf("%d", flwResp.Data.ID)
		}
		if flwResp.Data.Reference != "" {
			ref = flwResp.Data.Reference
		}
		amount = flwResp.Data.Amount
		currency = strings.ToUpper(flwResp.Data.Currency)
		fee = flwResp.Data.Fee
		providerStatus = flwResp.Data.Status
		status = normalizeFlutterwaveStatus(flwResp.Data.Status)
		if status == string(StatusFailed) {
			if flwResp.Data.CompleteMessage != "" {
				errMsg = flwResp.Data.CompleteMessage
			} else {
				errMsg = flwResp.Message
			}
		}
	}

	return &DisburseResult{
		Success:        flwResp.Status == "success" && status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: providerStatus,
		Rail:           RailFlutterwave,
		Amount:         amount,
		Currency:       currency,
		Fee:            fee,
		Error:          errMsg,
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
