package omnipayout

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var africanCurrencies = map[string]bool{
	"NGN": true, "KES": true, "GHS": true, "UGX": true,
	"TZS": true, "RWF": true, "XOF": true, "XAF": true, "ZAR": true,
}

var referenceLookupRails = map[PayoutRail]bool{
	RailPaystack:   true,
	RailPawaPay:    true,
	RailYellowCard: true,
}

type inFlightCall struct {
	fingerprint string
	done        chan struct{}
	res         *DisburseResult
	err         error
}

type cachedBalances struct {
	balances  []RailBalance
	expiresAt time.Time
}

func computeDisburseFingerprint(params DisburseParams) string {
	cur := strings.ToUpper(params.Currency)
	minor := toMinorUnits(params.Amount, cur)
	dest := "default"
	if params.StripeAccountID != "" {
		dest = "stripe:" + params.StripeAccountID
	} else if params.BankDetails != nil {
		dest = "bank:" + params.BankDetails.BankCode + ":" + params.BankDetails.AccountNumber
	} else if params.MobileMoneyDetails != nil {
		dest = "momo:" + params.MobileMoneyDetails.Network + ":" + params.MobileMoneyDetails.Phone
	}
	return fmt.Sprintf("%s:%d:%s", cur, minor, dest)
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

// Engine is the central, lightweight, stateless-by-default multi-rail payout client.
type Engine struct {
	config           Config
	httpClient       *http.Client
	health           *railHealthTracker
	mpesaMu          sync.Mutex
	mpesaToken       string
	mpesaTokenExpiry time.Time
	inFlightMu       sync.Mutex
	inFlight         map[string]*inFlightCall
	balCacheMu       sync.RWMutex
	balCache         map[PayoutRail]cachedBalances
}

// NewEngine initializes a new multi-rail payout engine with pooled keep-alive transport.
func NewEngine(cfg Config) *Engine {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	connectTimeout := cfg.ConnectTimeout
	if connectTimeout <= 0 {
		connectTimeout = 10 * time.Second
	}

	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   connectTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
	}

	return &Engine{
		config:     cfg,
		httpClient: &http.Client{Timeout: timeout, Transport: transport},
		health:     newRailHealthTracker(cfg.Health),
		inFlight:   make(map[string]*inFlightCall),
		balCache:   make(map[PayoutRail]cachedBalances),
	}
}

// String prevents Engine from leaking embedded Config secrets in fmt/log output.
func (e *Engine) String() string {
	return "omnipayout.Engine{Secrets:[REDACTED]}"
}

func (e *Engine) emit(ev TelemetryEvent) {
	if e.config.OnTelemetry != nil {
		func() {
			defer func() { _ = recover() }()
			e.config.OnTelemetry(ev)
		}()
	}
}

func (e *Engine) providerContext(ctx context.Context, rail PayoutRail) (context.Context, context.CancelFunc) {
	var d time.Duration
	switch rail {
	case RailStripeConnect:
		d = e.config.StripeTimeout
	case RailFlutterwave:
		d = e.config.FlutterwaveTimeout
	case RailPaystack:
		d = e.config.PaystackTimeout
	case RailPawaPay:
		d = e.config.PawaPayTimeout
	case RailYellowCard:
		d = e.config.YellowCardTimeout
	case RailMpesaDaraja:
		if e.config.MpesaDaraja != nil {
			d = e.config.MpesaDaraja.Timeout
		}
	}
	if d > 0 {
		return context.WithTimeout(ctx, d)
	}
	return ctx, func() {}
}

func (e *Engine) getConfiguredRails() []PayoutRail {
	var rails []PayoutRail
	if e.config.StripeSecretKey != "" {
		rails = append(rails, RailStripeConnect)
	}
	if e.config.FlutterwaveSecretKey != "" {
		rails = append(rails, RailFlutterwave)
	}
	if e.config.PaystackSecretKey != "" {
		rails = append(rails, RailPaystack)
	}
	if e.config.PawaPayAPIToken != "" {
		rails = append(rails, RailPawaPay)
	}
	if e.config.YellowCardAPIKey != "" && e.config.YellowCardSecretKey != "" {
		rails = append(rails, RailYellowCard)
	}
	if e.config.MpesaDaraja != nil && e.config.MpesaDaraja.ConsumerKey != "" {
		rails = append(rails, RailMpesaDaraja)
	}
	return rails
}

// GetRailHealth returns live uptime/latency and circuit-breaker state for one or all configured rails.
func (e *Engine) GetRailHealth(rail PayoutRail) []RailHealth {
	if rail != "" {
		return []RailHealth{e.health.getHealth(rail)}
	}
	rails := e.getConfiguredRails()
	out := make([]RailHealth, 0, len(rails))
	for _, r := range rails {
		out = append(out, e.health.getHealth(r))
	}
	return out
}

// InvalidateBalanceCache clears cached float balances for a rail or all rails.
func (e *Engine) InvalidateBalanceCache(rail PayoutRail) {
	e.balCacheMu.Lock()
	defer e.balCacheMu.Unlock()
	if rail != "" {
		delete(e.balCache, rail)
	} else {
		e.balCache = make(map[PayoutRail]cachedBalances)
	}
}

