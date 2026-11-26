package omnipayout

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"io"
	"net/http"
	"testing"
)

type roundTripFunc func(req *http.Request) *http.Response

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req), nil
}

func TestResolveRail(t *testing.T) {
	engine := NewEngine(Config{})

	rail1 := engine.ResolveRail(DisburseParams{
		Amount:          100,
		Currency:        "USD",
		StripeAccountID: "acct_123",
	})
	if rail1 != RailStripeConnect {
		t.Errorf("expected RailStripeConnect, got %s", rail1)
	}

	rail2 := engine.ResolveRail(DisburseParams{
		Amount:      50000,
		Currency:    "NGN",
		BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	if rail2 != RailFlutterwave {
		t.Errorf("expected RailFlutterwave, got %s", rail2)
	}
}

func TestDisburseStripeConnect(t *testing.T) {
	engine := NewEngine(Config{StripeSecretKey: "sk_test_mock"})
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewBufferString(`{"id":"tr_mock_999"}`)),
				Header:     make(http.Header),
			}
		}),
	}

	res, err := engine.Disburse(DisburseParams{
		Amount:          75.00,
		Currency:        "USD",
		Reference:       "REF-US-001",
		StripeAccountID: "acct_mock_123",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !res.Success || res.TransactionID != "tr_mock_999" || res.Rail != RailStripeConnect {
		t.Errorf("stripe disburse unexpected result: %+v", res)
	}
}

func TestDisburseFlutterwave(t *testing.T) {
	engine := NewEngine(Config{FlutterwaveSecretKey: "flw_mock_sec"})
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewBufferString(`{"status":"success","data":{"id":123456,"status":"SUCCESSFUL","fee":10.5}}`)),
				Header:     make(http.Header),
			}
		}),
	}

	res, err := engine.Disburse(DisburseParams{
		Amount:      25000,
		Currency:    "NGN",
		Reference:   "REF-NG-002",
		BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !res.Success || res.TransactionID != "123456" || res.Rail != RailFlutterwave {
		t.Errorf("flutterwave disburse unexpected result: %+v", res)
	}
}

func TestDisburseFlutterwavePendingAndFailed(t *testing.T) {
	engine := NewEngine(Config{FlutterwaveSecretKey: "flw_mock_sec"})

	// Accepted by API, not yet received by recipient (status: NEW)
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewBufferString(`{"status":"success","data":{"id":777111,"reference":"REF-NG-PENDING","status":"NEW","fee":10.5}}`)),
				Header:     make(http.Header),
			}
		}),
	}

	pendingRes, err := engine.Disburse(DisburseParams{
		Amount:      25000,
		Currency:    "NGN",
		Reference:   "REF-NG-PENDING",
		BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !pendingRes.Success || pendingRes.Status != string(StatusPending) || pendingRes.ProviderStatus != "NEW" || pendingRes.Reference != "REF-NG-PENDING" {
		t.Errorf("expected PENDING result with stable reference, got: %+v", pendingRes)
	}

	// Failed transfer must map to FAILED, not PENDING
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewBufferString(`{"status":"success","data":{"id":777222,"reference":"REF-NG-FAILED","status":"FAILED","complete_message":"Insufficient funds"}}`)),
				Header:     make(http.Header),
			}
		}),
	}

	failedRes, err := engine.Disburse(DisburseParams{
		Amount:      25000,
		Currency:    "NGN",
		Reference:   "REF-NG-FAILED",
		BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if failedRes.Success || failedRes.Status != string(StatusFailed) || failedRes.Error != "Insufficient funds" {
		t.Errorf("expected FAILED result, got: %+v", failedRes)
	}
}

func TestDisburseStripeInstantPendingAndIdempotentRetry(t *testing.T) {
	engine := NewEngine(Config{StripeSecretKey: "sk_test_mock"})

	var idempotencyKeys []string
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			idempotencyKeys = append(idempotencyKeys, req.Header.Get("Idempotency-Key"))
			if req.URL.Path == "/v1/transfers" {
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"id":"tr_retry_1"}`)),
					Header:     make(http.Header),
				}
			}
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewBufferString(`{"id":"po_retry_1","status":"in_transit"}`)),
				Header:     make(http.Header),
			}
		}),
	}

	params := DisburseParams{
		Amount:          120.00,
		Currency:        "USD",
		Reference:       "PAYOUT-RETRY-001",
		StripeAccountID: "acct_mock_123",
		Speed:           SpeedInstant,
	}

	first, err := engine.Disburse(params)
	if err != nil {
		t.Fatalf("unexpected error on first attempt: %v", err)
	}
	retry, err := engine.Disburse(params)
	if err != nil {
		t.Fatalf("unexpected error on retry: %v", err)
	}

	if !first.Success || first.Status != string(StatusPending) || first.ProviderStatus != "in_transit" {
		t.Errorf("expected PENDING/in_transit on accepted instant payout, got: %+v", first)
	}
	if retry.Reference != first.Reference || retry.TransactionID != first.TransactionID {
		t.Errorf("expected stable reference and txID on retry: first=%+v retry=%+v", first, retry)
	}

	wantKeys := []string{
		"PAYOUT-RETRY-001:transfer",
		"PAYOUT-RETRY-001:payout",
		"PAYOUT-RETRY-001:transfer",
		"PAYOUT-RETRY-001:payout",
	}
	if len(idempotencyKeys) != len(wantKeys) {
		t.Fatalf("expected %d requests, got %d", len(wantKeys), len(idempotencyKeys))
	}
	for i, want := range wantKeys {
		if idempotencyKeys[i] != want {
			t.Errorf("request %d idempotency key: want %q, got %q", i, want, idempotencyKeys[i])
		}
	}
}

func TestGetPayoutStatus(t *testing.T) {
	engine := NewEngine(Config{
		StripeSecretKey:      "sk_test_mock",
		FlutterwaveSecretKey: "flw_mock_sec",
	})

	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			if req.URL.Host == "api.stripe.com" {
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"id":"po_retry_1","status":"paid","amount":12000,"currency":"usd","metadata":{"reference":"PAYOUT-RETRY-001"}}`)),
					Header:     make(http.Header),
				}
			}
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewBufferString(`{"status":"success","data":{"id":777111,"reference":"REF-NG-PENDING","status":"SUCCESSFUL","amount":25000,"currency":"NGN","fee":10.5}}`)),
				Header:     make(http.Header),
			}
		}),
	}

	stripeRes, err := engine.GetPayoutStatus(PayoutStatusParams{
		TransactionID:   "po_retry_1",
		Rail:            RailStripeConnect,
		StripeAccountID: "acct_mock_123",
	})
	if err != nil {
		t.Fatalf("unexpected stripe status error: %v", err)
	}
	if stripeRes.Status != string(StatusSuccessful) || stripeRes.Reference != "PAYOUT-RETRY-001" || stripeRes.Amount != 120 {
		t.Errorf("unexpected stripe status result: %+v", stripeRes)
	}

	flwRes, err := engine.GetPayoutStatus(PayoutStatusParams{
		TransactionID: "777111",
		Rail:          RailFlutterwave,
	})
	if err != nil {
		t.Fatalf("unexpected flutterwave status error: %v", err)
	}
	if flwRes.Status != string(StatusSuccessful) || flwRes.Reference != "REF-NG-PENDING" {
		t.Errorf("unexpected flutterwave status result: %+v", flwRes)
	}
}

