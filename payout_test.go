package omnipayout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
	ts := strconv.FormatInt(time.Now().Unix(), 10)
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

	// Reject stale Stripe webhook timestamp (> 300s old)
	staleTs := strconv.FormatInt(time.Now().Unix()-600, 10)
	staleMac := hmac.New(sha256.New, []byte("whsec_go_test"))
	staleMac.Write([]byte(staleTs + "."))
	staleMac.Write(stripeBody)
	if _, err := engine.VerifyWebhook(RailStripeConnect, stripeBody, "t="+staleTs+",v1="+hex.EncodeToString(staleMac.Sum(nil))); err == nil {
		t.Errorf("expected replay protection error for stale stripe webhook")
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

func TestPawaPayYellowCardMpesaAndCircuitBreaker(t *testing.T) {
	engine := NewEngine(Config{
		FlutterwaveSecretKey: "flw_mock",
		PaystackSecretKey:    "ps_mock",
		PawaPayAPIToken:      "pp_mock",
		YellowCardAPIKey:     "yc_key",
		YellowCardSecretKey:  "yc_secret",
		MpesaDaraja: &MpesaDarajaConfig{
			ConsumerKey:        "mpesa_key",
			ConsumerSecret:     "mpesa_secret",
			ShortCode:          "600999",
			InitiatorName:      "testapi",
			SecurityCredential: "cred",
			ResultURL:          "https://example.com/result",
			QueueTimeoutURL:    "https://example.com/timeout",
		},
		Health: &HealthConfig{FailureThreshold: 2},
	})

	flwCalls := 0
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			switch req.URL.Host {
			case "api.pawapay.io":
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"payoutId":"PP-GO-1","status":"ACCEPTED"}`)),
					Header:     make(http.Header),
				}
			case "api.yellowcard.io":
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"id":"yc_1","sequenceId":"YC-GO-1","status":"processing"}`)),
					Header:     make(http.Header),
				}
			case "api.safaricom.co.ke":
				if req.URL.Path == "/oauth/v1/generate" {
					return &http.Response{
						StatusCode: 200,
						Body:       io.NopCloser(bytes.NewBufferString(`{"access_token":"tok_123"}`)),
						Header:     make(http.Header),
					}
				}
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"ResponseCode":"0","ConversationID":"AG_1","OriginatorConversationID":"MP-GO-1"}`)),
					Header:     make(http.Header),
				}
			case "api.flutterwave.com":
				flwCalls++
				return &http.Response{
					StatusCode: 503,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":"error","message":"timeout"}`)),
					Header:     make(http.Header),
				}
			default: // Paystack
				if req.URL.Path == "/transferrecipient" {
					return &http.Response{
						StatusCode: 200,
						Body:       io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"recipient_code":"RCP_cb"}}`)),
						Header:     make(http.Header),
					}
				}
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"transfer_code":"TRF_cb","reference":"CB-GO","status":"pending"}}`)),
					Header:     make(http.Header),
				}
			}
		}),
	}

	ppRes, err := engine.Disburse(DisburseParams{
		Amount: 2500, Currency: "KES", Reference: "PP-GO-1", Rail: RailPawaPay,
		MobileMoneyDetails: &MobileMoneyDetails{Phone: "254712345678", Network: "MPESA"},
	})
	if err != nil || ppRes.Rail != RailPawaPay || ppRes.Status != string(StatusPending) {
		t.Fatalf("unexpected pawapay result: %+v, err=%v", ppRes, err)
	}

	ycRes, err := engine.Disburse(DisburseParams{
		Amount: 50000, Currency: "NGN", Reference: "YC-GO-1", Rail: RailYellowCard,
		BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	if err != nil || ycRes.Rail != RailYellowCard || ycRes.Status != string(StatusPending) {
		t.Fatalf("unexpected yellowcard result: %+v, err=%v", ycRes, err)
	}

	mpRes, err := engine.Disburse(DisburseParams{
		Amount: 1500, Currency: "KES", Reference: "MP-GO-1", Rail: RailMpesaDaraja,
		MobileMoneyDetails: &MobileMoneyDetails{Phone: "254712345678", Network: "MPESA"},
	})
	if err != nil || mpRes.Rail != RailMpesaDaraja || mpRes.Status != string(StatusPending) {
		t.Fatalf("unexpected mpesa result: %+v, err=%v", mpRes, err)
	}

	// Trip Flutterwave circuit breaker (2 failures)
	_, _ = engine.Disburse(DisburseParams{Amount: 5000, Currency: "NGN", Reference: "CB-1", Rail: RailFlutterwave, BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"}})
	_, _ = engine.Disburse(DisburseParams{Amount: 5000, Currency: "NGN", Reference: "CB-2", Rail: RailFlutterwave, BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"}})

	health := engine.GetRailHealth(RailFlutterwave)
	if len(health) != 1 || !health[0].CircuitOpen || health[0].Healthy {
		t.Fatalf("expected Flutterwave circuit breaker to be open, got: %+v", health)
	}

	// Next payout with fallback proactively skips Flutterwave (flwCalls remains 2)
	cbRes, err := engine.Disburse(DisburseParams{
		Amount: 5000, Currency: "NGN", Reference: "CB-GO",
		Rail: RailFlutterwave, FallbackRails: []PayoutRail{RailPaystack},
		BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	if err != nil || flwCalls != 2 || cbRes.Rail != RailPaystack || cbRes.FailoverFrom != RailFlutterwave {
		t.Fatalf("expected proactive circuit-breaker failover to Paystack, flwCalls=%d res=%+v err=%v", flwCalls, cbRes, err)
	}
}

func TestTimeoutSafeFailoverZeroDecimalAndSecurityHardening(t *testing.T) {
	cfg := Config{
		StripeSecretKey:      "sk_secret_do_not_leak",
		FlutterwaveSecretKey: "flw_secret_do_not_leak",
		PaystackSecretKey:    "ps_secret_do_not_leak",
		PawaPayAPIToken:      "pp_secret_do_not_leak",
		MpesaDaraja: &MpesaDarajaConfig{
			ConsumerKey:        "mp_key_secret",
			ConsumerSecret:     "mp_sec_secret",
			ShortCode:          "600999",
			InitiatorName:      "init",
			SecurityCredential: "cred_secret",
			ResultURL:          "https://example.com/res",
			QueueTimeoutURL:    "https://example.com/to",
		},
	}
	engine := NewEngine(cfg)

	// 1. Secret redaction in fmt and JSON
	if strings.Contains(fmt.Sprintf("%v %s", cfg, engine), "do_not_leak") {
		t.Fatalf("secrets leaked in String() output")
	}
	cfgJSON, _ := json.Marshal(cfg)
	if strings.Contains(string(cfgJSON), "do_not_leak") || strings.Contains(string(cfgJSON), "mp_sec_secret") {
		t.Fatalf("secrets leaked in json.Marshal(Config): %s", string(cfgJSON))
	}

	// 2. Input sanitization (NaN, CRLF, path traversal, unsigned webhook)
	if _, err := engine.Disburse(DisburseParams{Amount: math.NaN(), Currency: "USD", Reference: "R1", StripeAccountID: "acct_1"}); err == nil {
		t.Fatalf("expected error for NaN amount")
	}
	if _, err := engine.Disburse(DisburseParams{Amount: 10, Currency: "USD", Reference: "R1\r\nEvil:1", StripeAccountID: "acct_1"}); err == nil {
		t.Fatalf("expected error for control chars in reference")
	}
	if _, err := engine.GetPayoutStatus(PayoutStatusParams{TransactionID: "../../charges", Rail: RailStripeConnect}); err == nil {
		t.Fatalf("expected error for path traversal transactionId")
	}
	if _, err := engine.VerifyWebhook(RailPawaPay, []byte(`{}`), "sig"); err == nil {
		t.Fatalf("expected error when PawaPayWebhookSecret is unconfigured")
	}

	// 3. Ambiguous 504 on Flutterwave halts failover (Paystack is NOT called)
	psCalled := false
	oauthCalls := 0
	var stripeForm string
	var pawaPayBody map[string]interface{}

	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			switch req.URL.Host {
			case "api.flutterwave.com":
				return &http.Response{
					StatusCode: 504,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":"error","message":"gateway timeout"}`)),
					Header:     make(http.Header),
				}
			case "api.paystack.co":
				psCalled = true
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":true}`)), Header: make(http.Header)}
			case "api.stripe.com":
				b, _ := io.ReadAll(req.Body)
				stripeForm = string(b)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"id":"tr_rwf_1"}`)), Header: make(http.Header)}
			case "api.pawapay.io":
				b, _ := io.ReadAll(req.Body)
				_ = json.Unmarshal(b, &pawaPayBody)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":"ACCEPTED"}`)), Header: make(http.Header)}
			default: // Safaricom M-Pesa OAuth caching check
				if req.URL.Path == "/oauth/v1/generate" {
					oauthCalls++
					return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"access_token":"cached_tok","expires_in":"3599"}`)), Header: make(http.Header)}
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"ResponseCode":"0","ConversationID":"AG_CACHE"}`)), Header: make(http.Header)}
			}
		}),
	}

	_, err := engine.Disburse(DisburseParams{
		Amount: 20000, Currency: "NGN", Reference: "AMB-GO-1",
		Rail: RailFlutterwave, FallbackRails: []PayoutRail{RailPaystack},
		BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"},
	})
	var ambErr *AmbiguousPayoutError
	if !errors.As(err, &ambErr) || psCalled {
		t.Fatalf("expected AmbiguousPayoutError and zero Paystack calls, err=%v psCalled=%v", err, psCalled)
	}

	// 4. Zero-decimal RWF on Stripe (5000 RWF -> amount=5000, not 500000)
	if _, err := engine.Disburse(DisburseParams{Amount: 5000, Currency: "RWF", Reference: "RWF-1", StripeAccountID: "acct_1"}); err != nil {
		t.Fatalf("unexpected RWF error: %v", err)
	}
	if !strings.Contains(stripeForm, "amount=5000") || strings.Contains(stripeForm, "amount=500000") {
		t.Fatalf("expected zero-decimal amount=5000, got form: %s", stripeForm)
	}

	// 5. PawaPay deterministic UUID conversion with stable original Reference
	ppRes, err := engine.Disburse(DisburseParams{
		Amount: 1500, Currency: "KES", Reference: "HUMAN-REF-GO", Rail: RailPawaPay,
		MobileMoneyDetails: &MobileMoneyDetails{Phone: "254712345678", Network: "MPESA"},
	})
	if err != nil || ppRes.Reference != "HUMAN-REF-GO" || !uuidRegex.MatchString(fmt.Sprint(pawaPayBody["payoutId"])) {
		t.Fatalf("expected deterministic UUID payoutId and preserved reference, res=%+v body=%+v err=%v", ppRes, pawaPayBody, err)
	}

	// 6. M-Pesa OAuth token cache: 2 disbursements -> only 1 OAuth request
	_, _ = engine.Disburse(DisburseParams{Amount: 1000, Currency: "KES", Reference: "MP-C1", Rail: RailMpesaDaraja, MobileMoneyDetails: &MobileMoneyDetails{Phone: "254712345678", Network: "MPESA"}})
	_, _ = engine.Disburse(DisburseParams{Amount: 1000, Currency: "KES", Reference: "MP-C2", Rail: RailMpesaDaraja, MobileMoneyDetails: &MobileMoneyDetails{Phone: "254712345678", Network: "MPESA"}})
	if oauthCalls != 1 {
		t.Fatalf("expected M-Pesa OAuth token to be cached (1 call), got %d calls", oauthCalls)
	}
}