// ResolveRoute evaluates configurable routing rules (country, currency, min/max limits, and lowest fees)
// and returns the ordered candidate rail slice `[primary, ...fallbacks]`.
func (e *Engine) ResolveRoute(params DisburseParams) []PayoutRail {
	cur := strings.ToUpper(params.Currency)
	country := strings.ToUpper(params.Country)
	if country == "" {
		country = currencyCountries[cur]
	}

	if params.Rail == "" && len(e.config.RoutingRules) > 0 {
		for _, rule := range e.config.RoutingRules {
			if len(rule.Currencies) > 0 {
				matchedCur := false
				for _, rc := range rule.Currencies {
					if strings.EqualFold(rc, cur) {
						matchedCur = true
						break
					}
				}
				if !matchedCur {
					continue
				}
			}
			if len(rule.Countries) > 0 {
				matchedCountry := false
				for _, rct := range rule.Countries {
					if country != "" && strings.EqualFold(rct, country) {
						matchedCountry = true
						break
					}
				}
				if !matchedCountry {
					continue
				}
			}
			if rule.MinAmount > 0 && params.Amount < rule.MinAmount {
				continue
			}
			if rule.MaxAmount > 0 && params.Amount > rule.MaxAmount {
				continue
			}
			if len(rule.Rails) > 0 {
				ordered := make([]PayoutRail, len(rule.Rails))
				copy(ordered, rule.Rails)
				strategy := rule.Strategy
				if strategy == "" {
					if len(rule.Fees) > 0 {
						strategy = StrategyLowestFee
					} else {
						strategy = StrategyPriority
					}
				}
				if strategy == StrategyLowestFee && len(rule.Fees) > 0 {
					sort.SliceStable(ordered, func(i, j int) bool {
						fi, okI := rule.Fees[ordered[i]]
						fj, okJ := rule.Fees[ordered[j]]
						costI := math.MaxFloat64
						if okI {
							costI = fi.Flat + (params.Amount*fi.Percent)/100.0
						}
						costJ := math.MaxFloat64
						if okJ {
							costJ = fj.Flat + (params.Amount*fj.Percent)/100.0
						}
						return costI < costJ
					})
				} else if strategy == StrategyHealthFirst {
					stateRank := func(s CircuitState) int {
						if s == CircuitClosed {
							return 0
						}
						if s == CircuitHalfOpen {
							return 1
						}
						return 2
					}
					sort.SliceStable(ordered, func(i, j int) bool {
						hi := e.health.getHealth(ordered[i])
						hj := e.health.getHealth(ordered[j])
						if stateRank(hi.State) != stateRank(hj.State) {
							return stateRank(hi.State) < stateRank(hj.State)
						}
						return hi.AvgLatencyMs < hj.AvgLatencyMs
					})
				}
				seen := map[PayoutRail]bool{}
				for _, r := range ordered {
					seen[r] = true
				}
				for _, fb := range params.FallbackRails {
					if fb != "" && !seen[fb] {
						ordered = append(ordered, fb)
						seen[fb] = true
					}
				}
				return ordered
			}
		}
	}

	var primary PayoutRail
	if params.Rail != "" {
		primary = params.Rail
	} else if params.StripeAccountID != "" {
		primary = RailStripeConnect
	} else if params.MobileMoneyDetails != nil {
		if e.config.FlutterwaveSecretKey != "" {
			primary = RailFlutterwave
		} else if cur == "KES" && strings.EqualFold(params.MobileMoneyDetails.Network, "MPESA") && e.config.MpesaDaraja != nil {
			primary = RailMpesaDaraja
		} else if e.config.PawaPayAPIToken != "" {
			primary = RailPawaPay
		} else if e.config.YellowCardAPIKey != "" {
			primary = RailYellowCard
		} else if e.config.PaystackSecretKey != "" {
			primary = RailPaystack
		} else {
			primary = RailFlutterwave
		}
	} else if params.BankDetails != nil || africanCurrencies[cur] {
		if e.config.FlutterwaveSecretKey != "" {
			primary = RailFlutterwave
		} else if e.config.PaystackSecretKey != "" {
			primary = RailPaystack
		} else if e.config.YellowCardAPIKey != "" {
			primary = RailYellowCard
		} else {
			primary = RailFlutterwave
		}
	} else {
		primary = RailStripeConnect
	}

	candidates := []PayoutRail{primary}
	seen := map[PayoutRail]bool{primary: true}
	for _, fb := range params.FallbackRails {
		if fb != "" && !seen[fb] {
			candidates = append(candidates, fb)
			seen[fb] = true
		}
	}
	return candidates
}

// ResolveRail determines the primary payment rail based on routing rules, parameters, or currency.
func (e *Engine) ResolveRail(params DisburseParams) PayoutRail {
	return e.ResolveRoute(params)[0]
}

func (e *Engine) disburseOnRail(ctx context.Context, rail PayoutRail, params DisburseParams) (*DisburseResult, error) {
	pCtx, cancel := e.providerContext(ctx, rail)
	defer cancel()

	switch rail {
	case RailStripeConnect:
		return e.disburseStripe(pCtx, params)
	case RailFlutterwave:
		return e.disburseFlutterwave(pCtx, params)
	case RailPaystack:
		return e.disbursePaystack(pCtx, params)
	case RailPawaPay:
		return e.disbursePawaPay(pCtx, params)
	case RailYellowCard:
		return e.disburseYellowCard(pCtx, params)
	case RailMpesaDaraja:
		return e.disburseMpesaDaraja(pCtx, params)
	default:
		return nil, fmt.Errorf("unsupported rail: %s", rail)
	}
}

// Disburse executes a disbursement using context.Background().
func (e *Engine) Disburse(params DisburseParams) (*DisburseResult, error) {
	return e.DisburseContext(context.Background(), params)
}

// DisburseContext executes a disbursement with concurrent singleflight deduplication,
// optional IdempotencyStore, smart routing, half-open circuit breakers, retry backoff, and safe failover.
func (e *Engine) DisburseContext(ctx context.Context, params DisburseParams) (*DisburseResult, error) {
	if err := validateDisburseInputs(params.Amount, params.Currency, params.Reference); err != nil {
		return nil, err
	}
	refKey := strings.TrimSpace(params.Reference)
	fingerprint := computeDisburseFingerprint(params)

	// 1. In-flight concurrent singleflight protection (stateless once settled)
	e.inFlightMu.Lock()
	if existingCall, ok := e.inFlight[refKey]; ok {
		if existingCall.fingerprint != fingerprint {
			e.inFlightMu.Unlock()
			return nil, &ProviderError{
				Rail:    e.ResolveRail(params),
				Code:    ErrIdempotencyConflict,
				Message: fmt.Sprintf("idempotency conflict: reference %q is already in flight with different parameters", refKey),
			}
		}
		e.inFlightMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-existingCall.done:
			return existingCall.res, existingCall.err
		}
	}

	call := &inFlightCall{
		fingerprint: fingerprint,
		done:        make(chan struct{}),
	}
	e.inFlight[refKey] = call
	e.inFlightMu.Unlock()

	defer func() {
		e.inFlightMu.Lock()
		delete(e.inFlight, refKey)
		close(call.done)
		e.inFlightMu.Unlock()
	}()

	// 2. Optional pluggable persistence check (Redis / Postgres / InMemoryIdempotencyStore)
	if e.config.IdempotencyStore != nil {
		existing, err := e.config.IdempotencyStore.Get(ctx, refKey)
		if err != nil {
			call.err = err
			return nil, err
		}
		if existing != nil {
			if existing.Fingerprint != fingerprint {
				cErr := &ProviderError{
					Rail:    e.ResolveRail(params),
					Code:    ErrIdempotencyConflict,
					Message: fmt.Sprintf("idempotency conflict: reference %q was previously used with different parameters", refKey),
				}
				call.err = cErr
				return nil, cErr
			}
			if existing.Result != nil {
				call.res = existing.Result
				return existing.Result, nil
			}
			if existing.State == IdempotencyInProgress {
				ipErr := &ProviderError{
					Rail:      existing.Rail,
					Code:      ErrInProgress,
					Message:   fmt.Sprintf("payout %q is currently in progress on another instance", refKey),
					Retryable: true,
				}
				call.err = ipErr
				return nil, ipErr
			}
			if existing.State == IdempotencyAmbiguous && !params.AllowUnsafeTimeoutFailover {
				origRail := existing.Rail
				if origRail == "" {
					origRail = e.ResolveRail(params)
				}
				if referenceLookupRails[origRail] {
					reconciled, sErr := e.GetPayoutStatusContext(ctx, PayoutStatusParams{
						TransactionID: refKey,
						Reference:     refKey,
						Rail:          origRail,
					})
					if sErr == nil && reconciled.Status != string(StatusFailed) {
						ttl := e.config.IdempotencyTTL
						if ttl <= 0 {
							ttl = 24 * time.Hour
						}
						_ = e.config.IdempotencyStore.Set(ctx, refKey, IdempotencyRecord{
							Fingerprint: fingerprint,
							State:       IdempotencyCompleted,
							Rail:        origRail,
							UpdatedAt:   time.Now().UTC(),
							Result:      reconciled,
						}, ttl)
						call.res = reconciled
						return reconciled, nil
					}
					var lookupErr *ProviderError
					if sErr != nil && !(errors.As(sErr, &lookupErr) && lookupErr.StatusCode == http.StatusNotFound) {
						ambErr := &AmbiguousPayoutError{Rail: origRail, Reference: refKey, Code: ErrAmbiguousTimeout, Cause: "prior instance left payout in AMBIGUOUS state"}
						call.err = ambErr
						return nil, ambErr
					}
				} else {
					ambErr := &AmbiguousPayoutError{Rail: origRail, Reference: refKey, Code: ErrAmbiguousTimeout, Cause: "prior instance left payout in AMBIGUOUS state"}
					call.err = ambErr
					return nil, ambErr
				}
			}
		}
	}

	res, err := e.executeDisbursePipeline(ctx, params, refKey, fingerprint)
	call.res = res
	call.err = err
	return res, err
}

