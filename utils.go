package omnipayout

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var zeroDecimalCurrencies = map[string]bool{
	"BIF": true, "CLP": true, "DJF": true, "GNF": true, "JPY": true,
	"KMF": true, "KRW": true, "MGA": true, "PYG": true, "RWF": true,
	"UGX": true, "VND": true, "VUV": true, "XAF": true, "XOF": true, "XPF": true,
}

var threeDecimalCurrencies = map[string]bool{
	"BHD": true, "JOD": true, "KWD": true, "OMR": true, "TND": true,
}

var currencyCountries = map[string]string{
	"NGN": "NG",
	"KES": "KE",
	"GHS": "GH",
	"UGX": "UG",
	"TZS": "TZ",
	"RWF": "RW",
	"ZAR": "ZA",
	"ZMW": "ZM",
	"USD": "US",
	"GBP": "GB",
}

var uuidRegex = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var currencyRegex = regexp.MustCompile(`^[A-Za-z]{3}$`)
var digitsRegex = regexp.MustCompile(`^\d{7,15}$`)
var nonAlnumRegex = regexp.MustCompile(`[^a-z0-9\s]+`)

func classifyProviderError(statusCode int, message string, isAmbiguous bool) (ErrorCode, bool) {
	if isAmbiguous {
		return ErrAmbiguousTimeout, false
	}
	lower := strings.ToLower(message)
	if statusCode == 401 || statusCode == 403 || strings.Contains(lower, "unauthorized") || strings.Contains(lower, "invalid key") || strings.Contains(lower, "forbidden") {
		return ErrAuthFailed, false
	}
	if statusCode == 429 || strings.Contains(lower, "rate limit") || strings.Contains(lower, "too many requests") {
		return ErrRateLimited, true
	}
	if statusCode == 409 || strings.Contains(lower, "duplicate") || strings.Contains(lower, "already exists") {
		return ErrDuplicateReference, false
	}
	if strings.Contains(lower, "insufficient") || strings.Contains(lower, "low balance") {
		return ErrInsufficientFloat, false
	}
	if strings.Contains(lower, "limit exceeded") || strings.Contains(lower, "maximum amount") || strings.Contains(lower, "minimum amount") {
		return ErrLimitExceeded, false
	}
	if strings.Contains(lower, "invalid account") || strings.Contains(lower, "invalid recipient") || strings.Contains(lower, "account not found") || strings.Contains(lower, "resolve failed") {
		return ErrInvalidAccount, false
	}
	if statusCode == 503 || statusCode == 501 || strings.Contains(lower, "service unavailable") || strings.Contains(lower, "maintenance") {
		return ErrProviderDown, true
	}
	if statusCode >= 400 && statusCode < 500 {
		return ErrValidation, false
	}
	return ErrProvider, false
}

// ProviderError represents a structured, normalized error returned from a payout provider.
type ProviderError struct {
	Rail        PayoutRail
	Code        ErrorCode
	StatusCode  int
	Message     string
	IsAmbiguous bool
	Retryable   bool
}

func newProviderError(rail PayoutRail, statusCode int, message string, isAmbiguous bool) *ProviderError {
	code, retryable := classifyProviderError(statusCode, message, isAmbiguous)
	return &ProviderError{
		Rail:        rail,
		Code:        code,
		StatusCode:  statusCode,
		Message:     message,
		IsAmbiguous: isAmbiguous,
		Retryable:   retryable,
	}
}

func (e *ProviderError) Error() string {
	return e.Message
}

// AmbiguousPayoutError is returned when a disbursement POST encounters a timeout or
// ambiguous 5xx error and failover is halted to prevent paying the recipient twice.
type AmbiguousPayoutError struct {
	Rail      PayoutRail
	Reference string
	Code      ErrorCode
	Cause     string
}

func (e *AmbiguousPayoutError) Error() string {
	return fmt.Sprintf(
		"ambiguous payout state on %s for reference %q (%s): failover halted to prevent double payout; verify status with GetPayoutStatus before retrying on another rail",
		e.Rail, e.Reference, e.Cause,
	)
}

func currencyExponent(currency string) int {
	upper := strings.ToUpper(currency)
	if zeroDecimalCurrencies[upper] {
		return 0
	}
	if threeDecimalCurrencies[upper] {
		return 3
	}
	return 2
}

