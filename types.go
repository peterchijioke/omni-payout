package omnipayout

import (
	"context"
	"time"
)

// PayoutRail represents the underlying payment rail.
type PayoutRail string

const (
	RailStripeConnect PayoutRail = "STRIPE_CONNECT"
	RailFlutterwave   PayoutRail = "FLUTTERWAVE"
	RailPaystack      PayoutRail = "PAYSTACK"
	RailPawaPay       PayoutRail = "PAWAPAY"
	RailYellowCard    PayoutRail = "YELLOW_CARD"
	RailMpesaDaraja   PayoutRail = "MPESA_DARAJA"
)

// PayoutSpeed specifies whether payout is standard ACH/batch or instant debit card.
type PayoutSpeed string

const (
	SpeedStandard PayoutSpeed = "standard"
	SpeedInstant  PayoutSpeed = "instant"
)

// CircuitState represents the state of a rail's circuit breaker.
type CircuitState string

const (
	CircuitClosed   CircuitState = "CLOSED"
	CircuitOpen     CircuitState = "OPEN"
	CircuitHalfOpen CircuitState = "HALF_OPEN"
)

// ErrorCode is a normalized, provider-agnostic error classification across all six rails.
type ErrorCode string

const (
	ErrValidation            ErrorCode = "VALIDATION_ERROR"
	ErrIdempotencyConflict   ErrorCode = "IDEMPOTENCY_CONFLICT"
	ErrAuthFailed            ErrorCode = "AUTH_FAILED"
	ErrInvalidAccount        ErrorCode = "INVALID_ACCOUNT"
	ErrInsufficientFloat     ErrorCode = "INSUFFICIENT_FLOAT"
	ErrLimitExceeded         ErrorCode = "LIMIT_EXCEEDED"
	ErrRateLimited           ErrorCode = "RATE_LIMITED"
	ErrProviderDown          ErrorCode = "PROVIDER_DOWN"
	ErrAmbiguousTimeout      ErrorCode = "AMBIGUOUS_TIMEOUT"
	ErrDuplicateReference    ErrorCode = "DUPLICATE_REFERENCE"
	ErrDuplicateWebhook      ErrorCode = "DUPLICATE_WEBHOOK"
	ErrWebhookSignature      ErrorCode = "WEBHOOK_SIGNATURE_INVALID"
	ErrReconciliationTimeout ErrorCode = "RECONCILIATION_TIMEOUT"
	ErrProvider              ErrorCode = "PROVIDER_ERROR"
)

// BankAccountDetails holds African NIP bank transfer destination information.
type BankAccountDetails struct {
	BankCode      string `json:"bankCode"`
	AccountNumber string `json:"accountNumber"`
	AccountName   string `json:"accountName,omitempty"`
}

// MobileMoneyDetails holds African mobile money destination information.
type MobileMoneyDetails struct {
	Phone   string `json:"phone"`
	Network string `json:"network"` // "MTN", "AIRTEL", "MPESA", etc.
}

// DisburseParams defines the unified payout request payload.
type DisburseParams struct {
	Amount                     float64             `json:"amount"`
	Currency                   string              `json:"currency"`
	Reference                  string              `json:"reference"`
	Country                    string              `json:"country,omitempty"`
	Narration                  string              `json:"narration,omitempty"`
	Rail                       PayoutRail          `json:"rail,omitempty"` // Optional: auto-detected if omitted
	FallbackRails              []PayoutRail        `json:"fallbackRails,omitempty"`
	CheckBalanceBeforeDisburse bool                `json:"checkBalanceBeforeDisburse,omitempty"`
	AllowUnsafeTimeoutFailover bool                `json:"allowUnsafeTimeoutFailover,omitempty"`
	StripeAccountID            string              `json:"stripeAccountId,omitempty"`
	Speed                      PayoutSpeed         `json:"speed,omitempty"`
	BankDetails                *BankAccountDetails `json:"bankDetails,omitempty"`
	MobileMoneyDetails         *MobileMoneyDetails `json:"mobileMoneyDetails,omitempty"`
	Metadata                   map[string]string   `json:"metadata,omitempty"`
}

// PayoutStatus represents the normalized settlement status of a payout.
type PayoutStatus string

const (
	StatusPending    PayoutStatus = "PENDING"
	StatusSuccessful PayoutStatus = "SUCCESSFUL"
	StatusFailed     PayoutStatus = "FAILED"
)

// DisburseResult is the normalized result returned from any payout rail.
type DisburseResult struct {
	Success        bool         `json:"success"`
	TransactionID  string       `json:"transactionId"`
	Reference      string       `json:"reference"`
	Status         string       `json:"status"` // "SUCCESSFUL", "PENDING", "FAILED"
	ProviderStatus string       `json:"providerStatus,omitempty"`
	Rail           PayoutRail   `json:"rail"`
	AttemptedRails []PayoutRail `json:"attemptedRails,omitempty"`
	FailoverFrom   PayoutRail   `json:"failoverFrom,omitempty"`
	Amount         float64      `json:"amount"`
	Currency       string       `json:"currency"`
	Fee            float64      `json:"fee,omitempty"`
	Error          string       `json:"error,omitempty"`
}

