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
