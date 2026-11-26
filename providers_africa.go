package omnipayout

import (
	"bytes"
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
	"net/url"
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

func (e *Engine) pawaPayBaseURL() string {
	if e.config.PawaPayBaseURL != "" {
		return strings.TrimRight(e.config.PawaPayBaseURL, "/")
	}
	return "https://api.pawapay.io"
}

func (e *Engine) disbursePawaPay(params DisburseParams) (*DisburseResult, error) {
	if e.config.PawaPayAPIToken == "" {
		return nil, fmt.Errorf("pawapay apiToken is not configured")
	}
	if params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("mobileMoneyDetails is required for PawaPay disbursements")
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

	payload := map[string]interface{}{
		"payoutId":      params.Reference,
		"amount":        strconv.FormatFloat(params.Amount, 'f', -1, 64),
		"currency":      currency,
		"correspondent": correspondent,
		"recipient": map[string]interface{}{
			"type": "MSISDN",
			"address": map[string]string{
				"value": params.MobileMoneyDetails.Phone,
			},
		},
		"customerTimestamp":    time.Now().UTC().Format(time.RFC3339),
		"statementDescription": desc,
	}

	bodyBytes, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", e.pawaPayBaseURL()+"/payouts", bytes.NewBuffer(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.PawaPayAPIToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
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
		return nil, fmt.Errorf("%s", msg)
	}

	rawStatus := data.Status
	if rawStatus == "" {
		rawStatus = "ACCEPTED"
	}
	status := normalizePawaPayStatus(rawStatus)
	txID := data.PayoutID
	if txID == "" {
		txID = params.Reference
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
		Reference:      txID,
		Status:         status,
		ProviderStatus: rawStatus,
		Rail:           RailPawaPay,
		Amount:         params.Amount,
		Currency:       currency,
		Error:          errMsg,
	}, nil
}

func (e *Engine) getPawaPayPayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.PawaPayAPIToken == "" {
		return nil, fmt.Errorf("pawapay apiToken is not configured")
	}
	id := params.Reference
	if id == "" {
		id = params.TransactionID
	}

	req, err := http.NewRequest("GET", e.pawaPayBaseURL()+"/payouts/"+url.PathEscape(id), nil)
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
		return nil, fmt.Errorf("pawapay status lookup failed with status %d", resp.StatusCode)
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
		if len(list) > 0 {
			item = list[0]
		}
	} else {
		_ = json.Unmarshal(trimmed, &item)
	}

	status := normalizePawaPayStatus(item.Status)
	amt, _ := strconv.ParseFloat(item.Amount, 64)
	txID := item.PayoutID
	if txID == "" {
		txID = params.TransactionID
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
		Reference:      txID,
		Status:         status,
		ProviderStatus: item.Status,
		Rail:           RailPawaPay,
		Amount:         amt,
		Currency:       strings.ToUpper(item.Currency),
		Error:          errMsg,
	}, nil
}