func (e *Engine) executeDisbursePipeline(ctx context.Context, params DisburseParams, refKey, fingerprint string) (*DisburseResult, error) {
	candidates := e.ResolveRoute(params)
	primaryRail := candidates[0]
	var attempted []PayoutRail
	var lastErr error
	var lastFailed *DisburseResult
	currency := strings.ToUpper(params.Currency)
	idempTTL := e.config.IdempotencyTTL
	if idempTTL <= 0 {
		idempTTL = 24 * time.Hour
	}

	for i, rail := range candidates {
		hasFallback := i < len(candidates)-1

		// Per-rail min/max transaction limit check
		if lim, ok := e.config.RailLimits[rail]; ok {
			if (lim.MinAmount > 0 && params.Amount < lim.MinAmount) || (lim.MaxAmount > 0 && params.Amount > lim.MaxAmount) {
				limErr := &ProviderError{
					Rail:    rail,
					Code:    ErrLimitExceeded,
					Message: fmt.Sprintf("amount %.2f %s is outside configured limits for %s", params.Amount, currency, rail),
				}
				lastErr = limErr
				if hasFallback {
					continue
				}
				return nil, limErr
			}
		}

		// Circuit breaker check (CLOSED -> OPEN -> HALF_OPEN single recovery probe)
		prevState := e.health.getHealth(rail).State
		if !e.health.tryAcquire(rail) && hasFallback {
			lastErr = &ProviderError{
				Rail:    rail,
				Code:    ErrProviderDown,
				Message: fmt.Sprintf("rail %s circuit breaker is open (unhealthy)", rail),
			}
			continue
		}

		attempted = append(attempted, rail)

		if params.CheckBalanceBeforeDisburse {
			balances, err := e.GetBalancesContext(ctx, rail)
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
					lastErr = &ProviderError{
						Rail:    rail,
						Code:    ErrInsufficientFloat,
						Message: fmt.Sprintf("insufficient %s balance on %s: available %.2f, required %.2f", currency, rail, b.Available, params.Amount),
					}
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

		// Persist pre-dispatch IN_PROGRESS lock for multi-instance safety when IdempotencyStore is configured
		if e.config.IdempotencyStore != nil {
			_ = e.config.IdempotencyStore.Set(ctx, refKey, IdempotencyRecord{
				Fingerprint: fingerprint,
				State:       IdempotencyInProgress,
				Rail:        rail,
				UpdatedAt:   time.Now().UTC(),
			}, idempTTL)
		}

		start := time.Now()
		res, err := withRetry(ctx, e.config.Retry, func() (*DisburseResult, error) {
			return e.disburseOnRail(ctx, rail, params)
		}, func(retryErr *ProviderError, attempt int) {
			e.emit(TelemetryEvent{
				Type:      "disburse.retry",
				Rail:      rail,
				Reference: refKey,
				ErrorCode: retryErr.Code,
				Message:   fmt.Sprintf("retry attempt %d: %s", attempt, retryErr.Message),
			})
		})
		latency := time.Since(start)

		if err != nil {
			e.health.recordFailure(rail, latency, err.Error())
			if nextState := e.health.getHealth(rail).State; nextState != prevState {
				e.emit(TelemetryEvent{Type: "circuit.state_change", Rail: rail, CircuitState: nextState})
			}
			errCode := ErrProvider
			var provErr *ProviderError
			if errors.As(err, &provErr) {
				errCode = provErr.Code
			}
			e.emit(TelemetryEvent{Type: "disburse.failed", Rail: rail, Reference: refKey, LatencyMs: latency.Milliseconds(), ErrorCode: errCode, Message: err.Error()})
			lastErr = err

			if errors.As(err, &provErr) && provErr.IsAmbiguous && !params.AllowUnsafeTimeoutFailover {
				if referenceLookupRails[rail] {
					reconciled, statusErr := e.GetPayoutStatusContext(ctx, PayoutStatusParams{
						TransactionID: params.Reference,
						Reference:     params.Reference,
						Rail:          rail,
					})
					if statusErr == nil {
						if reconciled.Status == string(StatusFailed) && hasFallback {
							lastFailed = reconciled
							continue
						}
						reconciled.AttemptedRails = attempted
						if rail != primaryRail {
							reconciled.FailoverFrom = primaryRail
						}
						if e.config.IdempotencyStore != nil && reconciled.Status != string(StatusFailed) {
							_ = e.config.IdempotencyStore.Set(ctx, refKey, IdempotencyRecord{Fingerprint: fingerprint, State: IdempotencyCompleted, Rail: rail, UpdatedAt: time.Now().UTC(), Result: reconciled}, idempTTL)
						}
						return reconciled, nil
					}
					var lookupErr *ProviderError
					if errors.As(statusErr, &lookupErr) && lookupErr.StatusCode == http.StatusNotFound {
						if hasFallback {
							continue
						}
						if e.config.IdempotencyStore != nil {
							_ = e.config.IdempotencyStore.Delete(ctx, refKey)
						}
						return nil, lastErr
					}
				}
				if e.config.IdempotencyStore != nil {
					_ = e.config.IdempotencyStore.Set(ctx, refKey, IdempotencyRecord{
						Fingerprint: fingerprint,
						State:       IdempotencyAmbiguous,
						Rail:        rail,
						UpdatedAt:   time.Now().UTC(),
					}, idempTTL)
				}
				return nil, &AmbiguousPayoutError{
					Rail:      rail,
					Reference: params.Reference,
					Code:      ErrAmbiguousTimeout,
					Cause:     err.Error(),
				}
			}

			if hasFallback {
				continue
			}
			if e.config.IdempotencyStore != nil {
				_ = e.config.IdempotencyStore.Delete(ctx, refKey)
			}
			return nil, err
		}

		if res.Status == string(StatusFailed) {
			e.health.recordFailure(rail, latency, res.Error)
			if nextState := e.health.getHealth(rail).State; nextState != prevState {
				e.emit(TelemetryEvent{Type: "circuit.state_change", Rail: rail, CircuitState: nextState})
			}
			e.emit(TelemetryEvent{Type: "disburse.failed", Rail: rail, Reference: refKey, LatencyMs: latency.Milliseconds(), Message: res.Error})
			if hasFallback {
				lastFailed = res
				lastErr = fmt.Errorf("%s disbursement returned FAILED: %s", rail, res.Error)
				continue
			}
			if e.config.IdempotencyStore != nil {
				_ = e.config.IdempotencyStore.Delete(ctx, refKey)
			}
		} else {
			e.health.recordSuccess(rail, latency)
			if nextState := e.health.getHealth(rail).State; nextState != prevState {
				e.emit(TelemetryEvent{Type: "circuit.state_change", Rail: rail, CircuitState: nextState})
			}
		}

		res.AttemptedRails = attempted
		if rail != primaryRail {
			res.FailoverFrom = primaryRail
			e.emit(TelemetryEvent{Type: "disburse.failover", Rail: rail, FailoverFrom: primaryRail, Reference: refKey, LatencyMs: latency.Milliseconds()})
		}
		e.emit(TelemetryEvent{Type: "disburse.success", Rail: rail, Reference: refKey, LatencyMs: latency.Milliseconds()})

		if e.config.IdempotencyStore != nil && res.Status != string(StatusFailed) {
			_ = e.config.IdempotencyStore.Set(ctx, refKey, IdempotencyRecord{Fingerprint: fingerprint, State: IdempotencyCompleted, Rail: rail, UpdatedAt: time.Now().UTC(), Result: res}, idempTTL)
		}
		return res, nil
	}

	if lastFailed != nil {
		lastFailed.AttemptedRails = attempted
		return lastFailed, nil
	}
	return nil, lastErr
}

// WaitForSettlement polls GetPayoutStatusContext with configurable exponential backoff
// until the payout reaches SUCCESSFUL or FAILED, or returns ErrReconciliationTimeout.
func (e *Engine) WaitForSettlement(ctx context.Context, params PayoutStatusParams, opts *ReconcileOptions) (*DisburseResult, error) {
	maxAttempts := 10
	interval := 2 * time.Second
	multiplier := 1.5
	maxInterval := 15 * time.Second
	if opts != nil {
		if opts.MaxAttempts > 0 {
			maxAttempts = opts.MaxAttempts
		}
		if opts.Interval > 0 {
			interval = opts.Interval
		}
		if opts.BackoffMultiplier > 0 {
			multiplier = opts.BackoffMultiplier
		}
		if opts.MaxInterval > 0 {
			maxInterval = opts.MaxInterval
		}
	}

	delay := interval
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		res, err := e.GetPayoutStatusContext(ctx, params)
		if err != nil {
			return nil, err
		}
		if res.Status == string(StatusSuccessful) || res.Status == string(StatusFailed) {
			return res, nil
		}
		if attempt < maxAttempts {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			next := time.Duration(float64(delay) * multiplier)
			if next > maxInterval {
				next = maxInterval
			}
			delay = next
		}
	}

	return nil, &ProviderError{
		Rail:      params.Rail,
		Code:      ErrReconciliationTimeout,
		Message:   fmt.Sprintf("payout %q on %s remained PENDING after %d reconciliation attempts", params.TransactionID, params.Rail, maxAttempts),
		Retryable: true,
	}
}