// toMinorUnits converts a decimal amount into integer minor units using exact string decimal shifting.
func toMinorUnits(amount float64, currency string) int64 {
	exp := currencyExponent(currency)
	if exp == 0 {
		return int64(math.Round(amount))
	}
	formatted := strconv.FormatFloat(amount, 'f', exp+4, 64)
	neg := strings.HasPrefix(formatted, "-")
	if neg {
		formatted = formatted[1:]
	}
	parts := strings.SplitN(formatted, ".", 2)
	whole, _ := strconv.ParseInt(parts[0], 10, 64)
	frac := ""
	if len(parts) > 1 {
		frac = parts[1]
	}
	for len(frac) < exp+1 {
		frac += "0"
	}
	mainFrac, _ := strconv.ParseInt(frac[:exp], 10, 64)
	guard := frac[exp] - '0'
	minor := whole*int64(math.Pow10(exp)) + mainFrac
	if guard >= 5 {
		minor++
	}
	if neg {
		return -minor
	}
	return minor
}

func fromMinorUnits(minorAmount int64, currency string) float64 {
	exp := currencyExponent(currency)
	if exp == 0 {
		return float64(minorAmount)
	}
	val := float64(minorAmount) / math.Pow10(exp)
	roundFactor := math.Pow10(exp)
	return math.Round(val*roundFactor) / roundFactor
}

func withRetry[T any](ctx context.Context, cfg *RetryConfig, fn func() (T, error), onRetry func(err *ProviderError, attempt int)) (T, error) {
	if cfg == nil || cfg.MaxRetries <= 0 {
		return fn()
	}
	baseDelay := cfg.BaseDelay
	if baseDelay <= 0 {
		baseDelay = 250 * time.Millisecond
	}
	maxDelay := cfg.MaxDelay
	if maxDelay <= 0 {
		maxDelay = 5 * time.Second
	}

	attempt := 0
	for {
		val, err := fn()
		if err == nil {
			return val, nil
		}
		var provErr *ProviderError
		canRetry := attempt < cfg.MaxRetries && errors.As(err, &provErr) && provErr.Retryable && !provErr.IsAmbiguous
		if !canRetry {
			var zero T
			return zero, err
		}

		expDelay := time.Duration(float64(baseDelay) * math.Pow(2, float64(attempt)))
		if expDelay > maxDelay {
			expDelay = maxDelay
		}
		delay := expDelay
		if !cfg.DisableJitter && expDelay > 0 {
			if n, rErr := rand.Int(rand.Reader, big.NewInt(int64(expDelay))); rErr == nil {
				delay = time.Duration(n.Int64())
			}
		}

		attempt++
		if onRetry != nil {
			onRetry(provErr, attempt)
		}

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			var zero T
			return zero, ctx.Err()
		case <-timer.C:
		}
	}
}

func hasControlChars(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return true
		}
	}
	return false
}

func validateDisburseInputs(amount float64, currency, reference string) error {
	if math.IsNaN(amount) || math.IsInf(amount, 0) || amount <= 0 {
		return fmt.Errorf("disbursement amount must be a finite number greater than zero")
	}
	if !currencyRegex.MatchString(currency) {
		return fmt.Errorf("currency must be a valid 3-letter ISO currency code")
	}
	if strings.TrimSpace(reference) == "" {
		return fmt.Errorf("unique reference is required")
	}
	if len(reference) > 200 || hasControlChars(reference) {
		return fmt.Errorf("invalid reference: must be <= 200 characters with no control characters")
	}
	return nil
}