// PayoutStatusParams defines inputs to fetch the latest status of a payout.
type PayoutStatusParams struct {
	TransactionID   string     `json:"transactionId"`
	Rail            PayoutRail `json:"rail"`
	StripeAccountID string     `json:"stripeAccountId,omitempty"`
	Reference       string     `json:"reference,omitempty"`
}

// ReconcileOptions configures automated status polling for WaitForSettlement.
type ReconcileOptions struct {
	Interval          time.Duration
	MaxAttempts       int
	BackoffMultiplier float64
	MaxInterval       time.Duration
}

// RailBalance represents available and pending float balance for a rail and currency.
type RailBalance struct {
	Rail      PayoutRail `json:"rail"`
	Currency  string     `json:"currency"`
	Available float64    `json:"available"`
	Pending   float64    `json:"pending,omitempty"`
}

// RailHealth reports live uptime/latency and circuit-breaker state for a rail.
type RailHealth struct {
	Rail                PayoutRail   `json:"rail"`
	State               CircuitState `json:"state"`
	Healthy             bool         `json:"healthy"`
	CircuitOpen         bool         `json:"circuitOpen"`
	ConsecutiveFailures int          `json:"consecutiveFailures"`
	TotalRequests       int          `json:"totalRequests"`
	TotalFailures       int          `json:"totalFailures"`
	LastLatencyMs       int64        `json:"lastLatencyMs"`
	AvgLatencyMs        int64        `json:"avgLatencyMs"`
	LastError           string       `json:"lastError,omitempty"`
	CircuitOpenUntil    *time.Time   `json:"circuitOpenUntil,omitempty"`
}

// HealthConfig configures circuit-breaker thresholds per rail.
type HealthConfig struct {
	FailureThreshold int
	Cooldown         time.Duration
	MaxLatency       time.Duration
}

// RetryConfig configures exponential backoff and jitter for retryable transient errors.
type RetryConfig struct {
	MaxRetries   int
	BaseDelay    time.Duration
	MaxDelay     time.Duration
	DisableJitter bool
}

// ProviderFeeRule models a rail's fee structure for lowest-cost routing.
type ProviderFeeRule struct {
	Flat    float64
	Percent float64
}

// RailLimit enforces minimum and maximum payout amounts per rail.
type RailLimit struct {
	MinAmount float64
	MaxAmount float64
}

// RoutingRule defines configurable routing by currency, country, amount limits, and fees.
type RoutingRule struct {
	Currencies []string
	Countries  []string
	MinAmount  float64
	MaxAmount  float64
	Rails      []PayoutRail
	Fees       map[PayoutRail]ProviderFeeRule
}

// IdempotencyRecord holds the parameter fingerprint and optional settled/pending result.
type IdempotencyRecord struct {
	Fingerprint string
	Result      *DisburseResult
}

// IdempotencyStore is a storage-agnostic persistence interface (Redis/Postgres/DynamoDB).
// Omitted by default so omni-payout stays stateless out of the box.
type IdempotencyStore interface {
	Get(ctx context.Context, reference string) (*IdempotencyRecord, error)
	Set(ctx context.Context, reference string, record IdempotencyRecord, ttl time.Duration) error
	Delete(ctx context.Context, reference string) error
}

// WebhookStore is a storage-agnostic interface for duplicate webhook detection.
type WebhookStore interface {
	HasSeen(ctx context.Context, eventKey string) (bool, error)
	MarkSeen(ctx context.Context, eventKey string, ttl time.Duration) error
}

// WebhookDeduplicationConfig configures duplicate webhook handling when WebhookStore is provided.
type WebhookDeduplicationConfig struct {
	TTL              time.Duration
	RejectDuplicates bool
}

// TelemetryEvent is emitted to OnTelemetry for OpenTelemetry, Prometheus, Datadog, or structured logs.
type TelemetryEvent struct {
	Type         string       `json:"type"`
	Rail         PayoutRail   `json:"rail"`
	Reference    string       `json:"reference,omitempty"`
	LatencyMs    int64        `json:"latencyMs,omitempty"`
	ErrorCode    ErrorCode    `json:"errorCode,omitempty"`
	CircuitState CircuitState `json:"circuitState,omitempty"`
	FailoverFrom PayoutRail   `json:"failoverFrom,omitempty"`
	Message      string       `json:"message,omitempty"`
}

// WebhookEvent is the verified, normalized webhook payload from any supported rail.
type WebhookEvent struct {
	Rail           PayoutRail `json:"rail"`
	EventType      string     `json:"eventType"`
	TransactionID  string     `json:"transactionId"`
	Reference      string     `json:"reference"`
	Status         string     `json:"status"`
	ProviderStatus string     `json:"providerStatus,omitempty"`
	Amount         float64    `json:"amount"`
	Currency       string     `json:"currency"`
	Fee            float64    `json:"fee,omitempty"`
	Duplicate      bool       `json:"duplicate,omitempty"`
	Error          string     `json:"error,omitempty"`
}