// CreateConnectOnboardingLink generates a hosted Stripe Connect Express onboarding URL using context.Background().
func (e *Engine) CreateConnectOnboardingLink(params OnboardingLinkParams) (*OnboardingLinkResult, error) {
	return e.CreateConnectOnboardingLinkContext(context.Background(), params)
}

// CreateConnectOnboardingLinkContext generates a hosted Stripe Connect Express onboarding URL.
func (e *Engine) CreateConnectOnboardingLinkContext(ctx context.Context, params OnboardingLinkParams) (*OnboardingLinkResult, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}
	pCtx, cancel := e.providerContext(ctx, RailStripeConnect)
	defer cancel()

	linkType := params.Type
	if linkType == "" {
		linkType = "account_onboarding"
	}
	form := url.Values{}
	form.Set("account", params.AccountID)
	form.Set("refresh_url", params.RefreshURL)
	form.Set("return_url", params.ReturnURL)
	form.Set("type", linkType)

	req, err := http.NewRequestWithContext(pCtx, "POST", "https://api.stripe.com/v1/account_links", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, newProviderError(RailStripeConnect, 0, err.Error(), false)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	var data struct {
		URL       string `json:"url"`
		ExpiresAt int64  `json:"expires_at"`
		Error     *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(bodyBytes, &data)
	if resp.StatusCode >= 400 || data.Error != nil {
		msg := "stripe onboarding link failed"
		if data.Error != nil && data.Error.Message != "" {
			msg = data.Error.Message
		}
		return nil, newProviderError(RailStripeConnect, resp.StatusCode, msg, false)
	}

	var exp *time.Time
	if data.ExpiresAt > 0 {
		t := time.Unix(data.ExpiresAt, 0).UTC()
		exp = &t
	}
	return &OnboardingLinkResult{URL: data.URL, ExpiresAt: exp}, nil
}

func (e *Engine) disburseStripe(ctx context.Context, params DisburseParams) (*DisburseResult, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}
	if params.StripeAccountID == "" {
		return nil, fmt.Errorf("stripeAccountId is required for Stripe Connect disbursements")
	}

	currency := strings.ToUpper(params.Currency)
	amountInMinor := toMinorUnits(params.Amount, currency)

	form := url.Values{}
	form.Set("amount", fmt.Sprintf("%d", amountInMinor))
	form.Set("currency", strings.ToLower(currency))
	form.Set("destination", params.StripeAccountID)
	form.Set("metadata[reference]", params.Reference)
	if params.Narration != "" {
		form.Set("description", params.Narration)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.stripe.com/v1/transfers", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Idempotency-Key", params.Reference+":transfer")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, newProviderError(RailStripeConnect, 0, err.Error(), true)
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
		if stripeResp.Error != nil && stripeResp.Error.Message != "" {
			msg = stripeResp.Error.Message
		}
		return nil, newProviderError(RailStripeConnect, resp.StatusCode, msg, isHTTPStatusAmbiguous(resp.StatusCode))
	}

	txID := stripeResp.ID
	providerStatus := stripeResp.Status
	status := normalizeStripeStatus(stripeResp.Status, StatusSuccessful)
	failureMsg := stripeResp.FailureMessage

	if params.Speed == SpeedInstant {
		payoutForm := url.Values{}
		payoutForm.Set("amount", fmt.Sprintf("%d", amountInMinor))
		payoutForm.Set("currency", strings.ToLower(currency))
		payoutForm.Set("method", "instant")
		payoutForm.Set("metadata[reference]", params.Reference)

		payoutReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.stripe.com/v1/payouts", strings.NewReader(payoutForm.Encode()))
		if err != nil {
			return nil, err
		}
		payoutReq.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
		payoutReq.Header.Set("Stripe-Account", params.StripeAccountID)
		payoutReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		payoutReq.Header.Set("Idempotency-Key", params.Reference+":payout")

		pResp, pErr := e.httpClient.Do(payoutReq)
		if pErr != nil {
			return nil, newProviderError(RailStripeConnect, 0, pErr.Error(), true)
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
			if pData.Error != nil && pData.Error.Message != "" {
				msg = pData.Error.Message
			}
			return nil, newProviderError(RailStripeConnect, pResp.StatusCode, msg, isHTTPStatusAmbiguous(pResp.StatusCode))
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
		Currency:       currency,
		Error:          errMsg,
	}, nil
}

