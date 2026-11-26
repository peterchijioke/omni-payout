package omnipayout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func normalizePawaPayStatus(raw string) string {
	switch strings.ToUpper(raw) {
	case "COMPLETED", "SUCCESSFUL":
		return string(StatusSuccessful)
	case "FAILED", "REJECTED", "CANCELLED":
		return string(StatusFailed)
	default:
		return string(StatusPending)
	}
}

func resolvePawaPayCorrespondent(network, currency string) string {
	key := strings.ToUpper(network) + "_" + strings.ToUpper(currency)
	correspondents := map[string]string{
		"MPESA_KES":    "MPESA_KEN",
		"MTN_GHS":      "MTN_MOMO_GHA",
		"VODAFONE_GHS": "VODAFONE_GHA",
		"AIRTEL_GHS":   "AIRTELTIGO_GHA",
		"MTN_UGX":      "MTN_MOMO_UGA",
		"AIRTEL_UGX":   "AIRTEL_OAPI_UGA",
		"MTN_RWF":      "MTN_MOMO_RWA",
		"AIRTEL_RWF":   "AIRTEL_OAPI_RWA",
		"AIRTEL_TZS":   "AIRTEL_TZA",
		"ORANGE_XOF":   "ORANGE_CIV",
		"MTN_XOF":      "MTN_MOMO_CIV",
		"WAVE_XOF":     "WAVE_SEN",
	}
	if c, ok := correspondents[key]; ok {
		return c
	}
	return key
}

func (e *Engine) pawaPayBaseURL() (string, error) {
	return sanitizeBaseURL(e.config.PawaPayBaseURL, "https://api.pawapay.io")
}

func (e *Engine) disbursePawaPay(ctx context.Context, params DisburseParams) (*DisburseResult, error) {
	if e.config.PawaPayAPIToken == "" {
		return nil, fmt.Errorf("pawapay apiToken is not configured")
	}
	if params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("mobileMoneyDetails is required for PawaPay disbursements")
	}
	baseURL, err := e.pawaPayBaseURL()
	if err != nil {
		return nil, err
	}

	currency := strings.ToUpper(params.Currency)
	correspondent := ""
	if params.Metadata != nil {
		correspondent = params.Metadata["correspondent"]
	}
	if correspondent == "" {
		correspondent = resolvePawaPayCorrespondent(params.MobileMoneyDetails.Network, currency)
	}

	desc := params.Narration
	if desc == "" {
		desc = "Marketplace payout"
	}
	if len(desc) > 22 {
		desc = desc[:22]
	}

	msisdn, err := NormalizeMSISDN(params.MobileMoneyDetails.Phone, currency)
	if err != nil {
		return nil, err
	}

	payoutID := toDeterministicUUID(params.Reference)
	payload := map[string]interface{}{
		"payoutId":      payoutID,
		"amount":        strconv.FormatFloat(params.Amount, 'f', -1, 64),
		"currency":      currency,
		"correspondent": correspondent,
		"recipient": map[string]interface{}{
			"type": "MSISDN",
			"address": map[string]string{
				"value": msisdn,
			},
		},
		"customerTimestamp":    time.Now().UTC().Format(time.RFC3339),
		"statementDescription": desc,
	}

	bodyBytes, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/payouts", bytes.NewBuffer(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.PawaPayAPIToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, newProviderError(RailPawaPay, 0, err.Error(), true)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	var data struct {
		PayoutID        string `json:"payoutId"`
		Status          string `json:"status"`
		Message         string `json:"message"`
		RejectionReason *struct {
			RejectionMessage string `json:"rejectionMessage"`
		} `json:"rejectionReason"`
		FailureReason *struct {
			FailureMessage string `json:"failureMessage"`
		} `json:"failureReason"`
	}
	_ = json.Unmarshal(respBytes, &data)
	if resp.StatusCode >= 400 {
		msg := data.Message
		if data.FailureReason != nil && data.FailureReason.FailureMessage != "" {
			msg = data.FailureReason.FailureMessage
		}
		if msg == "" {
			msg = fmt.Sprintf("pawapay request failed with status %d", resp.StatusCode)
		}
		return nil, newProviderError(RailPawaPay, resp.StatusCode, msg, isHTTPStatusAmbiguous(resp.StatusCode))
	}

	rawStatus := data.Status
	if rawStatus == "" {
		rawStatus = "ACCEPTED"
	}
	status := normalizePawaPayStatus(rawStatus)
	txID := data.PayoutID
	if txID == "" {
		txID = payoutID
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if data.RejectionReason != nil && data.RejectionReason.RejectionMessage != "" {
			errMsg = data.RejectionReason.RejectionMessage
		} else if data.FailureReason != nil && data.FailureReason.FailureMessage != "" {
			errMsg = data.FailureReason.FailureMessage
		} else {
			errMsg = "pawapay payout rejected"
		}
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      params.Reference,
		Status:         status,
		ProviderStatus: rawStatus,
		Rail:           RailPawaPay,
		Amount:         params.Amount,
		Currency:       currency,
		Error:          errMsg,
	}, nil
}

