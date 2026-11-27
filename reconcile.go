package omnipayout

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ExportSettlements exports provider settlement records using context.Background().
func (e *Engine) ExportSettlements(params SettlementExportParams) ([]SettlementRecord, error) {
	return e.ExportSettlementsContext(context.Background(), params)
}

// ExportSettlementsContext independently exports payout records for a date range directly from
// a specified provider (or concurrently across all configured bulk-exportable providers).
func (e *Engine) ExportSettlementsContext(ctx context.Context, params SettlementExportParams) ([]SettlementRecord, error) {
	if params.From.IsZero() || params.To.IsZero() || params.From.After(params.To) {
		return nil, fmt.Errorf("valid From and To timestamps (From <= To) are required for settlement export")
	}

	fetchForRail := func(rail PayoutRail) ([]SettlementRecord, error) {
		return withRetry(ctx, e.config.Retry, func() ([]SettlementRecord, error) {
			pCtx, cancel := e.providerContext(ctx, rail)
			defer cancel()
			switch rail {
			case RailStripeConnect:
				return e.exportStripeSettlements(pCtx, params)
			case RailFlutterwave:
				return e.exportFlutterwaveSettlements(pCtx, params)
			case RailPaystack:
				return e.exportPaystackSettlements(pCtx, params)
			case RailYellowCard:
				return e.exportYellowCardSettlements(pCtx, params)
			default:
				return nil, &ProviderError{
					Rail:    rail,
					Code:    ErrProvider,
					Message: fmt.Sprintf("bulk settlement export is not supported directly by %s; reconcile individual references via GetPayoutStatus", rail),
				}
			}
		}, nil)
	}

	if params.Rail != "" {
		return fetchForRail(params.Rail)
	}

	var exportable []PayoutRail
	if e.config.StripeSecretKey != "" {
		exportable = append(exportable, RailStripeConnect)
	}
	if e.config.FlutterwaveSecretKey != "" {
		exportable = append(exportable, RailFlutterwave)
	}
	if e.config.PaystackSecretKey != "" {
		exportable = append(exportable, RailPaystack)
	}
	if e.config.YellowCardAPIKey != "" && e.config.YellowCardSecretKey != "" {
		exportable = append(exportable, RailYellowCard)
	}

	type batchRes struct {
		records []SettlementRecord
		err     error
	}
	results := make([]batchRes, len(exportable))
	var wg sync.WaitGroup
	for i, r := range exportable {
		wg.Add(1)
		go func(idx int, target PayoutRail) {
			defer wg.Done()
			recs, err := fetchForRail(target)
			results[idx] = batchRes{records: recs, err: err}
		}(i, r)
	}
	wg.Wait()

	var all []SettlementRecord
	for _, r := range results {
		if r.err != nil {
			return nil, r.err
		}
		all = append(all, r.records...)
	}
	return all, nil
}