func (e *Engine) disburseFlutterwave(ctx context.Context, params DisburseParams) (*DisburseResult, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is not configured")
	}

	currency := strings.ToUpper(params.Currency)
	payload := map[string]interface{}{
		"amount":    params.Amount,
		"currency":  currency,
		"reference": params.Reference,
		"narration": params.Narration,
	}

	if params.BankDetails != nil {
		payload["account_bank"] = ResolveProviderCode(params.BankDetails.BankCode, currency, RailFlutterwave, false)
		payload["account_number"] = params.BankDetails.AccountNumber
		payload["debit_currency"] = currency
	} else if params.MobileMoneyDetails != nil {
		msisdn, err := NormalizeMSISDN(params.MobileMoneyDetails.Phone, currency)
		if err != nil {
			return nil, err
		}
		payload["account_bank"] = ResolveProviderCode(params.MobileMoneyDetails.Network, currency, RailFlutterwave, true)
		payload["account_number"] = msisdn
	} else {
		return nil, fmt.Errorf("either bankDetails or mobileMoneyDetails is required for African payouts")
	}

	jsonBytes, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.flutterwave.com/v3/transfers", bytes.NewBuffer(jsonBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.FlutterwaveSecretKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, newProviderError(RailFlutterwave, 0, err.Error(), true)
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
		status := resp.StatusCode
		if status < 400 {
			status = 400
		}
		return nil, newProviderError(RailFlutterwave, status, "flutterwave transfer error: "+flwResp.Message, resp.StatusCode >= 500 && isHTTPStatusAmbiguous(resp.StatusCode))
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
		Currency:       currency,
		Fee:            fee,
		Error:          errMsg,
	}, nil
}

// GetPayoutStatus fetches the latest settlement status using context.Background().
func (e *Engine) GetPayoutStatus(params PayoutStatusParams) (*DisburseResult, error) {
	return e.GetPayoutStatusContext(context.Background(), params)
}

// GetPayoutStatusContext fetches the latest settlement status for a previously initiated payout.
func (e *Engine) GetPayoutStatusContext(ctx context.Context, params PayoutStatusParams) (*DisburseResult, error) {
	if strings.TrimSpace(params.TransactionID) == "" {
		return nil, fmt.Errorf("transactionId is required to check payout status")
	}

	return withRetry(ctx, e.config.Retry, func() (*DisburseResult, error) {
		pCtx, cancel := e.providerContext(ctx, params.Rail)
		defer cancel()

		switch params.Rail {
		case RailStripeConnect:
			return e.getStripePayoutStatus(pCtx, params)
		case RailFlutterwave:
			return e.getFlutterwavePayoutStatus(pCtx, params)
		case RailPaystack:
			return e.getPaystackPayoutStatus(pCtx, params)
		case RailPawaPay:
			return e.getPawaPayPayoutStatus(pCtx, params)
		case RailYellowCard:
			return e.getYellowCardPayoutStatus(pCtx, params)
		case RailMpesaDaraja:
			return e.getMpesaDarajaPayoutStatus(pCtx, params)
		default:
			return nil, fmt.Errorf("unsupported rail: %s", params.Rail)
		}
	}, nil)
}

func (e *Engine) getStripePayoutStatus(ctx context.Context, params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}
	safeID, err := validateSafeIdentifier(params.TransactionID, "transactionId")
	if err != nil {
		return nil, err
	}

	isPayout := strings.HasPrefix(strings.TrimSpace(params.TransactionID), "po_")
	endpoint := "https://api.stripe.com/v1/transfers/" + safeID
	defaultStatus := StatusSuccessful
	if isPayout {
		endpoint = "https://api.stripe.com/v1/payouts/" + safeID
		defaultStatus = StatusPending
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)
	if isPayout && params.StripeAccountID != "" {
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
		if data.Error != nil && data.Error.Message != "" {
			msg = data.Error.Message
		}
		return nil, newProviderError(RailStripeConnect, resp.StatusCode, msg, false)
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
	currency := strings.ToUpper(data.Currency)
	if currency == "" {
		currency = "USD"
	}

	return &DisburseResult{
		Success:        status != string(StatusFailed),
		TransactionID:  txID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: data.Status,
		Rail:           RailStripeConnect,
		Amount:         fromMinorUnits(data.Amount, currency),
		Currency:       currency,
		Error:          errMsg,
	}, nil
}

func (e *Engine) getFlutterwavePayoutStatus(ctx context.Context, params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is not configured")
	}
	safeID, err := validateSafeIdentifier(params.TransactionID, "transactionId")
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.flutterwave.com/v3/transfers/"+safeID, nil)
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
		return nil, newProviderError(RailFlutterwave, resp.StatusCode, "flutterwave status lookup error: "+flwResp.Message, false)
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

// ResolveBankAccount verifies a Nigerian / African bank account name using context.Background().
func (e *Engine) ResolveBankAccount(bankCode, accountNumber string) (*BankResolutionResult, error) {
	return e.ResolveBankAccountContext(context.Background(), bankCode, accountNumber)
}

// ResolveBankAccountContext verifies an African bank account name via Flutterwave or Paystack with automatic failover.
func (e *Engine) ResolveBankAccountContext(ctx context.Context, bankCode, accountNumber string) (*BankResolutionResult, error) {
	if e.config.FlutterwaveSecretKey != "" {
		res, err := e.resolveFlutterwaveBankAccount(ctx, ResolveProviderCode(bankCode, "NGN", RailFlutterwave, false), accountNumber)
		if err == nil {
			return res, nil
		}
		if e.config.PaystackSecretKey != "" {
			return e.resolvePaystackBankAccount(ctx, ResolveProviderCode(bankCode, "NGN", RailPaystack, false), accountNumber)
		}
		return nil, err
	}
	if e.config.PaystackSecretKey != "" {
		return e.resolvePaystackBankAccount(ctx, ResolveProviderCode(bankCode, "NGN", RailPaystack, false), accountNumber)
	}
	return nil, fmt.Errorf("neither flutterwave nor paystack secret key is configured for account resolution")
}