func (e *Engine) getPawaPayPayoutStatus(ctx context.Context, params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.PawaPayAPIToken == "" {
		return nil, fmt.Errorf("pawapay apiToken is not configured")
	}
	baseURL, err := e.pawaPayBaseURL()
	if err != nil {
		return nil, err
	}

	lookupID := params.TransactionID
	if params.Reference != "" {
		lookupID = toDeterministicUUID(params.Reference)
	}
	safeID, err := validateSafeIdentifier(lookupID, "payoutId")
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/payouts/"+safeID, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.PawaPayAPIToken)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, newProviderError(RailPawaPay, 0, err.Error(), false)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, newProviderError(RailPawaPay, resp.StatusCode, fmt.Sprintf("pawapay status lookup failed with status %d", resp.StatusCode), false)
	}

	type pawaItem struct {
		PayoutID      string `json:"payoutId"`
		Status        string `json:"status"`
		Amount        string `json:"amount"`
		Currency      string `json:"currency"`
		FailureReason *struct {
			FailureMessage string `json:"failureMessage"`
		} `json:"failureReason"`
	}
	var item pawaItem
	trimmed := bytes.TrimSpace(respBytes)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var list []pawaItem
		_ = json.Unmarshal(trimmed, &list)
		if len(list) == 0 {
			return nil, &ProviderError{
				Rail:       RailPawaPay,
				StatusCode: http.StatusNotFound,
				Message:    "pawapay payout not found",
			}
		}
		item = list[0]
	} else {
		_ = json.Unmarshal(trimmed, &item)
	}

	status := normalizePawaPayStatus(item.Status)
	amt, _ := strconv.ParseFloat(item.Amount, 64)
	txID := item.PayoutID
	if txID == "" {
		txID = lookupID
	}
	ref := params.Reference
	if ref == "" {
		ref = txID
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if item.FailureReason != nil && item.FailureReason.FailureMessage != "" {
			errMsg = item.FailureReason.FailureMessage
		} else {
			errMsg = "pawapay payout failed"
		}
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: item.Status,
		Rail:           RailPawaPay,
		Amount:         amt,
		Currency:       strings.ToUpper(item.Currency),
		Error:          errMsg,
	}, nil
}

func (e *Engine) getPawaPayBalances(ctx context.Context) ([]RailBalance, error) {
	if e.config.PawaPayAPIToken == "" {
		return nil, fmt.Errorf("pawapay apiToken is not configured")
	}
	baseURL, err := e.pawaPayBaseURL()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/wallets/balances", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.PawaPayAPIToken)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("pawapay balance lookup failed with status %d", resp.StatusCode)
	}

	var wrapped struct {
		Balances []struct {
			Currency string  `json:"currency"`
			Balance  float64 `json:"balance"`
		} `json:"balances"`
	}
	_ = json.Unmarshal(respBytes, &wrapped)
	out := make([]RailBalance, 0, len(wrapped.Balances))
	for _, row := range wrapped.Balances {
		out = append(out, RailBalance{
			Rail:      RailPawaPay,
			Currency:  strings.ToUpper(row.Currency),
			Available: row.Balance,
		})
	}
	return out, nil
}