func (e *Engine) exportStripeSettlements(ctx context.Context, params SettlementExportParams) ([]SettlementRecord, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}
	limit := params.Limit
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	q := url.Values{}
	q.Set("created[gte]", strconv.FormatInt(params.From.Unix(), 10))
	q.Set("created[lte]", strconv.FormatInt(params.To.Unix(), 10))
	q.Set("limit", strconv.Itoa(limit))

	isPayouts := params.StripeAccountID != ""
	endpoint := "https://api.stripe.com/v1/transfers?" + q.Encode()
	if isPayouts {
		endpoint = "https://api.stripe.com/v1/payouts?" + q.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
	if isPayouts {
		req.Header.Set("Stripe-Account", params.StripeAccountID)
	}

	resp, err := e.httpClient.Do(req)
	if err != nil {
		pErr := newProviderError(RailStripeConnect, 0, err.Error(), false)
		pErr.Retryable = true
		return nil, pErr
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var data struct {
		Data []struct {
			ID       string            `json:"id"`
			Status   string            `json:"status"`
			Amount   int64             `json:"amount"`
			Fee      int64             `json:"fee"`
			Currency string            `json:"currency"`
			Created  int64             `json:"created"`
			Metadata map[string]string `json:"metadata"`
		} `json:"data"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(bodyBytes, &data)
	if resp.StatusCode >= 400 || data.Error != nil {
		msg := "stripe settlement export failed"
		if data.Error != nil && data.Error.Message != "" {
			msg = data.Error.Message
		}
		return nil, newProviderError(RailStripeConnect, resp.StatusCode, msg, false)
	}

	defStatus := StatusSuccessful
	if isPayouts {
		defStatus = StatusPending
	}
	out := make([]SettlementRecord, 0, len(data.Data))
	for _, row := range data.Data {
		cur := strings.ToUpper(row.Currency)
		if cur == "" {
			cur = "USD"
		}
		ref := row.Metadata["reference"]
		if ref == "" {
			ref = row.ID
		}
		var createdAt *time.Time
		if row.Created > 0 {
			t := time.Unix(row.Created, 0).UTC()
			createdAt = &t
		}
		out = append(out, SettlementRecord{
			Rail:           RailStripeConnect,
			TransactionID:  row.ID,
			Reference:      ref,
			Status:         normalizeStripeStatus(row.Status, defStatus),
			ProviderStatus: row.Status,
			Amount:         fromMinorUnits(row.Amount, cur),
			Currency:       cur,
			Fee:            fromMinorUnits(row.Fee, cur),
			CreatedAt:      createdAt,
		})
	}
	return out, nil
}

func (e *Engine) exportFlutterwaveSettlements(ctx context.Context, params SettlementExportParams) ([]SettlementRecord, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is not configured")
	}
	q := url.Values{}
	q.Set("from", params.From.UTC().Format("2006-01-02"))
	q.Set("to", params.To.UTC().Format("2006-01-02"))

	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.flutterwave.com/v3/transfers?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.FlutterwaveSecretKey)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		pErr := newProviderError(RailFlutterwave, 0, err.Error(), false)
		pErr.Retryable = true
		return nil, pErr
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var flwResp struct {
		Status  string `json:"status"`
		Message string `json:"message"`
		Data    []struct {
			ID        int64   `json:"id"`
			Reference string  `json:"reference"`
			Status    string  `json:"status"`
			Amount    float64 `json:"amount"`
			Currency  string  `json:"currency"`
			Fee       float64 `json:"fee"`
			CreatedAt string  `json:"created_at"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &flwResp)
	if resp.StatusCode >= 400 || flwResp.Status == "error" {
		return nil, newProviderError(RailFlutterwave, resp.StatusCode, "flutterwave settlement export error: "+flwResp.Message, false)
	}

	out := make([]SettlementRecord, 0, len(flwResp.Data))
	for _, row := range flwResp.Data {
		txID := strconv.FormatInt(row.ID, 10)
		ref := row.Reference
		if ref == "" {
			ref = txID
		}
		var createdAt *time.Time
		if parsed, pErr := time.Parse(time.RFC3339, row.CreatedAt); pErr == nil {
			createdAt = &parsed
		}
		out = append(out, SettlementRecord{
			Rail:           RailFlutterwave,
			TransactionID:  txID,
			Reference:      ref,
			Status:         normalizeFlutterwaveStatus(row.Status),
			ProviderStatus: row.Status,
			Amount:         row.Amount,
			Currency:       strings.ToUpper(row.Currency),
			Fee:            row.Fee,
			CreatedAt:      createdAt,
		})
	}
	return out, nil
}

func (e *Engine) exportPaystackSettlements(ctx context.Context, params SettlementExportParams) ([]SettlementRecord, error) {
	if e.config.PaystackSecretKey == "" {
		return nil, fmt.Errorf("paystack secret key is not configured")
	}
	limit := params.Limit
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	q := url.Values{}
	q.Set("from", params.From.UTC().Format(time.RFC3339))
	q.Set("to", params.To.UTC().Format(time.RFC3339))
	q.Set("perPage", strconv.Itoa(limit))

	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.paystack.co/transfer?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.PaystackSecretKey)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		pErr := newProviderError(RailPaystack, 0, err.Error(), false)
		pErr.Retryable = true
		return nil, pErr
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var psResp struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    []struct {
			ID           int64  `json:"id"`
			TransferCode string `json:"transfer_code"`
			Reference    string `json:"reference"`
			Status       string `json:"status"`
			Amount       int64  `json:"amount"`
			Fee          int64  `json:"fee"`
			Currency     string `json:"currency"`
			CreatedAt    string `json:"createdAt"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &psResp)
	if resp.StatusCode >= 400 || !psResp.Status {
		return nil, newProviderError(RailPaystack, resp.StatusCode, "paystack settlement export error: "+psResp.Message, false)
	}

	out := make([]SettlementRecord, 0, len(psResp.Data))
	for _, row := range psResp.Data {
		cur := strings.ToUpper(row.Currency)
		if cur == "" {
			cur = "NGN"
		}
		txID := row.TransferCode
		if txID == "" {
			txID = strconv.FormatInt(row.ID, 10)
		}
		ref := row.Reference
		if ref == "" {
			ref = txID
		}
		var createdAt *time.Time
		if parsed, pErr := time.Parse(time.RFC3339, row.CreatedAt); pErr == nil {
			createdAt = &parsed
		}
		out = append(out, SettlementRecord{
			Rail:           RailPaystack,
			TransactionID:  txID,
			Reference:      ref,
			Status:         normalizePaystackStatus(row.Status),
			ProviderStatus: row.Status,
			Amount:         fromMinorUnits(row.Amount, cur),
			Currency:       cur,
			Fee:            fromMinorUnits(row.Fee, cur),
			CreatedAt:      createdAt,
		})
	}
	return out, nil
}

func (e *Engine) exportYellowCardSettlements(ctx context.Context, params SettlementExportParams) ([]SettlementRecord, error) {
	if e.config.YellowCardAPIKey == "" || e.config.YellowCardSecretKey == "" {
		return nil, fmt.Errorf("yellow card apiKey and secretKey are required")
	}
	q := url.Values{}
	q.Set("startDate", params.From.UTC().Format(time.RFC3339))
	q.Set("endDate", params.To.UTC().Format(time.RFC3339))

	respBytes, statusCode, err := e.yellowCardRequest(ctx, "GET", "/business/payments?"+q.Encode(), nil, false)
	if err != nil {
		return nil, err
	}
	if statusCode >= 400 {
		return nil, newProviderError(RailYellowCard, statusCode, fmt.Sprintf("yellow card settlement export failed with status %d", statusCode), false)
	}

	var data struct {
		Payments []struct {
			ID          string  `json:"id"`
			SequenceID  string  `json:"sequenceId"`
			Status      string  `json:"status"`
			LocalAmount float64 `json:"localAmount"`
			Amount      float64 `json:"amount"`
			Fee         float64 `json:"fee"`
			ServiceFee  float64 `json:"serviceFee"`
			Currency    string  `json:"currency"`
			CreatedAt   string  `json:"createdAt"`
		} `json:"payments"`
	}
	_ = json.Unmarshal(respBytes, &data)

	out := make([]SettlementRecord, 0, len(data.Payments))
	for _, row := range data.Payments {
		amt := row.LocalAmount
		if amt == 0 {
			amt = row.Amount
		}
		fee := row.Fee
		if fee == 0 {
			fee = row.ServiceFee
		}
		ref := row.SequenceID
		if ref == "" {
			ref = row.ID
		}
		var createdAt *time.Time
		if parsed, pErr := time.Parse(time.RFC3339, row.CreatedAt); pErr == nil {
			createdAt = &parsed
		}
		out = append(out, SettlementRecord{
			Rail:           RailYellowCard,
			TransactionID:  row.ID,
			Reference:      ref,
			Status:         normalizeYellowCardStatus(row.Status),
			ProviderStatus: row.Status,
			Amount:         amt,
			Currency:       strings.ToUpper(row.Currency),
			Fee:            fee,
			CreatedAt:      createdAt,
		})
	}
	return out, nil
}

// ReconcileBatch performs a pure, stateless two-path audit diff ("two paths, same numbers")
// comparing local ledger records (including AMBIGUOUS / PENDING payouts) against provider exports.
func ReconcileBatch(localRecords []LocalLedgerRecord, providerRecords []SettlementRecord) ReconciliationReport {
	providerByRef := make(map[string]SettlementRecord, len(providerRecords))
	totalProvAmt := 0.0
	totalProvFees := 0.0
	for _, p := range providerRecords {
		ref := strings.TrimSpace(p.Reference)
		if ref == "" {
			ref = strings.TrimSpace(p.TransactionID)
		}
		if ref != "" {
			providerByRef[ref] = p
		}
		totalProvAmt += p.Amount
		totalProvFees += p.Fee
	}

	var matched []ReconciliationMatch
	var statusMismatches []ReconciliationMismatch
	var amountMismatches []ReconciliationMismatch
	var missingOnProvider []LocalLedgerRecord
	seenProv := make(map[string]bool, len(localRecords))
	totalLocalAmt := 0.0
	resolvedAmbiguous := 0

	for _, local := range localRecords {
		ref := strings.TrimSpace(local.Reference)
		totalLocalAmt += local.Amount
		prov, ok := providerByRef[ref]
		if !ok {
			missingOnProvider = append(missingOnProvider, local)
			continue
		}
		seenProv[ref] = true

		localCur := strings.ToUpper(local.Currency)
		provCur := strings.ToUpper(prov.Currency)
		amountDiff := math.Abs(local.Amount-prov.Amount) > 0.01 || (localCur != "" && provCur != "" && localCur != provCur)
		statusDiff := local.Status != prov.Status

		if local.Status == string(IdempotencyAmbiguous) {
			resolvedAmbiguous++
		}

		if amountDiff {
			amountMismatches = append(amountMismatches, ReconciliationMismatch{
				Reference: ref,
				Local:     local,
				Provider:  prov,
				Reason:    fmt.Sprintf("local %.2f %s != provider %.2f %s", local.Amount, localCur, prov.Amount, provCur),
			})
		} else if statusDiff {
			reason := fmt.Sprintf("local status %s != provider status %s", local.Status, prov.Status)
			if local.Status == string(IdempotencyAmbiguous) {
				reason = fmt.Sprintf("resolved AMBIGUOUS payout: provider status is %s", prov.Status)
			}
			statusMismatches = append(statusMismatches, ReconciliationMismatch{
				Reference: ref,
				Local:     local,
				Provider:  prov,
				Reason:    reason,
			})
		} else {
			matched = append(matched, ReconciliationMatch{Local: local, Provider: prov})
		}
	}

	var missingInLedger []SettlementRecord
	for _, p := range providerRecords {
		ref := strings.TrimSpace(p.Reference)
		if ref == "" {
			ref = strings.TrimSpace(p.TransactionID)
		}
		if !seenProv[ref] {
			missingInLedger = append(missingInLedger, p)
		}
	}

	discrepancies := len(statusMismatches) + len(amountMismatches) + len(missingOnProvider) + len(missingInLedger)
	return ReconciliationReport{
		Matched:           matched,
		StatusMismatches:  statusMismatches,
		AmountMismatches:  amountMismatches,
		MissingOnProvider: missingOnProvider,
		MissingInLedger:   missingInLedger,
		Summary: ReconciliationSummary{
			TotalLocalCount:        len(localRecords),
			TotalProviderCount:     len(providerRecords),
			MatchedCount:           len(matched),
			DiscrepancyCount:       discrepancies,
			ResolvedAmbiguousCount: resolvedAmbiguous,
			TotalLocalAmount:       math.Round(totalLocalAmt*100) / 100,
			TotalProviderAmount:    math.Round(totalProvAmt*100) / 100,
			TotalProviderFees:      math.Round(totalProvFees*100) / 100,
		},
	}
}

// ReconcileBatch delegates to the package-level ReconcileBatch helper.
func (e *Engine) ReconcileBatch(localRecords []LocalLedgerRecord, providerRecords []SettlementRecord) ReconciliationReport {
	return ReconcileBatch(localRecords, providerRecords)
}

func sanitizeCSVCell(s string) string {
	if len(s) > 0 {
		switch s[0] {
		case '=', '+', '-', '@', '\t', '\r':
			return "'" + s
		}
	}
	return s
}

// FormatSettlementsCSV formats SettlementRecords as RFC 4180 CSV with formula-injection protection.
func FormatSettlementsCSV(records []SettlementRecord) string {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"rail", "transactionId", "reference", "status", "providerStatus", "amount", "currency", "fee", "createdAt"})
	for _, r := range records {
		created := ""
		if r.CreatedAt != nil {
			created = r.CreatedAt.UTC().Format(time.RFC3339)
		}
		feeStr := ""
		if r.Fee != 0 {
			feeStr = strconv.FormatFloat(r.Fee, 'f', -1, 64)
		}
		_ = w.Write([]string{
			sanitizeCSVCell(string(r.Rail)),
			sanitizeCSVCell(r.TransactionID),
			sanitizeCSVCell(r.Reference),
			sanitizeCSVCell(r.Status),
			sanitizeCSVCell(r.ProviderStatus),
			strconv.FormatFloat(r.Amount, 'f', -1, 64),
			sanitizeCSVCell(r.Currency),
			feeStr,
			created,
		})
	}
	w.Flush()
	return strings.TrimRight(buf.String(), "\n")
}

// FormatSettlementsCSV delegates to the package-level FormatSettlementsCSV helper.
func (e *Engine) FormatSettlementsCSV(records []SettlementRecord) string {
	return FormatSettlementsCSV(records)
}