// NameMatchResult holds the token-similarity comparison between expected and resolved account names.
type NameMatchResult struct {
	Matched            bool    `json:"matched"`
	Score              float64 `json:"score"`
	NormalizedExpected string  `json:"normalizedExpected"`
	NormalizedActual   string  `json:"normalizedActual"`
}

// BankResolutionResult holds the resolved account details from NIP inquiry.
type BankResolutionResult struct {
	AccountName   string `json:"accountName"`
	AccountNumber string `json:"accountNumber"`
	BankCode      string `json:"bankCode"`
}

// OnboardingLinkParams defines inputs to create a Stripe Connect Express link.
type OnboardingLinkParams struct {
	AccountID  string `json:"accountId"`
	RefreshURL string `json:"refreshUrl"`
	ReturnURL  string `json:"returnUrl"`
	Type       string `json:"type,omitempty"`
}

// OnboardingLinkResult contains the hosted onboarding URL.
type OnboardingLinkResult struct {
	URL       string     `json:"url"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

// MpesaDarajaConfig provides Safaricom M-Pesa Daraja B2C credentials.
type MpesaDarajaConfig struct {
	ConsumerKey        string        `json:"-"`
	ConsumerSecret     string        `json:"-"`
	ShortCode          string        `json:"shortCode"`
	InitiatorName      string        `json:"initiatorName"`
	SecurityCredential string        `json:"-"`
	InitiatorPassword  string        `json:"-"`
	CertificatePEM     string        `json:"-"`
	ResultURL          string        `json:"resultUrl"`
	QueueTimeoutURL    string        `json:"queueTimeoutUrl"`
	BaseURL            string        `json:"baseUrl,omitempty"`
	WebhookSecret      string        `json:"-"`
	Timeout            time.Duration `json:"timeout,omitempty"`
}

// String redacts sensitive M-Pesa credentials when printed or logged.
func (c MpesaDarajaConfig) String() string {
	return "MpesaDarajaConfig{ShortCode:" + c.ShortCode + ", Secrets:[REDACTED]}"
}

// Config provides API credentials, timeouts, routing rules, retry policies, and optional pluggable stores.
type Config struct {
	Timeout                  time.Duration                 `json:"timeout,omitempty"`
	ConnectTimeout           time.Duration                 `json:"connectTimeout,omitempty"`
	BalanceCacheTTL          time.Duration                 `json:"balanceCacheTtl,omitempty"`
	IdempotencyTTL           time.Duration                 `json:"idempotencyTtl,omitempty"`
	IdempotencyStore         IdempotencyStore              `json:"-"`
	WebhookStore             WebhookStore                  `json:"-"`
	WebhookDeduplication     *WebhookDeduplicationConfig   `json:"webhookDeduplication,omitempty"`
	OnTelemetry              func(event TelemetryEvent)    `json:"-"`
	Retry                    *RetryConfig                  `json:"retry,omitempty"`
	RoutingRules             []RoutingRule                 `json:"routingRules,omitempty"`
	RailLimits               map[PayoutRail]RailLimit      `json:"railLimits,omitempty"`
	StripeSecretKey          string                        `json:"-"`
	StripeWebhookSecret      string                        `json:"-"`
	StripeWebhookTolerance   time.Duration                 `json:"stripeWebhookTolerance,omitempty"`
	StripeTimeout            time.Duration                 `json:"stripeTimeout,omitempty"`
	FlutterwaveSecretKey     string                        `json:"-"`
	FlutterwaveWebhookSecret string                        `json:"-"`
	FlutterwaveTimeout       time.Duration                 `json:"flutterwaveTimeout,omitempty"`
	PaystackSecretKey        string                        `json:"-"`
	PaystackWebhookSecret    string                        `json:"-"`
	PaystackTimeout          time.Duration                 `json:"paystackTimeout,omitempty"`
	PawaPayAPIToken          string                        `json:"-"`
	PawaPayBaseURL           string                        `json:"pawaPayBaseUrl,omitempty"`
	PawaPayWebhookSecret     string                        `json:"-"`
	PawaPayTimeout           time.Duration                 `json:"pawaPayTimeout,omitempty"`
	YellowCardAPIKey         string                        `json:"-"`
	YellowCardSecretKey      string                        `json:"-"`
	YellowCardBaseURL        string                        `json:"yellowCardBaseUrl,omitempty"`
	YellowCardWebhookSecret  string                        `json:"-"`
	YellowCardTimeout        time.Duration                 `json:"yellowCardTimeout,omitempty"`
	MpesaDaraja              *MpesaDarajaConfig            `json:"mpesaDaraja,omitempty"`
	Health                   *HealthConfig                 `json:"health,omitempty"`
}

// String redacts all API keys and webhook secrets if Config is formatted into logs.
func (c Config) String() string {
	return "omnipayout.Config{Secrets:[REDACTED]}"
}
