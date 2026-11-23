package omnipayout

import (
	"bytes"
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