func (e *Engine) resolveFlutterwaveBankAccount(ctx context.Context, bankCode, accountNumber string) (*BankResolutionResult, error) {
	body := map[string]string{
		"account_bank":   bankCode,
		"account_number": accountNumber,
	}
	jsonBytes, _ := json.Marshal(body)

	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.flutterwave.com/v3/accounts/resolve", bytes.NewBuffer(jsonBytes))
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
		return nil, newProviderError(RailFlutterwave, resp.StatusCode, "account resolution failed: "+res.Message, false)
	}

	return &BankResolutionResult{
		AccountName:   res.Data.AccountName,
		AccountNumber: res.Data.AccountNumber,
		BankCode:      bankCode,
	}, nil
}

func (e *Engine) resolvePaystackBankAccount(ctx context.Context, bankCode, accountNumber string) (*BankResolutionResult, error) {
	q := url.Values{}
	q.Set("account_number", accountNumber)
	q.Set("bank_code", bankCode)

	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.paystack.co/bank/resolve?"+q.Encode(), nil)
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
	var res struct {
		Status  bool   `json:"status"`
		Message string `json:"message"`
		Data    struct {
			AccountName   string `json:"account_name"`
			AccountNumber string `json:"account_number"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &res)
	if resp.StatusCode >= 400 || !res.Status {
		return nil, newProviderError(RailPaystack, resp.StatusCode, "paystack account resolution failed: "+res.Message, false)
	}
	accNum := res.Data.AccountNumber
	if accNum == "" {
		accNum = accountNumber
	}
	return &BankResolutionResult{
		AccountName:   res.Data.AccountName,
		AccountNumber: accNum,
		BankCode:      bankCode,
	}, nil
}

func (e *Engine) disbursePaystack(ctx context.Context, params DisburseParams) (*DisburseResult, error) {
	if e.config.PaystackSecretKey == "" {
		return nil, fmt.Errorf("paystack secret key is not configured")
	}
	if params.BankDetails == nil && params.MobileMoneyDetails == nil {
		return nil, fmt.Errorf("either bankDetails or mobileMoneyDetails is required for Paystack payouts")
	}

	currency := strings.ToUpper(params.Currency)
	amountInSubunit := toMinorUnits(params.Amount, currency)

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
			"bank_code":      ResolveProviderCode(params.BankDetails.BankCode, currency, RailPaystack, false),
			"currency":       currency,
		}
	} else {
		msisdn, err := NormalizeMSISDN(params.MobileMoneyDetails.Phone, currency)
		if err != nil {
			return nil, err
		}
		recipientPayload = map[string]interface{}{
			"type":           "mobile_money",
			"name":           msisdn,
			"account_number": msisdn,
			"bank_code":      ResolveProviderCode(params.MobileMoneyDetails.Network, currency, RailPaystack, true),
			"currency":       currency,
		}
	}

	recBytes, _ := json.Marshal(recipientPayload)
	recReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.paystack.co/transferrecipient", bytes.NewBuffer(recBytes))
	if err != nil {
		return nil, err
	}
	recReq.Header.Set("Authorization", "Bearer "+e.config.PaystackSecretKey)
	recReq.Header.Set("Content-Type", "application/json")

	recResp, err := e.httpClient.Do(recReq)
	if err != nil {
		pErr := newProviderError(RailPaystack, 0, err.Error(), false)
		pErr.Retryable = true
		return nil, pErr
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
		st := recResp.StatusCode
		if st < 400 {
			st = 400
		}
		return nil, newProviderError(RailPaystack, st, "paystack recipient error: "+recData.Message, false)
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
	txReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.paystack.co/transfer", bytes.NewBuffer(txBytes))
	if err != nil {
		return nil, err
	}
	txReq.Header.Set("Authorization", "Bearer "+e.config.PaystackSecretKey)
	txReq.Header.Set("Content-Type", "application/json")

	txResp, err := e.httpClient.Do(txReq)
	if err != nil {
		return nil, newProviderError(RailPaystack, 0, err.Error(), true)
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
		st := txResp.StatusCode
		if st < 400 {
			st = 400
		}
		return nil, newProviderError(RailPaystack, st, "paystack transfer error: "+psResp.Message, txResp.StatusCode >= 500 && isHTTPStatusAmbiguous(txResp.StatusCode))
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

func (e *Engine) getPaystackPayoutStatus(ctx context.Context, params PayoutStatusParams) (*DisburseResult, error) {
	if e.config.PaystackSecretKey == "" {
		return nil, fmt.Errorf("paystack secret key is not configured")
	}

	var endpoint string
	if params.Reference != "" {
		safeRef, err := validateSafeIdentifier(params.Reference, "reference")
		if err != nil {
			return nil, err
		}
		endpoint = "https://api.paystack.co/transfer/verify/" + safeRef
	} else {
		safeID, err := validateSafeIdentifier(params.TransactionID, "transactionId")
		if err != nil {
			return nil, err
		}
		endpoint = "https://api.paystack.co/transfer/" + safeID
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
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
		Data    *struct {
			ID           int64  `json:"id"`
			TransferCode string `json:"transfer_code"`
			Reference    string `json:"reference"`
			Status       string `json:"status"`
			Amount       int64  `json:"amount"`
			Fee          int64  `json:"fee"`
			Currency     string `json:"currency"`
			Failures     string `json:"failures"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &psResp)
	if resp.StatusCode >= 400 || !psResp.Status {
		return nil, newProviderError(RailPaystack, resp.StatusCode, "paystack status lookup error: "+psResp.Message, false)
	}

	txID := params.TransactionID
	ref := params.Reference
	if ref == "" {
		ref = params.TransactionID
	}
	amount := 0.0
	fee := 0.0
	currency := "NGN"
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
		if psResp.Data.Currency != "" {
			currency = strings.ToUpper(psResp.Data.Currency)
		}
		amount = fromMinorUnits(psResp.Data.Amount, currency)
		fee = fromMinorUnits(psResp.Data.Fee, currency)
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
		Fee:            fee,
		Error:          errMsg,
	}, nil
}

func (e *Engine) fetchSingleRailBalance(ctx context.Context, rail PayoutRail) ([]RailBalance, error) {
	if e.config.BalanceCacheTTL > 0 {
		e.balCacheMu.RLock()
		if cached, ok := e.balCache[rail]; ok && time.Now().Before(cached.expiresAt) {
			e.balCacheMu.RUnlock()
			return cached.balances, nil
		}
		e.balCacheMu.RUnlock()
	}

	balances, err := withRetry(ctx, e.config.Retry, func() ([]RailBalance, error) {
		pCtx, cancel := e.providerContext(ctx, rail)
		defer cancel()

		switch rail {
		case RailStripeConnect:
			return e.getStripeBalances(pCtx)
		case RailFlutterwave:
			return e.getFlutterwaveBalances(pCtx)
		case RailPaystack:
			return e.getPaystackBalances(pCtx)
		case RailPawaPay:
			return e.getPawaPayBalances(pCtx)
		case RailYellowCard:
			return e.getYellowCardBalances(pCtx)
		case RailMpesaDaraja:
			return e.getMpesaDarajaBalances(pCtx)
		default:
			return nil, fmt.Errorf("unsupported rail: %s", rail)
		}
	}, nil)
	if err != nil {
		return nil, err
	}

	if e.config.BalanceCacheTTL > 0 {
		e.balCacheMu.Lock()
		e.balCache[rail] = cachedBalances{
			balances:  balances,
			expiresAt: time.Now().Add(e.config.BalanceCacheTTL),
		}
		e.balCacheMu.Unlock()
	}
	return balances, nil
}