func (e *Engine) verifyPawaPayWebhook(rawBody []byte, signature string) (*WebhookEvent, error) {
	if e.config.PawaPayWebhookSecret == "" {
		return nil, fmt.Errorf("pawapay webhookSecret is required to verify webhooks")
	}
	mac := hmac.New(sha256.New, []byte(e.config.PawaPayWebhookSecret))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !constantTimeHexEqual(signature, expected) {
		return nil, fmt.Errorf("invalid pawapay webhook signature")
	}

	var payload struct {
		PayoutID      string `json:"payoutId"`
		Status        string `json:"status"`
		Amount        string `json:"amount"`
		Fee           string `json:"fee"`
		Currency      string `json:"currency"`
		FailureReason *struct {
			FailureMessage string `json:"failureMessage"`
		} `json:"failureReason"`
	}
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, err
	}
	status := normalizePawaPayStatus(payload.Status)
	amt, _ := strconv.ParseFloat(payload.Amount, 64)
	fee, _ := strconv.ParseFloat(payload.Fee, 64)
	errMsg := ""
	if status == string(StatusFailed) {
		if payload.FailureReason != nil && payload.FailureReason.FailureMessage != "" {
			errMsg = payload.FailureReason.FailureMessage
		} else {
			errMsg = "pawapay payout failed"
		}
	}
	return &WebhookEvent{
		Rail:           RailPawaPay,
		EventType:      "payout." + strings.ToLower(payload.Status),
		TransactionID:  payload.PayoutID,
		Reference:      payload.PayoutID,
		Status:         status,
		ProviderStatus: payload.Status,
		Amount:         amt,
		Currency:       strings.ToUpper(payload.Currency),
		Fee:            fee,
		Error:          errMsg,
	}, nil
}

// --- Yellow Card ---

func normalizeYellowCardStatus(raw string) string {
	switch strings.ToLower(raw) {
	case "complete", "completed", "settled", "successful":
		return string(StatusSuccessful)
	case "failed", "cancelled", "canceled", "rejected", "expired":
		return string(StatusFailed)
	default:
		return string(StatusPending)
	}
}

func (e *Engine) yellowCardBaseURL() (string, error) {
	return sanitizeBaseURL(e.config.YellowCardBaseURL, "https://api.yellowcard.io")
}

