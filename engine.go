package omnipayout

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/hex"
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

func normalizePaystackStatus(rawStatus string) string {
	if rawStatus == "" {
		return string(StatusPending)
	}
	switch strings.ToLower(rawStatus) {
	case "success", "successful":
		return string(StatusSuccessful)
	case "failed", "reversed", "abandoned":
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

// ResolveRail determines the optimal primary payment rail based on parameters or currency.
func (e *Engine) ResolveRail(params DisburseParams) PayoutRail {
	if params.Rail != "" {
		return params.Rail
	}
	if params.StripeAccountID != "" {
		return RailStripeConnect
	}
	if params.BankDetails != nil || params.MobileMoneyDetails != nil || africanCurrencies[strings.ToUpper(params.Currency)] {
		if e.config.FlutterwaveSecretKey == "" && e.config.PaystackSecretKey != "" {
			return RailPaystack
		}
		return RailFlutterwave
	}
	return RailStripeConnect
}

func (e *Engine) disburseOnRail(rail PayoutRail, params DisburseParams) (*DisburseResult, error) {
	switch rail {
	case RailStripeConnect:
		return e.disburseStripe(params)
	case RailFlutterwave:
		return e.disburseFlutterwave(params)
	case RailPaystack:
		return e.disbursePaystack(params)
	default:
		return nil, fmt.Errorf("unsupported rail: %s", rail)
	}
}

// Disburse executes a disbursement with optional pre-flight balance checks and automatic failover.
func (e *Engine) Disburse(params DisburseParams) (*DisburseResult, error) {
	if params.Amount <= 0 {
		return nil, fmt.Errorf("disbursement amount must be greater than zero")
	}
	if params.Reference == "" {
		return nil, fmt.Errorf("unique reference is required")
	}

	primaryRail := e.ResolveRail(params)
	candidates := []PayoutRail{primaryRail}
	seen := map[PayoutRail]bool{primaryRail: true}
	for _, fb := range params.FallbackRails {
		if fb != "" && !seen[fb] {
			candidates = append(candidates, fb)
			seen[fb] = true
		}
	}

	var attempted []PayoutRail
	var lastErr error
	var lastFailed *DisburseResult
	currency := strings.ToUpper(params.Currency)

	for i, rail := range candidates {
		hasFallback := i < len(candidates)-1
		attempted = append(attempted, rail)

		if params.CheckBalanceBeforeDisburse {
			balances, err := e.GetBalances(rail)
			if err != nil {
				lastErr = err
				if hasFallback {
					continue
				}
				return nil, err
			}
			insufficient := false
			for _, b := range balances {
				if b.Currency == currency && b.Available < params.Amount {
					lastErr = fmt.Errorf("insufficient %s balance on %s: available %.2f, required %.2f", currency, rail, b.Available, params.Amount)
					insufficient = true
					break
				}
			}
			if insufficient {
				if hasFallback {
					continue
				}
				return nil, lastErr
			}
		}

		res, err := e.disburseOnRail(rail, params)
		if err != nil {
			lastErr = err
			if hasFallback {
				continue
			}
			return nil, err
		}
		if res.Status == string(StatusFailed) && hasFallback {
			lastFailed = res
			lastErr = fmt.Errorf("%s disbursement returned FAILED: %s", rail, res.Error)
			continue
		}

		res.AttemptedRails = attempted
		if rail != primaryRail {
			res.FailoverFrom = primaryRail
		}
		return res, nil
	}

	if lastFailed != nil {
		lastFailed.AttemptedRails = attempted
		return lastFailed, nil
	}
	return nil, lastErr
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
	case RailPaystack:
		return e.getPaystackPayoutStatus(params)
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

func (e *Engine) disbursePaystack(params DisburseParams) (*DisburseResult, error) {
	if e.config.PaystackSecretKey == "" {
		return nil, fmt.Errorf("paystack secret key is not configured")
	}
	if params.BankDetails == nil && params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("either bankDetails or mobileMoneyDetails is required for Paystack payouts")
	}

	currency := strings.ToUpper(params.Currency)
	amountInSubunit := int64(math.Round(params.Amount * 100))

	var recipientPayload map[string]interface{}
	if params.BankDetails != nil {
		recType := "nuban"
		if currency == "GHS" {
			recType = "ghipss"
		} else if currency == "ZAR" {
			recType = "basa"
		}
		name := params.BankDetails.AccountName
		if name == "" {
			name = params.BankDetails.AccountNumber
		}
		recipientPayload = map[string]interface{}{
			"type":           recType,
			"name":           name,
			"account_number": params.BankDetails.AccountNumber,
			"bank_code":      params.BankDetails.BankCode,
			"currency":       currency,
		}
	} else {
		recipientPayload = map[string]interface{}{
			"type":           "mobile_money",
			"name":           params.MobileMoneyDetails.Phone,
			"account_number": params.MobileMoneyDetails.Phone,
			"bank_code":      strings.ToUpper(params.MobileMoneyDetails.Network),
			"currency":       currency,
		}
	}

	recBytes, _ := json.Marshal(recipientPayload)
	recReq, err := http.NewRequest("POST", "https://api.paystack.co/transferrecipient", bytes.NewBuffer(recBytes))
	if err != nil {
		return nil, err
	}
	recReq.Header.Set("Authorization", "Bearer "+e.config.PaystackSecretKey)
	recReq.Header.Set("Content-Type", "application/json")

	recResp, err := e.httpClient.Do(recReq)
	if err != nil {
		return nil, err
	}
	defer recResp.Body.Close()

	recBody, _ := io.ReadAll(recResp.Body)
	var recData struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    *struct {
			RecipientCode string `json:"recipient_code"`
		} `json:"data"`
	}
	_ = json.Unmarshal(recBody, &recData)
	if recResp.StatusCode >= 400 || !recData.Status || recData.Data == nil || recData.Data.RecipientCode == "" {
		return nil, fmt.Errorf("paystack recipient error: %s", recData.Message)
	}

	reason := params.Narration
	if reason == "" {
		reason = "Marketplace disbursement"
	}
	transferPayload := map[string]interface{}{
		"source":    "balance",
		"amount":    amountInSubunit,
		"recipient": recData.Data.RecipientCode,
		"currency":  currency,
		"reference": params.Reference,
		"reason":    reason,
	}
	txBytes, _ := json.Marshal(transferPayload)
	txReq, err := http.NewRequest("POST", "https://api.paystack.co/transfer", bytes.NewBuffer(txBytes))
	if err != nil {
		return nil, err
	}
	txReq.Header.Set("Authorization", "Bearer "+e.config.PaystackSecretKey)
	txReq.Header.Set("Content-Type", "application/json")

	txResp, err := e.httpClient.Do(txReq)
	if err != nil {
		return nil, err
	}
	defer txResp.Body.Close()

	txBody, _ := io.ReadAll(txResp.Body)
	var psResp struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    *struct {
			ID           int64  `json:"id"`
			TransferCode string `json:"transfer_code"`
			Reference    string `json:"reference"`
			Status       string `json:"status"`
			Failures     string `json:"failures"`
		} `json:"data"`
	}
	_ = json.Unmarshal(txBody, &psResp)
	if txResp.StatusCode >= 400 || !psResp.Status {
		return nil, fmt.Errorf("paystack transfer error: %s", psResp.Message)
	}

	txID := params.Reference
	ref := params.Reference
	providerStatus := ""
	status := string(StatusPending)
	errMsg := ""
	if psResp.Data != nil {
		if psResp.Data.TransferCode != "" {
			txID = psResp.Data.TransferCode
		} else if psResp.Data.ID != 0 {
			txID = fmt.Sprintf("%d", psResp.Data.ID)
		}
		if psResp.Data.Reference != "" {
			ref = psResp.Data.Reference
		}
		providerStatus = psResp.Data.Status
		status = normalizePaystackStatus(psResp.Data.Status)
		if status == string(StatusFailed) {
			if psResp.Data.Failures != "" {
				errMsg = psResp.Data.Failures
			} else {
				errMsg = psResp.Message
			}
		}
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: providerStatus,
		Rail:           RailPaystack,
		Amount:         params.Amount,
		Currency:       currency,
		Error:          errMsg,
	}, nil
}

