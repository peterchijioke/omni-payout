package omnipayout

import "time"

// PayoutRail represents the underlying payment rail.
type PayoutRail string

const (
	RailStripeConnect PayoutRail = "STRIPE_CONNECT"
	RailFlutterwave   PayoutRail = "FLUTTERWAVE"
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
	Amount             float64             `json:"amount"`
	Currency           string              `json:"currency"`
	Reference          string              `json:"reference"`
	Narration          string              `json:"narration,omitempty"`
	Rail               PayoutRail          `json:"rail,omitempty"` // Optional: auto-detected if omitted
	StripeAccountID    string              `json:"stripeAccountId,omitempty"`
	Speed              PayoutSpeed         `json:"speed,omitempty"`
	BankDetails        *BankAccountDetails `json:"bankDetails,omitempty"`
	MobileMoneyDetails *MobileMoneyDetails `json:"mobileMoneyDetails,omitempty"`
	Metadata           map[string]string   `json:"metadata,omitempty"`
}

// DisburseResult is the normalized result returned from any payout rail.
type DisburseResult struct {
	Success       bool       `json:"success"`
	TransactionID string     `json:"transactionId"`
	Reference     string     `json:"reference"`
	Status        string     `json:"status"` // "SUCCESSFUL", "PENDING", "FAILED"
	Rail          PayoutRail `json:"rail"`
	Amount        float64    `json:"amount"`
	Currency      string     `json:"currency"`
	Fee           float64    `json:"fee,omitempty"`
	Error         string     `json:"error,omitempty"`
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

// Config provides API credentials for Stripe and Flutterwave.
type Config struct {
	StripeSecretKey      string
	FlutterwaveSecretKey string
}