func (e *Engine) yellowCardRequest(ctx context.Context, method, path string, bodyObj interface{}, isMutating bool) ([]byte, int, error) {
	baseURL, err := e.yellowCardBaseURL()
	if err != nil {
		return nil, 0, err
	}
	var bodyBytes []byte
	if bodyObj != nil {
		bodyBytes, _ = json.Marshal(bodyObj)
	}
	var bodyReader io.Reader
	if len(bodyBytes) > 0 {
		bodyReader = bytes.NewBuffer(bodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}

	ts := time.Now().UTC().Format(time.RFC3339)
	mac := hmac.New(sha256.New, []byte(e.config.YellowCardSecretKey))
	mac.Write([]byte(ts))
	mac.Write([]byte(path))
	mac.Write([]byte(strings.ToUpper(method)))
	if len(bodyBytes) > 0 {
		sum := sha256.Sum256(bodyBytes)
		mac.Write([]byte(base64.StdEncoding.EncodeToString(sum[:])))
	}
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	req.Header.Set("X-YC-Timestamp", ts)
	req.Header.Set("Authorization", "YcHmacV1 "+e.config.YellowCardAPIKey+":"+sig)
	if len(bodyBytes) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := e.httpClient.Do(req)
	if err != nil {
		pErr := newProviderError(RailYellowCard, 0, err.Error(), isMutating)
		if !isMutating {
			pErr.Retryable = true
		}
		return nil, 0, pErr
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	return respBytes, resp.StatusCode, nil
}

func (e *Engine) disburseYellowCard(ctx context.Context, params DisburseParams) (*DisburseResult, error) {
	if e.config.YellowCardAPIKey == "" || e.config.YellowCardSecretKey == "" {
		return nil, fmt.Errorf("yellow card apiKey and secretKey are required")
	}
	if params.BankDetails == nil && params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("either bankDetails or mobileMoneyDetails is required for Yellow Card disbursements")
	}

	currency := strings.ToUpper(params.Currency)
	var dest map[string]interface{}
	if params.BankDetails != nil {
		resolvedBank := ResolveProviderCode(params.BankDetails.BankCode, currency, RailYellowCard, false)
		netID := resolvedBank
		if params.Metadata != nil && params.Metadata["networkId"] != "" {
			netID = params.Metadata["networkId"]
		}
		accName := params.BankDetails.AccountName
		if accName == "" {
			accName = params.BankDetails.AccountNumber
		}
		dest = map[string]interface{}{
			"accountType":   "bank",
			"accountNumber": params.BankDetails.AccountNumber,
			"accountName":   accName,
			"accountBank":   resolvedBank,
			"networkId":     netID,
		}
	} else {
		msisdn, err := NormalizeMSISDN(params.MobileMoneyDetails.Phone, currency)
		if err != nil {
			return nil, err
		}
		netID := ResolveProviderCode(params.MobileMoneyDetails.Network, currency, RailYellowCard, true)
		if params.Metadata != nil && params.Metadata["networkId"] != "" {
			netID = params.Metadata["networkId"]
		}
		dest = map[string]interface{}{
			"accountType":   "momo",
			"accountNumber": msisdn,
			"networkId":     netID,
		}
	}

	channelID := currency + "_PAYOUT"
	if params.Metadata != nil && params.Metadata["channelId"] != "" {
		channelID = params.Metadata["channelId"]
	}
	reason := params.Narration
	if reason == "" {
		reason = "Marketplace disbursement"
	}

	payload := map[string]interface{}{
		"sequenceId":  params.Reference,
		"channelId":   channelID,
		"localAmount": params.Amount,
		"currency":    currency,
		"reason":      reason,
		"destination": dest,
		"forceAccept": true,
	}

	respBytes, statusCode, err := e.yellowCardRequest(ctx, "POST", "/business/payments", payload, true)
	if err != nil {
		return nil, err
	}

	var data struct {
		ID            string `json:"id"`
		SequenceID    string `json:"sequenceId"`
		Status        string `json:"status"`
		Message       string `json:"message"`
		FailureReason string `json:"failureReason"`
	}
	_ = json.Unmarshal(respBytes, &data)
	if statusCode >= 400 {
		msg := data.Message
		if msg == "" {
			msg = fmt.Sprintf("yellow card request failed with status %d", statusCode)
		}
		return nil, newProviderError(RailYellowCard, statusCode, msg, isHTTPStatusAmbiguous(statusCode))
	}

	status := normalizeYellowCardStatus(data.Status)
	txID := data.ID
	if txID == "" {
		txID = params.Reference
	}
	ref := data.SequenceID
	if ref == "" {
		ref = params.Reference
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if data.FailureReason != "" {
			errMsg = data.FailureReason
		} else {
			errMsg = "yellow card payout failed"
		}
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: data.Status,
		Rail:           RailYellowCard,
		Amount:         params.Amount,
		Currency:       currency,
		Error:          errMsg,
	}, nil
}

func (e *Engine) getYellowCardPayoutStatus(ctx context.Context, params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.YellowCardAPIKey == "" || e.config.YellowCardSecretKey == "" {
		return nil, fmt.Errorf("yellow card apiKey and secretKey are required")
	}

	var path string
	if params.Reference != "" {
		safeRef, err := validateSafeIdentifier(params.Reference, "reference")
		if err != nil {
			return nil, err
		}
		path = "/business/payments/sequence-id/" + safeRef
	} else {
		safeID, err := validateSafeIdentifier(params.TransactionID, "transactionId")
		if err != nil {
			return nil, err
		}
		path = "/business/payments/" + safeID
	}

	respBytes, statusCode, err := e.yellowCardRequest(ctx, "GET", path, nil, false)
	if err != nil {
		return nil, err
	}
	if statusCode >= 400 {
		return nil, newProviderError(RailYellowCard, statusCode, fmt.Sprintf("yellow card status lookup failed with status %d", statusCode), false)
	}

	var data struct {
		ID            string  `json:"id"`
		SequenceID    string  `json:"sequenceId"`
		Status        string  `json:"status"`
		LocalAmount   float64 `json:"localAmount"`
		Amount        float64 `json:"amount"`
		Currency      string  `json:"currency"`
		FailureReason string  `json:"failureReason"`
	}
	_ = json.Unmarshal(respBytes, &data)
	status := normalizeYellowCardStatus(data.Status)
	amt := data.LocalAmount
	if amt == 0 {
		amt = data.Amount
	}
	txID := data.ID
	if txID == "" {
		txID = params.TransactionID
	}
	ref := data.SequenceID
	if ref == "" {
		ref = params.Reference
	}
	if ref == "" {
		ref = txID
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if data.FailureReason != "" {
			errMsg = data.FailureReason
		} else {
			errMsg = "yellow card payout failed"
		}
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: data.Status,
		Rail:           RailYellowCard,
		Amount:         amt,
		Currency:       strings.ToUpper(data.Currency),
		Error:          errMsg,
	}, nil
}

func (e *Engine) getYellowCardBalances(ctx context.Context) ([]RailBalance, error) {
	if e.config.YellowCardAPIKey == "" || e.config.YellowCardSecretKey == "" {
		return nil, fmt.Errorf("yellow card apiKey and secretKey are required")
	}
	respBytes, statusCode, err := e.yellowCardRequest(ctx, "GET", "/business/account", nil, false)
	if err != nil {
		return nil, err
	}
	if statusCode >= 400 {
		return nil, fmt.Errorf("yellow card balance lookup failed with status %d", statusCode)
	}

	var data struct {
		Accounts []struct {
			Currency         string  `json:"currency"`
			AvailableBalance float64 `json:"availableBalance"`
			Balance          float64 `json:"balance"`
			PendingBalance   float64 `json:"pendingBalance"`
		} `json:"accounts"`
	}
	_ = json.Unmarshal(respBytes, &data)
	out := make([]RailBalance, 0, len(data.Accounts))
	for _, acc := range data.Accounts {
		avail := acc.AvailableBalance
		if avail == 0 {
			avail = acc.Balance
		}
		out = append(out, RailBalance{
			Rail:      RailYellowCard,
			Currency:  strings.ToUpper(acc.Currency),
			Available: avail,
			Pending:   acc.PendingBalance,
		})
	}
	return out, nil
}

func (e *Engine) verifyYellowCardWebhook(rawBody []byte, signature string) (*WebhookEvent, error) {
	secret := e.config.YellowCardWebhookSecret
	if secret == "" {
		secret = e.config.YellowCardSecretKey
	}
	if secret == "" {
		return nil, fmt.Errorf("yellow card secret is required to verify webhooks")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(rawBody)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if signature == "" || subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) != 1 {
		return nil, fmt.Errorf("invalid yellow card webhook signature")
	}

	var payload struct {
		Event         string  `json:"event"`
		ID            string  `json:"id"`
		SequenceID    string  `json:"sequenceId"`
		Status        string  `json:"status"`
		LocalAmount   float64 `json:"localAmount"`
		Amount        float64 `json:"amount"`
		Fee           float64 `json:"fee"`
		ServiceFee    float64 `json:"serviceFee"`
		Currency      string  `json:"currency"`
		FailureReason string  `json:"failureReason"`
	}
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, err
	}
	status := normalizeYellowCardStatus(payload.Status)
	amt := payload.LocalAmount
	if amt == 0 {
		amt = payload.Amount
	}
	fee := payload.Fee
	if fee == 0 {
		fee = payload.ServiceFee
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if payload.FailureReason != "" {
			errMsg = payload.FailureReason
		} else {
			errMsg = "yellow card payout failed"
		}
	}
	return &WebhookEvent{
		Rail:           RailYellowCard,
		EventType:      payload.Event,
		TransactionID:  payload.ID,
		Reference:      payload.SequenceID,
		Status:         status,
		ProviderStatus: payload.Status,
		Amount:         amt,
		Currency:       strings.ToUpper(payload.Currency),
		Fee:            fee,
		Error:          errMsg,
	}, nil
}