func TestDisburseFailoverOnInsufficientFloat(t *testing.T) {
	engine := NewEngine(Config{
		FlutterwaveSecretKey: "flw_mock_sec",
		PaystackSecretKey:    "sk_test_paystack",
	})

	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			switch {
			case req.URL.Host == "api.flutterwave.com" && req.URL.Path == "/v3/balances":
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":"success","data":[{"currency":"NGN","available_balance":5000,"ledger_balance":5000}]}`)),
					Header:     make(http.Header),
				}
			case req.URL.Host == "api.paystack.co" && req.URL.Path == "/balance":
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":true,"data":[{"currency":"NGN","balance":10000000}]}`)),
					Header:     make(http.Header),
				}
			case req.URL.Host == "api.paystack.co" && req.URL.Path == "/transferrecipient":
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"recipient_code":"RCP_go_1"}}`)),
					Header:     make(http.Header),
				}
			default:
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"transfer_code":"TRF_go_1","reference":"PAYOUT-FAILOVER-GO","status":"pending"}}`)),
					Header:     make(http.Header),
				}
			}
		}),
	}

	res, err := engine.Disburse(DisburseParams{
		Amount:                     45000,
		Currency:                   "NGN",
		Reference:                  "PAYOUT-FAILOVER-GO",
		Rail:                       RailFlutterwave,
		FallbackRails:              []PayoutRail{RailPaystack},
		CheckBalanceBeforeDisburse: true,
		BankDetails:                &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	if err != nil {
		t.Fatalf("unexpected failover error: %v", err)
	}
	if res.Rail != RailPaystack || res.FailoverFrom != RailFlutterwave || res.Reference != "PAYOUT-FAILOVER-GO" || len(res.AttemptedRails) != 2 {
		t.Errorf("unexpected failover result: %+v", res)
	}
}

func TestVerifyWebhooks(t *testing.T) {
	engine := NewEngine(Config{
		StripeSecretKey:          "sk_test_mock",
		StripeWebhookSecret:      "whsec_go_test",
		FlutterwaveSecretKey:     "flw_mock",
		FlutterwaveWebhookSecret: "flw_go_hash",
		PaystackSecretKey:        "sk_ps_mock",
		PaystackWebhookSecret:    "ps_go_secret",
	})

	// Stripe webhook
	stripeBody := []byte(`{"type":"payout.paid","data":{"object":{"id":"po_go_1","status":"paid","amount":15000,"currency":"usd","metadata":{"reference":"REF-GO-STRIPE"}}}}`)
	ts := "1700000000"
	mac256 := hmac.New(sha256.New, []byte("whsec_go_test"))
	mac256.Write([]byte(ts + "."))
	mac256.Write(stripeBody)
	stripeEv, err := engine.VerifyWebhook(RailStripeConnect, stripeBody, "t="+ts+",v1="+hex.EncodeToString(mac256.Sum(nil)))
	if err != nil {
		t.Fatalf("unexpected stripe webhook error: %v", err)
	}
	if stripeEv.Status != string(StatusSuccessful) || stripeEv.Reference != "REF-GO-STRIPE" || stripeEv.Amount != 150 {
		t.Errorf("unexpected stripe webhook event: %+v", stripeEv)
	}

	// Flutterwave webhook
	flwBody := []byte(`{"event":"transfer.completed","data":{"id":9911,"reference":"REF-GO-FLW","status":"SUCCESSFUL","amount":45000,"currency":"NGN"}}`)
	flwEv, err := engine.VerifyWebhook(RailFlutterwave, flwBody, "flw_go_hash")
	if err != nil {
		t.Fatalf("unexpected flutterwave webhook error: %v", err)
	}
	if flwEv.Status != string(StatusSuccessful) || flwEv.Reference != "REF-GO-FLW" {
		t.Errorf("unexpected flutterwave webhook event: %+v", flwEv)
	}

	// Paystack webhook
	psBody := []byte(`{"event":"transfer.success","data":{"transfer_code":"TRF_go_wh","reference":"REF-GO-PS","status":"success","amount":4500000,"currency":"NGN"}}`)
	mac512 := hmac.New(sha512.New, []byte("ps_go_secret"))
	mac512.Write(psBody)
	psEv, err := engine.VerifyWebhook(RailPaystack, psBody, hex.EncodeToString(mac512.Sum(nil)))
	if err != nil {
		t.Fatalf("unexpected paystack webhook error: %v", err)
	}
	if psEv.Status != string(StatusSuccessful) || psEv.Reference != "REF-GO-PS" || psEv.Amount != 45000 {
		t.Errorf("unexpected paystack webhook event: %+v", psEv)
	}

	if _, err := engine.VerifyWebhook(RailPaystack, psBody, "invalid-sig"); err == nil {
		t.Errorf("expected error for invalid paystack webhook signature")
	}
}