// GetBalances queries available float balances using context.Background().
func (e *Engine) GetBalances(rail PayoutRail) ([]RailBalance, error) {
	return e.GetBalancesContext(context.Background(), rail)
}

// GetBalancesContext queries available float balances for a specific rail, or concurrently across all configured rails when rail is empty.
func (e *Engine) GetBalancesContext(ctx context.Context, rail PayoutRail) ([]RailBalance, error) {
	if rail != "" {
		return e.fetchSingleRailBalance(ctx, rail)
	}

	configured := e.getConfiguredRails()
	if len(configured) == 0 {
		return nil, nil
	}

	type railRes struct {
		balances []RailBalance
		err      error
	}
	results := make([]railRes, len(configured))
	var wg sync.WaitGroup
	for i, r := range configured {
		wg.Add(1)
		go func(idx int, target PayoutRail) {
			defer wg.Done()
			b, err := e.fetchSingleRailBalance(ctx, target)
			results[idx] = railRes{balances: b, err: err}
		}(i, r)
	}
	wg.Wait()

	var all []RailBalance
	for _, r := range results {
		if r.err != nil {
			return nil, r.err
		}
		all = append(all, r.balances...)
	}
	return all, nil
}

func (e *Engine) getStripeBalances(ctx context.Context) ([]RailBalance, error) {
	if e.config.StripeSecretKey == "" {
		return nil, fmt.Errorf("stripe secret key is not configured")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.stripe.com/v1/balance", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.config.StripeSecretKey)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		pErr := newProviderError(RailStripeConnect, 0, err.Error(), false)
		pErr.Retryable = true
		return nil, pErr
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
		if data.Error != nil && data.Error.Message != "" {
			msg = data.Error.Message
		}
		return nil, newProviderError(RailStripeConnect, resp.StatusCode, msg, false)
	}

	byCurrency := map[string]*RailBalance{}
	var order []string
	for _, a := range data.Available {
		cur := strings.ToUpper(a.Currency)
		byCurrency[cur] = &RailBalance{
			Rail:      RailStripeConnect,
			Currency:  cur,
			Available: fromMinorUnits(a.Amount, cur),
		}
		order = append(order, cur)
	}
	for _, p := range data.Pending {
		cur := strings.ToUpper(p.Currency)
		if b, ok := byCurrency[cur]; ok {
			b.Pending = fromMinorUnits(p.Amount, cur)
		} else {
			byCurrency[cur] = &RailBalance{
				Rail:     RailStripeConnect,
				Currency: cur,
				Pending:  fromMinorUnits(p.Amount, cur),
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

func (e *Engine) getFlutterwaveBalances(ctx context.Context) ([]RailBalance, error) {
	if e.config.FlutterwaveSecretKey == "" {
		return nil, fmt.Errorf("flutterwave secret key is not configured")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.flutterwave.com/v3/balances", nil)
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
			Currency         string  `json:"currency"`
			AvailableBalance float64 `json:"available_balance"`
			LedgerBalance    float64 `json:"ledger_balance"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &flwResp)
	if resp.StatusCode >= 400 || flwResp.Status == "error" {
		return nil, newProviderError(RailFlutterwave, resp.StatusCode, "flutterwave balance error: "+flwResp.Message, false)
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

func (e *Engine) getPaystackBalances(ctx context.Context) ([]RailBalance, error) {
	if e.config.PaystackSecretKey == "" {
		return nil, fmt.Errorf("paystack secret key is not configured")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.paystack.co/balance", nil)
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
			Currency string `json:"currency"`
			Balance  int64  `json:"balance"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bodyBytes, &psResp)
	if resp.StatusCode >= 400 || !psResp.Status {
		return nil, newProviderError(RailPaystack, resp.StatusCode, "paystack balance error: "+psResp.Message, false)
	}

	out := make([]RailBalance, 0, len(psResp.Data))
	for _, row := range psResp.Data {
		cur := strings.ToUpper(row.Currency)
		out = append(out, RailBalance{
			Rail:      RailPaystack,
			Currency:  cur,
			Available: fromMinorUnits(row.Balance, cur),
		})
	}
	return out, nil
}

func (e *Engine) verifyWebhookRaw(rail PayoutRail, rawBody []byte, signature string) (*WebhookEvent, error) {
	switch rail {
	case RailStripeConnect:
		return e.verifyStripeWebhook(rawBody, signature)
	case RailFlutterwave:
		return e.verifyFlutterwaveWebhook(rawBody, signature)
	case RailPaystack:
		return e.verifyPaystackWebhook(rawBody, signature)
	case RailPawaPay:
		return e.verifyPawaPayWebhook(rawBody, signature)
	case RailYellowCard:
		return e.verifyYellowCardWebhook(rawBody, signature)
	case RailMpesaDaraja:
		return e.verifyMpesaDarajaWebhook(rawBody, signature)
	default:
		return nil, fmt.Errorf("unsupported rail: %s", rail)
	}
}

// VerifyWebhook validates a provider webhook signature and checks optional duplicate detection using context.Background().
func (e *Engine) VerifyWebhook(rail PayoutRail, rawBody []byte, signature string) (*WebhookEvent, error) {
	return e.VerifyWebhookContext(context.Background(), rail, rawBody, signature)
}

// VerifyWebhookContext validates a provider webhook signature, normalizes the event, and checks WebhookStore if configured.
func (e *Engine) VerifyWebhookContext(ctx context.Context, rail PayoutRail, rawBody []byte, signature string) (*WebhookEvent, error) {
	ev, err := e.verifyWebhookRaw(rail, rawBody, signature)
	if err != nil {
		return nil, err
	}

	if e.config.WebhookStore != nil {
		keyID := ev.TransactionID
		if keyID == "" {
			keyID = ev.Reference
		}
		eventKey := fmt.Sprintf("%s:%s:%s:%s", rail, ev.EventType, keyID, ev.Status)
		seen, sErr := e.config.WebhookStore.HasSeen(ctx, eventKey)
		if sErr != nil {
			return nil, sErr
		}
		if seen {
			e.emit(TelemetryEvent{Type: "webhook.duplicate", Rail: rail, Reference: ev.Reference})
			if e.config.WebhookDeduplication != nil && e.config.WebhookDeduplication.RejectDuplicates {
				return nil, &ProviderError{
					Rail:    rail,
					Code:    ErrDuplicateWebhook,
					Message: fmt.Sprintf("duplicate webhook event detected on %s for %q", rail, ev.Reference),
				}
			}
			ev.Duplicate = true
			return ev, nil
		}
		ttl := 24 * time.Hour
		if e.config.WebhookDeduplication != nil && e.config.WebhookDeduplication.TTL > 0 {
			ttl = e.config.WebhookDeduplication.TTL
		}
		_ = e.config.WebhookStore.MarkSeen(ctx, eventKey, ttl)
	}

	e.emit(TelemetryEvent{Type: "webhook.verified", Rail: rail, Reference: ev.Reference})
	return ev, nil
}

// VerifyAndConfirmWebhook verifies a webhook signature, guards against duplicates and out-of-order regressions,
// and confirms the authoritative payout state & amount directly against the provider API.
func (e *Engine) VerifyAndConfirmWebhook(ctx context.Context, rail PayoutRail, rawBody []byte, signature, currentStatus, stripeAccountID string) (*WebhookEvent, error) {
	ev, err := e.VerifyWebhookContext(ctx, rail, rawBody, signature)
	if err != nil {
		return nil, err
	}
	if ev.Duplicate {
		return ev, nil
	}

	isReversal := strings.Contains(strings.ToLower(ev.EventType), "reversed")
	if currentStatus != "" && !CanTransitionStatus(currentStatus, ev.Status, isReversal) {
		ev.Status = currentStatus
		return ev, nil
	}

	txID := ev.TransactionID
	if txID == "" {
		txID = ev.Reference
	}
	confirmed, err := e.GetPayoutStatusContext(ctx, PayoutStatusParams{
		TransactionID:   txID,
		Reference:       ev.Reference,
		Rail:            rail,
		StripeAccountID: stripeAccountID,
	})
	if err != nil {
		return nil, err
	}

	if ev.Amount > 0 && confirmed.Amount > 0 && math.Abs(ev.Amount-confirmed.Amount) > 0.01 {
		return nil, fmt.Errorf("webhook amount mismatch on %s: webhook reported %.2f, provider API reported %.2f", rail, ev.Amount, confirmed.Amount)
	}
	if ev.Currency != "" && confirmed.Currency != "" && ev.Currency != confirmed.Currency {
		return nil, fmt.Errorf("webhook currency mismatch on %s: webhook reported %s, provider API reported %s", rail, ev.Currency, confirmed.Currency)
	}

	finalStatus := confirmed.Status
	if currentStatus != "" && !CanTransitionStatus(currentStatus, confirmed.Status, isReversal) {
		finalStatus = currentStatus
	}
	ev.Status = finalStatus
	if confirmed.ProviderStatus != "" {
		ev.ProviderStatus = confirmed.ProviderStatus
	}
	if confirmed.Amount > 0 {
		ev.Amount = confirmed.Amount
	}
	if confirmed.Currency != "" {
		ev.Currency = confirmed.Currency
	}
	if confirmed.Fee > 0 {
		ev.Fee = confirmed.Fee
	}
	if confirmed.Error != "" {
		ev.Error = confirmed.Error
	}
	return ev, nil
}

// MatchAccountNames compares an expected beneficiary name against a resolved bank name.
func (e *Engine) MatchAccountNames(expectedName, resolvedName string, threshold float64) NameMatchResult {
	return MatchAccountNames(expectedName, resolvedName, threshold)
}

// CanTransitionStatus checks whether a payout status transition is valid.
func (e *Engine) CanTransitionStatus(currentStatus, nextStatus string, allowReversal bool) bool {
	return CanTransitionStatus(currentStatus, nextStatus, allowReversal)
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
		return nil, &ProviderError{Rail: RailStripeConnect, Code: ErrWebhookSignature, Message: "invalid Stripe-Signature header format"}
	}

	tsSec, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || tsSec <= 0 {
		return nil, &ProviderError{Rail: RailStripeConnect, Code: ErrWebhookSignature, Message: "invalid stripe webhook timestamp"}
	}
	tolerance := e.config.StripeWebhookTolerance
	if tolerance <= 0 {
		tolerance = 300 * time.Second
	}
	diff := math.Abs(float64(time.Now().Unix() - tsSec))
	if diff > tolerance.Seconds() {
		return nil, &ProviderError{Rail: RailStripeConnect, Code: ErrWebhookSignature, Message: "stripe webhook timestamp outside tolerance window (possible replay attack)"}
	}

	mac := hmac.New(sha256.New, []byte(e.config.StripeWebhookSecret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !constantTimeHexEqual(v1, expected) {
		return nil, &ProviderError{Rail: RailStripeConnect, Code: ErrWebhookSignature, Message: "invalid stripe webhook signature"}
	}

	var payload struct {
		Type string `json:"type"`
		Data struct {
			Object struct {
				ID             string            `json:"id"`
				Status         string            `json:"status"`
				Amount         int64             `json:"amount"`
				Fee            int64             `json:"fee"`
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
	cur := strings.ToUpper(obj.Currency)
	if cur == "" {
		cur = "USD"
	}

	return &WebhookEvent{
		Rail:           RailStripeConnect,
		EventType:      payload.Type,
		TransactionID:  obj.ID,
		Reference:      ref,
		Status:         status,
		ProviderStatus: obj.Status,
		Amount:         fromMinorUnits(obj.Amount, cur),
		Currency:       cur,
		Fee:            fromMinorUnits(obj.Fee, cur),
		Error:          errMsg,
	}, nil
}

func (e *Engine) verifyFlutterwaveWebhook(rawBody []byte, verifHash string) (*WebhookEvent, error) {
	if e.config.FlutterwaveWebhookSecret == "" {
		return nil, fmt.Errorf("flutterwave webhookSecret is required to verify webhooks")
	}
	if verifHash == "" || subtle.ConstantTimeCompare([]byte(verifHash), []byte(e.config.FlutterwaveWebhookSecret)) != 1 {
		return nil, &ProviderError{Rail: RailFlutterwave, Code: ErrWebhookSignature, Message: "invalid flutterwave webhook signature"}
	}

	var payload struct {
		Event string `json:"event"`
		Data  struct {
			ID              int64   `json:"id"`
			Reference       string  `json:"reference"`
			Status          string  `json:"status"`
			Amount          float64 `json:"amount"`
			Currency        string  `json:"currency"`
			Fee             float64 `json:"fee"`
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
		Fee:            payload.Data.Fee,
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
	if !constantTimeHexEqual(signature, expected) {
		return nil, &ProviderError{Rail: RailPaystack, Code: ErrWebhookSignature, Message: "invalid paystack webhook signature"}
	}

	var payload struct {
		Event string `json:"event"`
		Data  struct {
			ID           int64  `json:"id"`
			TransferCode string `json:"transfer_code"`
			Reference    string `json:"reference"`
			Status       string `json:"status"`
			Amount       int64  `json:"amount"`
			Fee          int64  `json:"fee"`
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
	cur := strings.ToUpper(payload.Data.Currency)
	if cur == "" {
		cur = "NGN"
	}

	return &WebhookEvent{
		Rail:           RailPaystack,
		EventType:      payload.Event,
		TransactionID:  txID,
		Reference:      payload.Data.Reference,
		Status:         status,
		ProviderStatus: rawStatus,
		Amount:         fromMinorUnits(payload.Data.Amount, cur),
		Currency:       cur,
		Fee:            fromMinorUnits(payload.Data.Fee, cur),
		Error:          errMsg,
	}, nil
}