// --- M-Pesa Daraja ---

func (e *Engine) mpesaBaseURL() (string, error) {
	raw := ""
	if e.config.MpesaDaraja != nil {
		raw = e.config.MpesaDaraja.BaseURL
	}
	return sanitizeBaseURL(raw, "https://api.safaricom.co.ke")
}

func (e *Engine) mpesaSecurityCredential() (string, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil {
		return "", fmt.Errorf("mpesa daraja is not configured")
	}
	if cfg.SecurityCredential != "" {
		return cfg.SecurityCredential, nil
	}
	if cfg.InitiatorPassword != "" && cfg.CertificatePEM != "" {
		return EncryptMpesaInitiatorPassword(cfg.InitiatorPassword, cfg.CertificatePEM)
	}
	return "", fmt.Errorf("mpesa daraja requires either SecurityCredential or both InitiatorPassword and CertificatePEM")
}

func (e *Engine) getMpesaAccessToken(ctx context.Context) (string, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil || cfg.ConsumerKey == "" || cfg.ConsumerSecret == "" {
		return "", fmt.Errorf("mpesa daraja consumerKey and consumerSecret are required")
	}

	e.mpesaMu.Lock()
	defer e.mpesaMu.Unlock()

	if e.mpesaToken != "" && time.Now().Before(e.mpesaTokenExpiry) {
		return e.mpesaToken, nil
	}

	baseURL, err := e.mpesaBaseURL()
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/oauth/v1/generate?grant_type=client_credentials", nil)
	if err != nil {
		return "", err
	}
	basic := base64.StdEncoding.EncodeToString([]byte(cfg.ConsumerKey + ":" + cfg.ConsumerSecret))
	req.Header.Set("Authorization", "Basic "+basic)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		pErr := newProviderError(RailMpesaDaraja, 0, err.Error(), false)
		pErr.Retryable = true
		return "", pErr
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var data struct {
		AccessToken  string      `json:"access_token"`
		ExpiresIn    interface{} `json:"expires_in"`
		ErrorMessage string      `json:"errorMessage"`
	}
	_ = json.Unmarshal(bodyBytes, &data)
	if resp.StatusCode >= 400 || data.AccessToken == "" {
		msg := data.ErrorMessage
		if msg == "" {
			msg = fmt.Sprintf("mpesa oauth failed with status %d", resp.StatusCode)
		}
		return "", newProviderError(RailMpesaDaraja, resp.StatusCode, msg, false)
	}

	expiresSec := int64(3500)
	switch v := data.ExpiresIn.(type) {
	case string:
		if parsed, pErr := strconv.ParseInt(v, 10, 64); pErr == nil && parsed > 0 {
			expiresSec = parsed
		}
	case float64:
		if v > 0 {
			expiresSec = int64(v)
		}
	}
	if expiresSec > 120 {
		expiresSec -= 60
	} else {
		expiresSec = 60
	}

	e.mpesaToken = data.AccessToken
	e.mpesaTokenExpiry = time.Now().Add(time.Duration(expiresSec) * time.Second)
	return data.AccessToken, nil
}