func TestV150DeveloperPainPointFixes(t *testing.T) {
	// 1. MSISDN normalization
	msisdn1, err := NormalizeMSISDN("+254 712-345-678", "KES")
	if err != nil || msisdn1 != "254712345678" {
		t.Fatalf("expected 254712345678, got %q err=%v", msisdn1, err)
	}
	msisdn2, err := NormalizeMSISDN("0712345678", "KES")
	if err != nil || msisdn2 != "254712345678" {
		t.Fatalf("expected 254712345678 from local 07..., got %q err=%v", msisdn2, err)
	}

	// 2. M-Pesa RSA PKCS#1 v1.5 SecurityCredential encryption
	privKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa keygen failed: %v", err)
	}
	pubDER, _ := x509.MarshalPKIXPublicKey(&privKey.PublicKey)
	pubPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}))
	credB64, err := EncryptMpesaInitiatorPassword("SafaricomGoPass!", pubPEM)
	if err != nil {
		t.Fatalf("encrypt initiator password failed: %v", err)
	}
	cipherBytes, _ := base64.StdEncoding.DecodeString(credB64)
	plainBytes, err := rsa.DecryptPKCS1v15(rand.Reader, privKey, cipherBytes)
	if err != nil || string(plainBytes) != "SafaricomGoPass!" {
		t.Fatalf("decrypted initiator password mismatch: %q err=%v", string(plainBytes), err)
	}

	// 3. Name matching & FSM transition guard & code mapping
	nm := MatchAccountNames("Chief Peter Chukwu", "CHUKWU CHIJIOKE PETER", 0.66)
	if !nm.Matched || nm.Score < 0.8 {
		t.Fatalf("expected name match, got %+v", nm)
	}
	if CanTransitionStatus(string(StatusSuccessful), string(StatusPending), false) {
		t.Fatalf("expected SUCCESSFUL -> PENDING regression to be blocked")
	}
	if ResolveProviderCode("VODAFONE", "GHS", RailPaystack, true) != "VOD" {
		t.Fatalf("expected VOD for Paystack GHS Vodafone")
	}
	if ResolveProviderCode("GCB", "GHS", RailFlutterwave, false) != "GH040100" {
		t.Fatalf("expected GH040100 for Flutterwave GCB GHS")
	}

	// 4. Bank resolution failover (Flutterwave 503 -> Paystack 200), M-Pesa QueueTimeout, and VerifyAndConfirmWebhook
	engine := NewEngine(Config{
		FlutterwaveSecretKey:  "flw_k",
		PaystackSecretKey:     "ps_k",
		PaystackWebhookSecret: "ps_wh_sec",
		MpesaDaraja: &MpesaDarajaConfig{
			ConsumerKey:       "mk",
			ConsumerSecret:    "ms",
			ShortCode:         "600999",
			InitiatorName:     "init",
			InitiatorPassword: "SafaricomGoPass!",
			CertificatePEM:    pubPEM,
			ResultURL:         "https://example.com/res",
			QueueTimeoutURL:   "https://example.com/to",
			WebhookSecret:     "mp_wh_sec",
		},
	})

	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			if req.URL.Host == "api.flutterwave.com" {
				return &http.Response{StatusCode: 503, Body: io.NopCloser(bytes.NewBufferString(`{"status":"error"}`)), Header: make(http.Header)}
			}
			if strings.HasPrefix(req.URL.Path, "/bank/resolve") {
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"account_name":"CHUKWU CHIJIOKE PETER","account_number":"0123456789"}}`)),
					Header:     make(http.Header),
				}
			}
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"transfer_code":"TRF_conf_go","reference":"REF-CONF-GO","status":"success","amount":2000000,"currency":"NGN"}}`)),
				Header:     make(http.Header),
			}
		}),
	}

	bankRes, err := engine.ResolveBankAccount("058", "0123456789")
	if err != nil || bankRes.AccountName != "CHUKWU CHIJIOKE PETER" {
		t.Fatalf("expected bank resolution failover to Paystack, got %+v err=%v", bankRes, err)
	}

	toBody := []byte(`{"Result":{"ResultCode":1037,"ResultDesc":"Queue timeout","OriginatorConversationID":"MP-TO-1"}}`)
	toEv, err := engine.VerifyWebhook(RailMpesaDaraja, toBody, "mp_wh_sec")
	if err != nil || toEv.EventType != "b2c.result.timeout" || toEv.ProviderStatus != "QUEUE_TIMEOUT" {
		t.Fatalf("expected M-Pesa QUEUE_TIMEOUT event, got %+v err=%v", toEv, err)
	}

	psWhBody := []byte(`{"event":"transfer.success","data":{"transfer_code":"TRF_conf_go","reference":"REF-CONF-GO","status":"success","amount":2000000,"fee":2688,"currency":"NGN"}}`)
	mac := hmac.New(sha512.New, []byte("ps_wh_sec"))
	mac.Write(psWhBody)
	confEv, err := engine.VerifyAndConfirmWebhook(context.Background(), RailPaystack, psWhBody, hex.EncodeToString(mac.Sum(nil)), "", "")
	if err != nil || confEv.Status != string(StatusSuccessful) || confEv.Fee != 26.88 {
		t.Fatalf("expected confirmed Paystack webhook with fee=26.88, got %+v err=%v", confEv, err)
	}
}

