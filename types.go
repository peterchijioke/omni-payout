package omnipayout

import "time"

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
	Narration                  string              `json:"narration,omitempty"`
	Rail                       PayoutRail          `json:"rail,omitempty"` // Optional: auto-detected if omitted
	FallbackRails              []PayoutRail        `json:"fallbackRails,omitempty"`
	CheckBalanceBeforeDisburse bool                `json:"checkBalanceBeforeDisburse,omitempty"`
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

// RailBalance represents available and pending float balance for a rail and currency.
type RailBalance struct {
	Rail      PayoutRail `json:"rail"`
	Currency  string     `json:"currency"`
	Available float64    `json:"available"`
	Pending   float64    `json:"pending,omitempty"`
}

// RailHealth reports live uptime/latency and circuit-breaker state for a rail.
type RailHealth struct {
	Rail                PayoutRail `json:"rail"`
	Healthy             bool       `json:"healthy"`
	CircuitOpen         bool       `json:"circuitOpen"`
	ConsecutiveFailures int        `json:"consecutiveFailures"`
	TotalRequests       int        `json:"totalRequests"`
	TotalFailures       int        `json:"totalFailures"`
	LastLatencyMs       int64      `json:"lastLatencyMs"`
	AvgLatencyMs        int64      `json:"avgLatencyMs"`
	LastError           string     `json:"lastError,omitempty"`
	CircuitOpenUntil    *time.Time `json:"circuitOpenUntil,omitempty"`
}

// HealthConfig configures circuit-breaker thresholds per rail.
type HealthConfig struct {
	FailureThreshold int
	Cooldown         time.Duration
	MaxLatency       time.Duration
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
	Error          string     `json:"error,omitempty"`
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
	ConsumerKey        string
	ConsumerSecret     string
	ShortCode          string
	InitiatorName      string
	SecurityCredential string
	ResultURL          string
	QueueTimeoutURL    string
	BaseURL            string
	WebhookSecret      string
}

// Config provides API credentials, webhook secrets, and health thresholds for all rails.
type Config struct {
	StripeSecretKey          string
	StripeWebhookSecret      string
	FlutterwaveSecretKey     string
	FlutterwaveWebhookSecret string
	PaystackSecretKey        string
	PaystackWebhookSecret    string
	PawaPayAPIToken          string
	PawaPayBaseURL           string
	PawaPayWebhookSecret     string
	YellowCardAPIKey         string
	YellowCardSecretKey      string
	YellowCardBaseURL        string
	YellowCardWebhookSecret  string
	MpesaDaraja              *MpesaDarajaConfig
	Health                   *HealthConfig
}