func (e *Engine) mpesaPost(ctx context.Context, path string, body interface{}, isMutating bool) ([]byte, error) {
	baseURL, err := e.mpesaBaseURL()
	if err != nil {
		return nil, err
	}
	token, err := e.getMpesaAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	jsonBytes, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+path, bytes.NewBuffer(jsonBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		pErr := newProviderError(RailMpesaDaraja, 0, err.Error(), isMutating)
		if !isMutating {
			pErr.Retryable = true
		}
		return nil, pErr
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	var errCheck struct {
		ResponseCode        string `json:"ResponseCode"`
		ResponseDescription string `json:"ResponseDescription"`
		ErrorMessage        string `json:"errorMessage"`
	}
	_ = json.Unmarshal(respBytes, &errCheck)
	if resp.StatusCode >= 400 || (errCheck.ResponseCode != "" && errCheck.ResponseCode != "0") {
		msg := errCheck.ErrorMessage
		if msg == "" {
			msg = errCheck.ResponseDescription
		}
		if msg == "" {
			msg = fmt.Sprintf("mpesa daraja request failed with status %d", resp.StatusCode)
		}
		st := resp.StatusCode
		if st < 400 {
			st = 400
		}
		return nil, newProviderError(RailMpesaDaraja, st, msg, isMutating && resp.StatusCode >= 500 && isHTTPStatusAmbiguous(resp.StatusCode))
	}
	return respBytes, nil
}

func (e *Engine) disburseMpesaDaraja(ctx context.Context, params DisburseParams) (*DisburseResult, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil {
		return nil, fmt.Errorf("mpesa daraja is not configured")
	}
	if params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("mobileMoneyDetails is required for M-Pesa Daraja disbursements")
	}
	secCred, err := e.mpesaSecurityCredential()
	if err != nil {
		return nil, err
	}
	cur := params.Currency
	if cur == "" {
		cur = "KES"
	}
	msisdn, err := NormalizeMSISDN(params.MobileMoneyDetails.Phone, cur)
	if err != nil {
		return nil, err
	}

	commandID := "BusinessPayment"
	if params.Metadata != nil && params.Metadata["commandId"] != "" {
		commandID = params.Metadata["commandId"]
	}
	remarks := params.Narration
	if remarks == "" {
		remarks = "Marketplace payout"
	}

	respBytes, err := e.mpesaPost(ctx, "/mpesa/b2c/v3/paymentrequest", map[string]interface{}{
		"OriginatorConversationID": params.Reference,
		"InitiatorName":            cfg.InitiatorName,
		"SecurityCredential":       secCred,
		"CommandID":                commandID,
		"Amount":                   int64(math.Round(params.Amount)),
		"PartyA":                   cfg.ShortCode,
		"PartyB":                   msisdn,
		"Remarks":                  remarks,
		"QueueTimeOutURL":          cfg.QueueTimeoutURL,
		"ResultURL":                cfg.ResultURL,
		"Occasion":                 params.Reference,
	}, true)
	if err != nil {
		return nil, err
	}

	var data struct {
		ConversationID           string `json:"ConversationID"`
		OriginatorConversationID string `json:"OriginatorConversationID"`
	}
	_ = json.Unmarshal(respBytes, &data)
	txID := data.ConversationID
	if txID == "" {
		txID = params.Reference
	}
	ref := data.OriginatorConversationID
	if ref == "" {
		ref = params.Reference
	}

	return &DisburseResult{
		Success:        true,
		TransactionID:  txID,
		Reference:      ref,
		Status:         string(StatusPending),
		ProviderStatus: "ACCEPTED",
		Rail:           RailMpesaDaraja,
		Amount:         params.Amount,
		Currency:       strings.ToUpper(params.Currency),
	}, nil
}