func (e *Engine) getPaystackPayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.PaystackSecretKey == "" {
		return nil, fmt.Errorf("paystack secret key is not configured")
	}

	endpoint := "https://api.paystack.co/transfer/" + url.PathEscape(params.TransactionID)
	if params.Reference != "" {
		endpoint = "https://api.paystack.co/transfer/verify/" + url.PathEscape(params.Reference)
	}

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.PaystackSecretKey)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var psResp struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    *struct {
			ID           int64  `json:"id"`
			TransferCode string `json:"transfer_code"`
			Reference    string `json:"reference"`
			Status       string `json:"status"`
			Amount       int64  `json:"amount"`
			Currency     string `json:"currency"`
			Failures     string `json:"failures"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &psResp)
	if resp.StatusCode >= 400 || !psResp.Status {
		return nil, fmt.Errorf("paystack status lookup error: %s", psResp.Message)
	}

	txID := params.TransactionID
	ref := params.Reference
	if ref == "" {
		ref = params.TransactionID
	}
	amount := 0.0
	currency := ""
	providerStatus := ""
	status := string(StatusPending)
	errMsg := ""
	if psResp.Data != nil {
		if psResp.Data.TransferCode != "" {
			txID = psResp.Data.TransferCode
		} else if psResp.Data.ID != 0 {
			txID = fmt.Sprintf("%d", psResp.Data.ID)
		}
		if psResp.Data.Reference != "" {
			ref = psResp.Data.Reference
		}
		amount = float64(psResp.Data.Amount) / 100.0
		currency = strings.ToUpper(psResp.Data.Currency)
		providerStatus = psResp.Data.Status
		status = normalizePaystackStatus(psResp.Data.Status)
		if status == string(StatusFailed) {
			if psResp.Data.Failures != "" {
				errMsg = psResp.Data.Failures
			} else {
				errMsg = psResp.Message
			}
		}
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: providerStatus,
		Rail:           RailPaystack,
		Amount:         amount,
		Currency:       currency,
		Error:          errMsg,
	}, nil
}

// GetBalances queries available float balances for a specific rail, or all configured rails when rail is empty.
func (e *Engine) GetBalances(rail PayoutRail) ([]RailBalance, error) {
	if rail != "" {
		switch rail {
		case RailStripeConnect:
			return e.getStripeBalances()
		case RailFlutterwave:
			return e.getFlutterwaveBalances()
		case RailPaystack:
			return e.getPaystackBalances()
		default:
			return nil, fmt.Errorf("unsupported rail: %s", rail)
		}
	}

	var all []RailBalance
	if e.config.StripeSecretKey != "" {
		b, err := e.getStripeBalances()
		if err != nil {
			return nil, err
		}
		all = append(all, b...)
	}
	if e.config.FlutterwaveSecretKey != "" {
		b, err := e.getFlutterwaveBalances()
		if err != nil {
			return nil, err
		}
		all = append(all, b...)
	}
	if e.config.PaystackSecretKey != "" {
		b, err := e.getPaystackBalances()
		if err != nil {
			return nil, err
		}
		all = append(all, b...)
	}
	return all, nil
}

func (e *Engine) getStripeBalances() ([]RailBalance, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}
	req, err := http.NewRequest("GET", "https://api.stripe.com/v1/balance", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var data struct {
		Available []struct {
			Currency string `json:"currency"`
			Amount   int64  `json:"amount"`
		} `json:"available"`
		Pending []struct {
			Currency string `json:"currency"`
			Amount   int64  `json:"amount"`
		} `json:"pending"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(bodyBytes, &data)
	if resp.StatusCode >= 400 || data.Error != nil {
		msg := "stripe balance lookup failed"
		if data.Error != nil {
			msg = data.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}

	byCurrency := map[string]*RailBalance{}
	var order []string
	for _, a := range data.Available {
		cur := strings.ToUpper(a.Currency)
		byCurrency[cur] = &RailBalance{
			Rail:      RailStripeConnect,
			Currency:  cur,
			Available: float64(a.Amount) / 100.0,
		}
		order = append(order, cur)
	}
	for _, p := range data.Pending {
		cur := strings.ToUpper(p.Currency)
		if b, ok := byCurrency[cur]; ok {
			b.Pending = float64(p.Amount) / 100.0
		} else {
			byCurrency[cur] = &RailBalance{
				Rail:     RailStripeConnect,
				Currency: cur,
				Pending:  float64(p.Amount) / 100.0,
			}
			order = append(order, cur)
		}
	}

	out := make([]RailBalance, 0, len(order))
	for _, cur := range order {
		out = append(out, *byCurrency[cur])
	}
	return out, nil
}

func (e *Engine) getFlutterwaveBalances() ([]RailBalance, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is not configured")
	}
	req, err := http.NewRequest("GET", "https://api.flutterwave.com/v3/balances", nil)
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
		Data    []struct {
			Currency         string  `json:"currency"`
			AvailableBalance float64 `json:"available_balance"`
			LedgerBalance    float64 `json:"ledger_balance"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &flwResp)
	if resp.StatusCode >= 400 || flwResp.Status == "error" {
		return nil, fmt.Errorf("flutterwave balance error: %s", flwResp.Message)
	}

	out := make([]RailBalance, 0, len(flwResp.Data))
	for _, row := range flwResp.Data {
		pending := 0.0
		if row.LedgerBalance > row.AvailableBalance {
			pending = row.LedgerBalance - row.AvailableBalance
		}
		out = append(out, RailBalance{
			Rail:      RailFlutterwave,
			Currency:  strings.ToUpper(row.Currency),
			Available: row.AvailableBalance,
			Pending:   pending,
		})
	}
	return out, nil
}

func (e *Engine) getPaystackBalances() ([]RailBalance, error) {
	if e.config.PaystackSecretKey == "" {
		return nil, fmt.Errorf("paystack secret key is not configured")
	}
	req, err := http.NewRequest("GET", "https://api.paystack.co/balance", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.PaystackSecretKey)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var psResp struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    []struct {
			Currency string `json:"currency"`
			Balance  int64  `json:"balance"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &psResp)
	if resp.StatusCode >= 400 || !psResp.Status {
		return nil, fmt.Errorf("paystack balance error: %s", psResp.Message)
	}

	out := make([]RailBalance, 0, len(psResp.Data))
	for _, row := range psResp.Data {
		out = append(out, RailBalance{
			Rail:      RailPaystack,
			Currency:  strings.ToUpper(row.Currency),
			Available: float64(row.Balance) / 100.0,
		})
	}
	return out, nil
}