func (e *Engine) getPawaPayBalances() ([]RailBalance, error) {
	if e.config.PawaPayAPIToken == "" {
		return nil, fmt.Errorf("pawapay apiToken is not configured")
	}
	req, err := http.NewRequest("GET", e.pawaPayBaseURL()+"/wallets/balances", nil)
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
	if e.config.PawaPayWebhookSecret != "" {
		mac := hmac.New(sha256.New, []byte(e.config.PawaPayWebhookSecret))
		mac.Write(rawBody)
		expected := hex.EncodeToString(mac.Sum(nil))
		if subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) != 1 {
			return nil, fmt.Errorf("invalid pawapay webhook signature")
		}
	}

	var payload struct {
		PayoutID      string `json:"payoutId"`
		Status        string `json:"status"`
		Amount        string `json:"amount"`
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

func (e *Engine) yellowCardBaseURL() string {
	if e.config.YellowCardBaseURL != "" {
		return strings.TrimRight(e.config.YellowCardBaseURL, "/")
	}
	return "https://api.yellowcard.io"
}

func (e *Engine) yellowCardRequest(method, path string, bodyObj interface{}) ([]byte, int, error) {
	var bodyBytes []byte
	if bodyObj != nil {
		bodyBytes, _ = json.Marshal(bodyObj)
	}
	var bodyReader io.Reader
	if len(bodyBytes) > 0 {
		bodyReader = bytes.NewBuffer(bodyBytes)
	}

	req, err := http.NewRequest(method, e.yellowCardBaseURL()+path, bodyReader)
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
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	return respBytes, resp.StatusCode, nil
}

func (e *Engine) disburseYellowCard(params DisburseParams) (*DisburseResult, error) {
	if e.config.YellowCardAPIKey == "" || e.config.YellowCardSecretKey == "" {
		return nil, fmt.Errorf("yellow card apiKey and secretKey are required")
	}
	if params.BankDetails == nil && params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("either bankDetails or mobileMoneyDetails is required for Yellow Card disbursements")
	}

	currency := strings.ToUpper(params.Currency)
	var dest map[string]interface{}
	if params.BankDetails != nil {
		netID := params.BankDetails.BankCode
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
			"accountBank":   params.BankDetails.BankCode,
			"networkId":     netID,
		}
	} else {
		netID := params.MobileMoneyDetails.Network
		if params.Metadata != nil && params.Metadata["networkId"] != "" {
			netID = params.Metadata["networkId"]
		}
		dest = map[string]interface{}{
			"accountType":   "momo",
			"accountNumber": params.MobileMoneyDetails.Phone,
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

	respBytes, statusCode, err := e.yellowCardRequest("POST", "/business/payments", payload)
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
		return nil, fmt.Errorf("%s", msg)
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

func (e *Engine) getYellowCardPayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.YellowCardAPIKey == "" || e.config.YellowCardSecretKey == "" {
		return nil, fmt.Errorf("yellow card apiKey and secretKey are required")
	}
	path := "/business/payments/" + url.PathEscape(params.TransactionID)
	if params.Reference != "" {
		path = "/business/payments/sequence-id/" + url.PathEscape(params.Reference)
	}

	respBytes, statusCode, err := e.yellowCardRequest("GET", path, nil)
	if err != nil {
		return nil, err
	}
	if statusCode >= 400 {
		return nil, fmt.Errorf("yellow card status lookup failed with status %d", statusCode)
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

func (e *Engine) getYellowCardBalances() ([]RailBalance, error) {
	if e.config.YellowCardAPIKey == "" || e.config.YellowCardSecretKey == "" {
		return nil, fmt.Errorf("yellow card apiKey and secretKey are required")
	}
	respBytes, statusCode, err := e.yellowCardRequest("GET", "/business/account", nil)
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
	if subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) != 1 {
		return nil, fmt.Errorf("invalid yellow card webhook signature")
	}

	var payload struct {
		Event         string  `json:"event"`
		ID            string  `json:"id"`
		SequenceID    string  `json:"sequenceId"`
		Status        string  `json:"status"`
		LocalAmount   float64 `json:"localAmount"`
		Amount        float64 `json:"amount"`
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
		Error:          errMsg,
	}, nil
}

// --- M-Pesa Daraja ---

func (e *Engine) mpesaBaseURL() string {
	if e.config.MpesaDaraja != nil && e.config.MpesaDaraja.BaseURL != "" {
		return strings.TrimRight(e.config.MpesaDaraja.BaseURL, "/")
	}
	return "https://api.safaricom.co.ke"
}

func (e *Engine) getMpesaAccessToken() (string, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil || cfg.ConsumerKey == "" || cfg.ConsumerSecret == "" {
		return "", fmt.Errorf("mpesa daraja consumerKey and consumerSecret are required")
	}
	req, err := http.NewRequest("GET", e.mpesaBaseURL()+"/oauth/v1/generate?grant_type=client_credentials", nil)
	if err != nil {
		return "", err
	}
	basic := base64.StdEncoding.EncodeToString([]byte(cfg.ConsumerKey + ":" + cfg.ConsumerSecret))
	req.Header.Set("Authorization", "Basic "+basic)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var data struct {
		AccessToken  string `json:"access_token"`
		ErrorMessage string `json:"errorMessage"`
	}
	_ = json.Unmarshal(bodyBytes, &data)
	if resp.StatusCode >= 400 || data.AccessToken == "" {
		msg := data.ErrorMessage
		if msg == "" {
			msg = fmt.Sprintf("mpesa oauth failed with status %d", resp.StatusCode)
		}
		return "", fmt.Errorf("%s", msg)
	}
	return data.AccessToken, nil
}

func (e *Engine) mpesaPost(path string, body interface{}) ([]byte, error) {
	token, err := e.getMpesaAccessToken()
	if err != nil {
		return nil, err
	}
	jsonBytes, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", e.mpesaBaseURL()+path, bytes.NewBuffer(jsonBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, err
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
		return nil, fmt.Errorf("%s", msg)
	}
	return respBytes, nil
}

func (e *Engine) disburseMpesaDaraja(params DisburseParams) (*DisburseResult, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil {
		return nil, fmt.Errorf("mpesa daraja is not configured")
	}
	if params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("mobileMoneyDetails is required for M-Pesa Daraja disbursements")
	}

	commandID := "BusinessPayment"
	if params.Metadata != nil && params.Metadata["commandId"] != "" {
		commandID = params.Metadata["commandId"]
	}
	remarks := params.Narration
	if remarks == "" {
		remarks = "Marketplace payout"
	}

	respBytes, err := e.mpesaPost("/mpesa/b2c/v3/paymentrequest", map[string]interface{}{
		"OriginatorConversationID": params.Reference,
		"InitiatorName":            cfg.InitiatorName,
		"SecurityCredential":       cfg.SecurityCredential,
		"CommandID":                commandID,
		"Amount":                   int64(math.Round(params.Amount)),
		"PartyA":                   cfg.ShortCode,
		"PartyB":                   params.MobileMoneyDetails.Phone,
		"Remarks":                  remarks,
		"QueueTimeOutURL":          cfg.QueueTimeoutURL,
		"ResultURL":                cfg.ResultURL,
		"Occasion":                 params.Reference,
	})
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

func (e *Engine) getMpesaDarajaPayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil {
		return nil, fmt.Errorf("mpesa daraja is not configured")
	}
	ref := params.Reference
	if ref == "" {
		ref = params.TransactionID
	}

	respBytes, err := e.mpesaPost("/mpesa/transactionstatus/v1/query", map[string]interface{}{
		"Initiator":                cfg.InitiatorName,
		"SecurityCredential":       cfg.SecurityCredential,
		"CommandID":                "TransactionStatusQuery",
		"TransactionID":            params.TransactionID,
		"OriginatorConversationID": ref,
		"PartyA":                   cfg.ShortCode,
		"IdentifierType":           "4",
		"ResultURL":                cfg.ResultURL,
		"QueueTimeOutURL":          cfg.QueueTimeoutURL,
		"Remarks":                  "Payout status check",
		"Occasion":                 ref,
	})
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

func (e *Engine) getMpesaDarajaBalances() ([]RailBalance, error) {
	cfg := e.config.MpesaDaraja
	if cfg == nil {
		return nil, fmt.Errorf("mpesa daraja is not configured")
	}
	respBytes, err := e.mpesaPost("/mpesa/accountbalance/v1/query", map[string]interface{}{
		"Initiator":          cfg.InitiatorName,
		"SecurityCredential": cfg.SecurityCredential,
		"CommandID":          "AccountBalance",
		"PartyA":             cfg.ShortCode,
		"IdentifierType":     "4",
		"Remarks":            "Float balance check",
		"QueueTimeOutURL":    cfg.QueueTimeoutURL,
		"ResultURL":          cfg.ResultURL,
	})
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
	if e.config.MpesaDaraja != nil && e.config.MpesaDaraja.WebhookSecret != "" {
		if subtle.ConstantTimeCompare([]byte(signature), []byte(e.config.MpesaDaraja.WebhookSecret)) != 1 {
			return nil, fmt.Errorf("invalid mpesa daraja webhook signature")
		}
	}

	var wrapper struct {
		Result struct {
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
	status := string(StatusFailed)
	eventType := "b2c.result.failed"
	if res.ResultCode == 0 {
		status = string(StatusSuccessful)
		eventType = "b2c.result.success"
	}
	amount := 0.0
	for _, p := range res.ResultParameters.ResultParameter {
		if p.Key == "TransactionAmount" {
			switch v := p.Value.(type) {
			case float64:
				amount = v
			case string:
				amount, _ = strconv.ParseFloat(v, 64)
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
		errMsg = res.ResultDesc
	}

	return &WebhookEvent{
		Rail:           RailMpesaDaraja,
		EventType:      eventType,
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: strconv.Itoa(res.ResultCode),
		Amount:         amount,
		Currency:       "KES",
		Error:          errMsg,
	}, nil
}