func (e *Engine) getMpesaDarajaPayoutStatus(ctx context.Context, params PayoutStatusParams) (*DisburseResult, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil {
		return nil, fmt.Errorf("mpesa daraja is not configured")
	}
	secCred, err := e.mpesaSecurityCredential()
	if err != nil {
		return nil, err
	}
	ref := params.Reference
	if ref == "" {
		ref = params.TransactionID
	}

	respBytes, err := e.mpesaPost(ctx, "/mpesa/transactionstatus/v1/query", map[string]interface{}{
		"Initiator":                cfg.InitiatorName,
		"SecurityCredential":       secCred,
		"CommandID":                "TransactionStatusQuery",
		"TransactionID":            params.TransactionID,
		"OriginatorConversationID": ref,
		"PartyA":                   cfg.ShortCode,
		"IdentifierType":           "4",
		"ResultURL":                cfg.ResultURL,
		"QueueTimeOutURL":          cfg.QueueTimeoutURL,
		"Remarks":                  "Payout status check",
		"Occasion":                 ref,
	}, false)
	if err != nil {
		return nil, err
	}

	var data struct {
		ConversationID           string `json:"ConversationID"`
		OriginatorConversationID string `json:"OriginatorConversationID"`
	}
	_ = json.Unmarshal(respBytes, &data)
	txID := data.ConversationID
	if txID == "" {
		txID = params.TransactionID
	}

	return &DisburseResult{
		Success:        true,
		TransactionID:  txID,
		Reference:      ref,
		Status:         string(StatusPending),
		ProviderStatus: "QUERY_ACCEPTED",
		Rail:           RailMpesaDaraja,
		Currency:       "KES",
	}, nil
}

