package omnipayout

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var zeroDecimalCurrencies = map[string]bool{
	"BIF": true, "CLP": true, "DJF": true, "GNF": true, "JPY": true,
	"KMF": true, "KRW": true, "MGA": true, "PYG": true, "RWF": true,
	"UGX": true, "VND": true, "VUV": true, "XAF": true, "XOF": true, "XPF": true,
}

var threeDecimalCurrencies = map[string]bool{
	"BHD": true, "JOD": true, "KWD": true, "OMR": true, "TND": true,
}

var uuidRegex = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var currencyRegex = regexp.MustCompile(`^[A-Za-z]{3}$`)

// ProviderError represents a structured error returned from a payout provider.
type ProviderError struct {
	Rail        PayoutRail
	StatusCode  int
	Message     string
	IsAmbiguous bool
}

func (e *ProviderError) Error() string {
	return e.Message
}

// AmbiguousPayoutError is returned when a disbursement POST encounters a timeout or
// ambiguous 5xx error and failover is halted to prevent paying the recipient twice.
type AmbiguousPayoutError struct {
	Rail      PayoutRail
	Reference string
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

func toMinorUnits(amount float64, currency string) int64 {
	exp := currencyExponent(currency)
	factor := math.Pow10(exp)
	scaled, _ := strconv.ParseFloat(strconv.FormatFloat(amount*factor, 'g', 15, 64), 64)
	return int64(math.Round(scaled))
}

func fromMinorUnits(minorAmount int64, currency string) float64 {
	exp := currencyExponent(currency)
	return float64(minorAmount) / math.Pow10(exp)
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