func TestV160ConcurrencyHalfOpenRoutingRetryReconcileAndStores(t *testing.T) {
	idempStore := NewInMemoryIdempotencyStore(100)
	whStore := NewInMemoryWebhookStore(100)
	var retryTelemetry atomic.Int32

	engine := NewEngine(Config{
		StripeSecretKey:          "sk_test_mock",
		FlutterwaveSecretKey:     "flw_mock",
		FlutterwaveWebhookSecret: "flw_wh",
		PaystackSecretKey:        "ps_mock",
		IdempotencyStore:         idempStore,
		WebhookStore:             whStore,
		BalanceCacheTTL:          30 * time.Second,
		Retry:                    &RetryConfig{MaxRetries: 2, BaseDelay: 5 * time.Millisecond, MaxDelay: 20 * time.Millisecond, DisableJitter: true},
		Health:                   &HealthConfig{FailureThreshold: 1, Cooldown: 25 * time.Millisecond},
		RoutingRules: []RoutingRule{
			{
				Currencies: []string{"NGN"},
				Countries:  []string{"NG"},
				Rails:      []PayoutRail{RailFlutterwave, RailPaystack},
				Fees: map[PayoutRail]ProviderFeeRule{
					RailFlutterwave: {Flat: 50, Percent: 0.5},
					RailPaystack:    {Flat: 10, Percent: 0.1},
				},
			},
		},
		RailLimits: map[PayoutRail]RailLimit{
			RailPaystack: {MaxAmount: 100000},
		},
		OnTelemetry: func(ev TelemetryEvent) {
			if ev.Type == "disburse.retry" && ev.ErrorCode == ErrRateLimited {
				retryTelemetry.Add(1)
			}
		},
	})

	// 1. Smart routing sorts cheapest rail first (Paystack < Flutterwave)
	route := engine.ResolveRoute(DisburseParams{Amount: 20000, Currency: "NGN", Reference: "R-SORT", BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"}})
	if len(route) != 2 || route[0] != RailPaystack || route[1] != RailFlutterwave {
		t.Fatalf("expected [PAYSTACK FLUTTERWAVE], got %v", route)
	}

	// 2. Concurrent singleflight (10 goroutines with -race -> exactly 1 HTTP transfer!)
	var transferCalls atomic.Int32
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			if req.URL.Path == "/transferrecipient" {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"recipient_code":"RCP_go_sf"}}`)), Header: make(http.Header)}
			}
			transferCalls.Add(1)
			time.Sleep(15 * time.Millisecond)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":true,"data":{"transfer_code":"TRF_go_sf","reference":"REF-GO-SF","status":"pending"}}`)), Header: make(http.Header)}
		}),
	}

	sfParams := DisburseParams{Amount: 15000, Currency: "NGN", Reference: "REF-GO-SF", BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"}}
	var wg sync.WaitGroup
	errs := make(chan error, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := engine.Disburse(sfParams)
			if err != nil || r.TransactionID != "TRF_go_sf" {
				errs <- fmt.Errorf("unexpected result: %+v err=%v", r, err)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	if transferCalls.Load() != 1 {
		t.Fatalf("expected exactly 1 transfer HTTP call under 10x concurrency, got %d", transferCalls.Load())
	}

	// 3. Idempotency conflict when reusing reference with different amount
	_, confErr := engine.Disburse(DisburseParams{Amount: 99999, Currency: "NGN", Reference: "REF-GO-SF", BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"}})
	var pErr *ProviderError
	if !errors.As(confErr, &pErr) || pErr.Code != ErrIdempotencyConflict {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", confErr)
	}

	// 4. Retry on 429 + Half-Open circuit recovery + WaitForSettlement + Onboarding link + Webhook dedup + Balance cache
	var rateAttempts atomic.Int32
	var pollCalls atomic.Int32
	var balCalls atomic.Int32
	engine.httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			switch {
			case req.URL.Path == "/v1/account_links":
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"url":"https://connect.stripe.com/setup/e/acct_1","expires_at":1800000000}`)), Header: make(http.Header)}
			case req.URL.Path == "/v3/balances":
				balCalls.Add(1)
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":"success","data":[{"currency":"NGN","available_balance":500000}]}`)), Header: make(http.Header)}
			case strings.HasPrefix(req.URL.Path, "/v3/transfers/"):
				n := pollCalls.Add(1)
				st := "PENDING"
				if n >= 3 {
					st = "SUCCESSFUL"
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":"success","data":{"id":777,"reference":"REF-POLL-GO","status":"` + st + `","amount":5000,"currency":"NGN"}}`)), Header: make(http.Header)}
			default:
				n := rateAttempts.Add(1)
				if n == 1 {
					return &http.Response{StatusCode: 429, Body: io.NopCloser(bytes.NewBufferString(`{"status":"error","message":"Too many requests"}`)), Header: make(http.Header)}
				}
				if n == 3 {
					return &http.Response{StatusCode: 400, Body: io.NopCloser(bytes.NewBufferString(`{"status":"error","message":"Invalid account"}`)), Header: make(http.Header)}
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":"success","data":{"id":555,"status":"SUCCESSFUL"}}`)), Header: make(http.Header)}
			}
		}),
	}

	retryRes, err := engine.Disburse(DisburseParams{Amount: 5000, Currency: "NGN", Reference: "REF-429-GO", Rail: RailFlutterwave, BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"}})
	if err != nil || retryRes.Status != string(StatusSuccessful) || retryTelemetry.Load() != 1 {
		t.Fatalf("expected retry on 429 to succeed with telemetry, res=%+v err=%v telemetry=%d", retryRes, err, retryTelemetry.Load())
	}

	// Trip circuit -> OPEN -> wait cooldown -> HALF_OPEN -> probe succeeds -> CLOSED
	_, _ = engine.Disburse(DisburseParams{Amount: 5000, Currency: "NGN", Reference: "REF-OPEN-GO", Rail: RailFlutterwave, BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0000000000"}})
	if engine.GetRailHealth(RailFlutterwave)[0].State != CircuitOpen {
		t.Fatalf("expected OPEN circuit state")
	}
	time.Sleep(35 * time.Millisecond)
	if engine.GetRailHealth(RailFlutterwave)[0].State != CircuitHalfOpen {
		t.Fatalf("expected HALF_OPEN circuit state after cooldown")
	}
	if _, err := engine.Disburse(DisburseParams{Amount: 5000, Currency: "NGN", Reference: "REF-CLOSE-GO", Rail: RailFlutterwave, BankDetails: &BankAccountDetails{BankCode: "058", AccountNumber: "0123456789"}}); err != nil {
		t.Fatalf("expected HALF_OPEN probe to succeed: %v", err)
	}
	if engine.GetRailHealth(RailFlutterwave)[0].State != CircuitClosed {
		t.Fatalf("expected CLOSED circuit state after probe success")
	}

	// WaitForSettlement
	settled, err := engine.WaitForSettlement(context.Background(), PayoutStatusParams{TransactionID: "777", Reference: "REF-POLL-GO", Rail: RailFlutterwave}, &ReconcileOptions{Interval: 5 * time.Millisecond, MaxAttempts: 5, BackoffMultiplier: 1})
	if err != nil || settled.Status != string(StatusSuccessful) || pollCalls.Load() != 3 {
		t.Fatalf("expected WaitForSettlement to succeed on poll 3, got %+v err=%v calls=%d", settled, err, pollCalls.Load())
	}

	// CreateConnectOnboardingLink (Go parity)
	link, err := engine.CreateConnectOnboardingLink(OnboardingLinkParams{AccountID: "acct_1", RefreshURL: "https://ex.com/r", ReturnURL: "https://ex.com/ok"})
	if err != nil || link.URL != "https://connect.stripe.com/setup/e/acct_1" {
		t.Fatalf("unexpected onboarding link: %+v err=%v", link, err)
	}

	// Webhook duplicate detection
	whBody := []byte(`{"event":"transfer.completed","data":{"id":888,"reference":"REF-DUP-GO","status":"SUCCESSFUL","amount":5000,"currency":"NGN"}}`)
	ev1, err := engine.VerifyWebhook(RailFlutterwave, whBody, "flw_wh")
	ev2, err2 := engine.VerifyWebhook(RailFlutterwave, whBody, "flw_wh")
	if err != nil || err2 != nil || ev1.Duplicate || !ev2.Duplicate {
		t.Fatalf("expected duplicate webhook detection: ev1=%+v ev2=%+v err=%v err2=%v", ev1, ev2, err, err2)
	}

	// Balance cache TTL
	_, _ = engine.GetBalances(RailFlutterwave)
	_, _ = engine.GetBalances(RailFlutterwave)
	if balCalls.Load() != 1 {
		t.Fatalf("expected 1 cached balance call, got %d", balCalls.Load())
	}
	engine.InvalidateBalanceCache(RailFlutterwave)
	_, _ = engine.GetBalances(RailFlutterwave)
	if balCalls.Load() != 2 {
		t.Fatalf("expected 2 balance calls after invalidation, got %d", balCalls.Load())
	}
}