func (e *Engine) getMpesaDarajaBalances(ctx context.Context) ([]RailBalance, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil {
		return nil, fmt.Errorf("mpesa daraja is not configured")
	}
	secCred, err := e.mpesaSecurityCredential()
	if err != nil {
		return nil, err
	}
	respBytes, err := e.mpesaPost(ctx, "/mpesa/accountbalance/v1/query", map[string]interface{}{
		"Initiator":          cfg.InitiatorName,
		"SecurityCredential": secCred,
		"CommandID":          "AccountBalance",
		"PartyA":             cfg.ShortCode,
		"IdentifierType":     "4",
		"Remarks":            "Float balance check",
		"QueueTimeOutURL":    cfg.QueueTimeoutURL,
		"ResultURL":          cfg.ResultURL,
	}, false)
	if err != nil {
		return nil, err
	}

	var data struct {
		AvailableBalance *float64 `json:"availableBalance"`
		Currency         string   `json:"currency"`
	}
	_ = json.Unmarshal(respBytes, &data)
	if data.AvailableBalance != nil {
		cur := strings.ToUpper(data.Currency)
		if cur == "" {
			cur = "KES"
		}
		return []RailBalance{
			{
				Rail:      RailMpesaDaraja,
				Currency:  cur,
				Available: *data.AvailableBalance,
			},
		}, nil
	}
	return []RailBalance{}, nil
}

func (e *Engine) verifyMpesaDarajaWebhook(rawBody []byte, signature string) (*WebhookEvent, error) {
	if e.config.MpesaDaraja == nil || e.config.MpesaDaraja.WebhookSecret == "" {
		return nil, fmt.Errorf("mpesa daraja webhookSecret is required to verify webhooks")
	}
	if signature == "" || subtle.ConstantTimeCompare([]byte(signature), []byte(e.config.MpesaDaraja.WebhookSecret)) != 1 {
		return nil, fmt.Errorf("invalid mpesa daraja webhook signature")
	}

	var wrapper struct {
		QueueTimeout interface{} `json:"QueueTimeout"`
		Result       struct {
			ResultCode               int    `json:"ResultCode"`
			ResultDesc               string `json:"ResultDesc"`
			OriginatorConversationID string `json:"OriginatorConversationID"`
			ConversationID           string `json:"ConversationID"`
			TransactionID            string `json:"TransactionID"`
			ResultParameters         struct {
				ResultParameter []struct {
					Key   string      `json:"Key"`
					Value interface{} `json:"Value"`
				} `json:"ResultParameter"`
			} `json:"ResultParameters"`
		} `json:"Result"`
	}
	if err := json.Unmarshal(rawBody, &wrapper); err != nil {
		return nil, err
	}

	res := wrapper.Result
	lowerDesc := strings.ToLower(res.ResultDesc)
	isQueueTimeout := wrapper.QueueTimeout != nil ||
		res.ResultCode == 1037 ||
		strings.Contains(lowerDesc, "queue timeout") ||
		strings.Contains(lowerDesc, "timed out")

	status := string(StatusFailed)
	eventType := "b2c.result.failed"
	providerStatus := strconv.Itoa(res.ResultCode)
	if isQueueTimeout {
		eventType = "b2c.result.timeout"
		providerStatus = "QUEUE_TIMEOUT"
	} else if res.ResultCode == 0 {
		status = string(StatusSuccessful)
		eventType = "b2c.result.success"
	}

	amount := 0.0
	fee := 0.0
	for _, p := range res.ResultParameters.ResultParameter {
		switch p.Key {
		case "TransactionAmount":
			switch v := p.Value.(type) {
			case float64:
				amount = v
			case string:
				amount, _ = strconv.ParseFloat(v, 64)
			}
		case "TransactionCharge":
			switch v := p.Value.(type) {
			case float64:
				fee = v
			case string:
				fee, _ = strconv.ParseFloat(v, 64)
			}
		}
	}

	txID := res.TransactionID
	if txID == "" {
		txID = res.ConversationID
	}
	ref := res.OriginatorConversationID
	if ref == "" {
		ref = txID
	}
	errMsg := ""
	if status == string(StatusFailed) {
		if res.ResultDesc != "" {
			errMsg = res.ResultDesc
		} else if isQueueTimeout {
			errMsg = "mpesa b2c queue timeout"
		} else {
			errMsg = "mpesa b2c payout failed"
		}
	}

	return &WebhookEvent{
		Rail:           RailMpesaDaraja,
		EventType:      eventType,
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: providerStatus,
		Amount:         amount,
		Currency:       "KES",
		Fee:            fee,
		Error:          errMsg,
	}, nil
}