// VerifyWebhook validates a provider webhook signature and normalizes the event.
func (e *Engine) VerifyWebhook(rail PayoutRail, rawBody []byte, signature string) (*WebhookEvent, error) {
	switch rail {
	case RailStripeConnect:
		return e.verifyStripeWebhook(rawBody, signature)
	case RailFlutterwave:
		return e.verifyFlutterwaveWebhook(rawBody, signature)
	case RailPaystack:
		return e.verifyPaystackWebhook(rawBody, signature)
	default:
		return nil, fmt.Errorf("unsupported rail: %s", rail)
	}
}

func (e *Engine) verifyStripeWebhook(rawBody []byte, signatureHeader string) (*WebhookEvent, error) {
	if e.config.StripeWebhookSecret == "" {
		return nil, fmt.Errorf("stripe webhookSecret is required to verify webhooks")
	}

	var timestamp, v1 string
	for _, part := range strings.Split(signatureHeader, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		if kv[0] == "t" {
			timestamp = kv[1]
		} else if kv[0] == "v1" {
			v1 = kv[1]
		}
	}
	if timestamp == "" || v1 == "" {
		return nil, fmt.Errorf("invalid Stripe-Signature header format")
	}

	mac := hmac.New(sha256.New, []byte(e.config.StripeWebhookSecret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(v1), []byte(expected)) != 1 {
		return nil, fmt.Errorf("invalid stripe webhook signature")
	}

	var payload struct {
		Type string `json:"type"`
		Data struct {
			Object struct {
				ID             string            `json:"id"`
				Status         string            `json:"status"`
				Amount         int64             `json:"amount"`
				Currency       string            `json:"currency"`
				FailureMessage string            `json:"failure_message"`
				Metadata       map[string]string `json:"metadata"`
			} `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, err
	}

	obj := payload.Data.Object
	defaultStatus := StatusPending
	if payload.Type == "payout.paid" {
		defaultStatus = StatusSuccessful
	} else if payload.Type == "payout.failed" || payload.Type == "payout.canceled" {
		defaultStatus = StatusFailed
	}
	status := normalizeStripeStatus(obj.Status, defaultStatus)
	ref := obj.Metadata["reference"]
	if ref == "" {
		ref = obj.ID
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if obj.FailureMessage != "" {
			errMsg = obj.FailureMessage
		} else {
			errMsg = "stripe payout failed"
		}
	}

	return &WebhookEvent{
		Rail:           RailStripeConnect,
		EventType:      payload.Type,
		TransactionID:  obj.ID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: obj.Status,
		Amount:         float64(obj.Amount) / 100.0,
		Currency:       strings.ToUpper(obj.Currency),
		Error:          errMsg,
	}, nil
}

func (e *Engine) verifyFlutterwaveWebhook(rawBody []byte, verifHash string) (*WebhookEvent, error) {
	if e.config.FlutterwaveWebhookSecret == "" {
		return nil, fmt.Errorf("flutterwave webhookSecret is required to verify webhooks")
	}
	if subtle.ConstantTimeCompare([]byte(verifHash), []byte(e.config.FlutterwaveWebhookSecret)) != 1 {
		return nil, fmt.Errorf("invalid flutterwave webhook signature")
	}

	var payload struct {
		Event string `json:"event"`
		Data  struct {
			ID              int64   `json:"id"`
			Reference       string  `json:"reference"`
			Status          string  `json:"status"`
			Amount          float64 `json:"amount"`
			Currency        string  `json:"currency"`
			CompleteMessage string  `json:"complete_message"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, err
	}

	status := normalizeFlutterwaveStatus(payload.Data.Status)
	errMsg := ""
	if status == string(StatusFailed) {
		if payload.Data.CompleteMessage != "" {
			errMsg = payload.Data.CompleteMessage
		} else {
			errMsg = "flutterwave transfer failed"
		}
	}

	return &WebhookEvent{
		Rail:           RailFlutterwave,
		EventType:      payload.Event,
		TransactionID:  fmt.Sprintf("%d", payload.Data.ID),
		Reference:      payload.Data.Reference,
		Status:         status,
		ProviderStatus: payload.Data.Status,
		Amount:         payload.Data.Amount,
		Currency:       strings.ToUpper(payload.Data.Currency),
		Error:          errMsg,
	}, nil
}

func (e *Engine) verifyPaystackWebhook(rawBody []byte, signature string) (*WebhookEvent, error) {
	secret := e.config.PaystackWebhookSecret
	if secret == "" {
		secret = e.config.PaystackSecretKey
	}
	if secret == "" {
		return nil, fmt.Errorf("paystack secret key or webhookSecret is required to verify webhooks")
	}

	mac := hmac.New(sha512.New, []byte(secret))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) != 1 {
		return nil, fmt.Errorf("invalid paystack webhook signature")
	}

	var payload struct {
		Event string `json:"event"`
		Data  struct {
			ID           int64  `json:"id"`
			TransferCode string `json:"transfer_code"`
			Reference    string `json:"reference"`
			Status       string `json:"status"`
			Amount       int64  `json:"amount"`
			Currency     string `json:"currency"`
			Reason       string `json:"reason"`
			Failures     string `json:"failures"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, err
	}

	rawStatus := payload.Data.Status
	if rawStatus == "" {
		switch payload.Event {
		case "transfer.success":
			rawStatus = "success"
		case "transfer.failed", "transfer.reversed":
			rawStatus = "failed"
		default:
			rawStatus = "pending"
		}
	}
	status := normalizePaystackStatus(rawStatus)
	txID := payload.Data.TransferCode
	if txID == "" && payload.Data.ID != 0 {
		txID = fmt.Sprintf("%d", payload.Data.ID)
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if payload.Data.Reason != "" {
			errMsg = payload.Data.Reason
		} else if payload.Data.Failures != "" {
			errMsg = payload.Data.Failures
		} else {
			errMsg = "paystack transfer failed"
		}
	}

	return &WebhookEvent{
		Rail:           RailPaystack,
		EventType:      payload.Event,
		TransactionID:  txID,
		Reference:      payload.Data.Reference,
		Status:         status,
		ProviderStatus: rawStatus,
		Amount:         float64(payload.Data.Amount) / 100.0,
		Currency:       strings.ToUpper(payload.Data.Currency),
		Error:          errMsg,
	}, nil
}