func validateSafeIdentifier(val, fieldName string) (string, error) {
	trimmed := strings.TrimSpace(val)
	if trimmed == "" {
		return "", fmt.Errorf("%s is required", fieldName)
	}
	if len(trimmed) > 200 || hasControlChars(trimmed) || strings.Contains(trimmed, "/") || strings.Contains(trimmed, `\`) || strings.Contains(trimmed, "..") {
		return "", fmt.Errorf("invalid %s: contains unsafe path characters", fieldName)
	}
	return url.PathEscape(trimmed), nil
}

func sanitizeBaseURL(rawURL, defaultURL string) (string, error) {
	if strings.TrimSpace(rawURL) == "" {
		return defaultURL, nil
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("invalid baseURL: %s", rawURL)
	}
	host := parsed.Hostname()
	isLocal := host == "localhost" || host == "127.0.0.1" || host == "::1" || net.ParseIP(host).IsLoopback()
	if parsed.Scheme != "https" && !(isLocal && parsed.Scheme == "http") {
		return "", fmt.Errorf("insecure baseURL scheme %q: https is required", parsed.Scheme)
	}
	if parsed.User != nil {
		return "", fmt.Errorf("baseURL must not embed credentials")
	}
	clean := parsed.Scheme + "://" + parsed.Host + strings.TrimRight(parsed.Path, "/")
	return clean, nil
}

func toDeterministicUUID(reference string) string {
	trimmed := strings.TrimSpace(reference)
	if uuidRegex.MatchString(trimmed) {
		return strings.ToLower(trimmed)
	}
	sum := sha256.Sum256([]byte("omni-payout:pawapay:" + trimmed))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

func isHTTPStatusAmbiguous(statusCode int) bool {
	if statusCode >= 400 && statusCode < 500 {
		return false
	}
	if statusCode == 501 || statusCode == 503 {
		return false
	}
	return statusCode >= 500
}

func constantTimeHexEqual(provided, expectedHex string) bool {
	a := strings.ToLower(strings.TrimSpace(provided))
	b := strings.ToLower(strings.TrimSpace(expectedHex))
	if a == "" || b == "" || len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

var currencyDialCodes = map[string]string{
	"NGN": "234",
	"KES": "254",
	"GHS": "233",
	"UGX": "256",
	"TZS": "255",
	"RWF": "250",
	"ZAR": "27",
	"ZMW": "260",
	"XAF": "237",
	"XOF": "225",
}

// NormalizeMSISDN normalizes phone numbers ("+254 712-345-678", "0712345678") into bare E.164 digits ("254712345678").
func NormalizeMSISDN(phone, currency string) (string, error) {
	trimmed := strings.TrimSpace(phone)
	if trimmed == "" {
		return "", fmt.Errorf("mobile money phone number is required")
	}
	replacer := strings.NewReplacer(" ", "", "-", "", "(", "", ")", "", ".", "")
	cleaned := replacer.Replace(trimmed)
	if strings.HasPrefix(cleaned, "+") {
		cleaned = cleaned[1:]
	} else if strings.HasPrefix(cleaned, "00") {
		cleaned = cleaned[2:]
	} else if strings.HasPrefix(cleaned, "0") && currency != "" {
		if dial, ok := currencyDialCodes[strings.ToUpper(currency)]; ok {
			cleaned = dial + cleaned[1:]
		}
	}
	if !digitsRegex.MatchString(cleaned) {
		return "", fmt.Errorf("invalid mobile money phone number: %q", phone)
	}
	return cleaned, nil
}

// EncryptMpesaInitiatorPassword encrypts a Safaricom initiator password using an X.509 certificate
// or RSA public key PEM (PKCS#1 v1.5 padding, Base64-encoded) to generate SecurityCredential.
func EncryptMpesaInitiatorPassword(initiatorPassword, certificatePEM string) (string, error) {
	if initiatorPassword == "" || certificatePEM == "" {
		return "", fmt.Errorf("both initiatorPassword and certificatePEM are required")
	}
	block, _ := pem.Decode([]byte(certificatePEM))
	if block == nil {
		return "", fmt.Errorf("failed to decode M-Pesa PEM certificate")
	}

	var rsaPub *rsa.PublicKey
	if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
		pub, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return "", fmt.Errorf("certificate public key is not RSA")
		}
		rsaPub = pub
	} else if pubAny, pkErr := x509.ParsePKIXPublicKey(block.Bytes); pkErr == nil {
		pub, ok := pubAny.(*rsa.PublicKey)
		if !ok {
			return "", fmt.Errorf("public key is not RSA")
		}
		rsaPub = pub
	} else if pubPKCS1, p1Err := x509.ParsePKCS1PublicKey(block.Bytes); p1Err == nil {
		rsaPub = pubPKCS1
	} else {
		return "", fmt.Errorf("unsupported M-Pesa certificate/key format: %v", err)
	}

	cipherBytes, err := rsa.EncryptPKCS1v15(rand.Reader, rsaPub, []byte(initiatorPassword))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(cipherBytes), nil
}

var honorificTokens = map[string]bool{
	"mr": true, "mrs": true, "ms": true, "miss": true, "dr": true,
	"prof": true, "chief": true, "alhaji": true, "hajia": true, "engr": true, "sir": true, "lady": true,
}

func tokenizeAccountName(name string) []string {
	cleaned := nonAlnumRegex.ReplaceAllString(strings.ToLower(name), " ")
	var out []string
	for _, tok := range strings.Fields(cleaned) {
		if !honorificTokens[tok] {
			out = append(out, tok)
		}
	}
	return out
}

// MatchAccountNames compares an expected beneficiary name against a resolved bank name.
func MatchAccountNames(expectedName, resolvedName string, threshold float64) NameMatchResult {
	if threshold <= 0 {
		threshold = 0.66
	}
	expTokens := tokenizeAccountName(expectedName)
	actTokens := tokenizeAccountName(resolvedName)
	normExp := strings.Join(expTokens, " ")
	normAct := strings.Join(actTokens, " ")

	if len(expTokens) == 0 || len(actTokens) == 0 {
		return NameMatchResult{Matched: false, Score: 0, NormalizedExpected: normExp, NormalizedActual: normAct}
	}

	expSet := map[string]bool{}
	for _, t := range expTokens {
		expSet[t] = true
	}
	actSet := map[string]bool{}
	unionSet := map[string]bool{}
	for k := range expSet {
		unionSet[k] = true
	}
	for _, t := range actTokens {
		actSet[t] = true
		unionSet[t] = true
	}

	intersection := 0
	for k := range expSet {
		if actSet[k] {
			intersection++
		}
	}

	minSize := len(expSet)
	if len(actSet) < minSize {
		minSize = len(actSet)
	}
	containment := float64(intersection) / float64(minSize)
	jaccard := float64(intersection) / float64(len(unionSet))
	score := math.Round((containment*0.75+jaccard*0.25)*10000) / 10000

	return NameMatchResult{
		Matched:            score >= threshold,
		Score:              score,
		NormalizedExpected: normExp,
		NormalizedActual:   normAct,
	}
}

// CanTransitionStatus guards payout state machines against out-of-order regressions.
func CanTransitionStatus(currentStatus, nextStatus string, allowReversal bool) bool {
	if currentStatus == "" || currentStatus == string(StatusPending) {
		return true
	}
	if currentStatus == nextStatus {
		return true
	}
	if currentStatus == string(StatusSuccessful) && nextStatus == string(StatusFailed) && allowReversal {
		return true
	}
	return false
}

var paystackMomoCodes = map[string]string{
	"MTN":        "MTN",
	"VODAFONE":   "VOD",
	"TELECEL":    "VOD",
	"AIRTEL":     "ATL",
	"AIRTELTIGO": "ATL",
	"MPESA":      "MPESA",
	"ORANGE":     "ORANGE",
	"WAVE":       "WAVE",
}

var crossRailBankCodes = map[string]map[PayoutRail]string{
	"GCB_GHS":           {RailFlutterwave: "GH040100", RailPaystack: "040100", RailYellowCard: "GCB"},
	"ECOBANK_GHS":       {RailFlutterwave: "GH130100", RailPaystack: "130100", RailYellowCard: "ECOBANK"},
	"ABSA_GHS":          {RailFlutterwave: "GH030100", RailPaystack: "030100", RailYellowCard: "ABSA"},
	"STANBIC_GHS":       {RailFlutterwave: "GH190100", RailPaystack: "190100", RailYellowCard: "STANBIC"},
	"FIDELITY_GHS":      {RailFlutterwave: "GH240100", RailPaystack: "240100", RailYellowCard: "FIDELITY"},
	"EQUITY_KES":        {RailFlutterwave: "68", RailPaystack: "68", RailYellowCard: "EQUITY"},
	"KCB_KES":           {RailFlutterwave: "01", RailPaystack: "01", RailYellowCard: "KCB"},
	"COOP_KES":          {RailFlutterwave: "11", RailPaystack: "11", RailYellowCard: "COOP"},
	"ABSA_KES":          {RailFlutterwave: "03", RailPaystack: "03", RailYellowCard: "ABSA"},
	"FNB_ZAR":           {RailFlutterwave: "250655", RailPaystack: "250655", RailYellowCard: "FNB"},
	"ABSA_ZAR":          {RailFlutterwave: "632005", RailPaystack: "632005", RailYellowCard: "ABSA"},
	"STANDARD_BANK_ZAR": {RailFlutterwave: "051001", RailPaystack: "051001", RailYellowCard: "SBSA"},
	"CAPITEC_ZAR":       {RailFlutterwave: "470010", RailPaystack: "470010", RailYellowCard: "CAPITEC"},
	"NEDBANK_ZAR":       {RailFlutterwave: "198765", RailPaystack: "198765", RailYellowCard: "NEDBANK"},
}

// ResolveProviderCode translates canonical mobile-money network codes or cross-corridor bank aliases to the target rail's code.
func ResolveProviderCode(code, currency string, rail PayoutRail, isMobileMoney bool) string {
	upperCode := strings.ToUpper(strings.TrimSpace(code))
	upperCur := strings.ToUpper(strings.TrimSpace(currency))

	if isMobileMoney {
		if rail == RailPaystack {
			if m, ok := paystackMomoCodes[upperCode]; ok {
				return m
			}
			return upperCode
		}
		if rail == RailFlutterwave {
			return strings.ToLower(upperCode)
		}
		return upperCode
	}

	key := upperCode
	if !strings.HasSuffix(key, "_"+upperCur) {
		key = upperCode + "_" + upperCur
	}
	if byRail, ok := crossRailBankCodes[key]; ok {
		if mapped, ok2 := byRail[rail]; ok2 {
			return mapped
		}
	}
	return strings.TrimSpace(code)
}

// InMemoryIdempotencyStore is an optional bounded thread-safe reference implementation of IdempotencyStore.
type InMemoryIdempotencyStore struct {
	mu         sync.Mutex
	maxEntries int
	order      []string
	entries    map[string]struct {
		record    IdempotencyRecord
		expiresAt time.Time
	}
}

func NewInMemoryIdempotencyStore(maxEntries int) *InMemoryIdempotencyStore {
	if maxEntries <= 0 {
		maxEntries = 5000
	}
	return &InMemoryIdempotencyStore{
		maxEntries: maxEntries,
		entries: make(map[string]struct {
			record    IdempotencyRecord
			expiresAt time.Time
		}),
	}
}

func (s *InMemoryIdempotencyStore) Get(_ context.Context, reference string) (*IdempotencyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.entries[reference]
	if !ok {
		return nil, nil
	}
	if !item.expiresAt.IsZero() && time.Now().After(item.expiresAt) {
		delete(s.entries, reference)
		return nil, nil
	}
	rec := item.record
	return &rec, nil
}

func (s *InMemoryIdempotencyStore) Set(_ context.Context, reference string, record IdempotencyRecord, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.entries[reference]; !exists {
		if len(s.entries) >= s.maxEntries && len(s.order) > 0 {
			oldest := s.order[0]
			s.order = s.order[1:]
			delete(s.entries, oldest)
		}
		s.order = append(s.order, reference)
	}
	var exp time.Time
	if ttl > 0 {
		exp = time.Now().Add(ttl)
	}
	s.entries[reference] = struct {
		record    IdempotencyRecord
		expiresAt time.Time
	}{record: record, expiresAt: exp}
	return nil
}

func (s *InMemoryIdempotencyStore) Delete(_ context.Context, reference string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, reference)
	return nil
}

// InMemoryWebhookStore is an optional bounded thread-safe reference implementation of WebhookStore.
type InMemoryWebhookStore struct {
	mu         sync.Mutex
	maxEntries int
	order      []string
	seen       map[string]time.Time
}

func NewInMemoryWebhookStore(maxEntries int) *InMemoryWebhookStore {
	if maxEntries <= 0 {
		maxEntries = 5000
	}
	return &InMemoryWebhookStore{
		maxEntries: maxEntries,
		seen:       make(map[string]time.Time),
	}
}

func (s *InMemoryWebhookStore) HasSeen(_ context.Context, eventKey string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.seen[eventKey]
	if !ok {
		return false, nil
	}
	if !exp.IsZero() && time.Now().After(exp) {
		delete(s.seen, eventKey)
		return false, nil
	}
	return true, nil
}

func (s *InMemoryWebhookStore) MarkSeen(_ context.Context, eventKey string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.seen[eventKey]; !exists {
		if len(s.seen) >= s.maxEntries && len(s.order) > 0 {
			oldest := s.order[0]
			s.order = s.order[1:]
			delete(s.seen, oldest)
		}
		s.order = append(s.order, eventKey)
	}
	var exp time.Time
	if ttl > 0 {
		exp = time.Now().Add(ttl)
	}
	s.seen[eventKey] = exp
	return nil
}
