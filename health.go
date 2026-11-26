package omnipayout

import (
	"fmt"
	"sync"
	"time"
)

type internalHealthState struct {
	state               CircuitState
	probeInFlight       bool
	consecutiveFailures int
	totalRequests       int
	totalFailures       int
	totalLatencyMs      int64
	lastLatencyMs       int64
	lastError           string
	circuitOpenUntil    time.Time
}

type railHealthTracker struct {
	mu               sync.RWMutex
	failureThreshold int
	cooldown         time.Duration
	maxLatency       time.Duration
	stats            map[PayoutRail]*internalHealthState
}

func newRailHealthTracker(cfg *HealthConfig) *railHealthTracker {
	threshold := 3
	cooldown := 30 * time.Second
	maxLatency := 10 * time.Second
	if cfg != nil {
		if cfg.FailureThreshold > 0 {
			threshold = cfg.FailureThreshold
		}
		if cfg.Cooldown > 0 {
			cooldown = cfg.Cooldown
		}
		if cfg.MaxLatency > 0 {
			maxLatency = cfg.MaxLatency
		}
	}
	return &railHealthTracker{
		failureThreshold: threshold,
		cooldown:         cooldown,
		maxLatency:       maxLatency,
		stats:            make(map[PayoutRail]*internalHealthState),
	}
}

func (t *railHealthTracker) getOrCreateLocked(rail PayoutRail) *internalHealthState {
	st, ok := t.stats[rail]
	if !ok {
		st = &internalHealthState{state: CircuitClosed}
		t.stats[rail] = st
	}
	return st
}

// tryAcquire transitions OPEN -> HALF_OPEN after cooldown and lets a single recovery probe through.
func (t *railHealthTracker) tryAcquire(rail PayoutRail) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.stats[rail]
	if !ok || st.state == CircuitClosed {
		return true
	}

	now := time.Now()
	if st.state == CircuitOpen {
		if !now.Before(st.circuitOpenUntil) {
			st.state = CircuitHalfOpen
			st.probeInFlight = true
			return true
		}
		return false
	}

	if !st.probeInFlight {
		st.probeInFlight = true
		return true
	}
	return false
}

func (t *railHealthTracker) isAvailable(rail PayoutRail) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	st, ok := t.stats[rail]
	if !ok || st.state == CircuitClosed {
		return true
	}
	if st.state == CircuitOpen {
		return !time.Now().Before(st.circuitOpenUntil)
	}
	return !st.probeInFlight
}

func (t *railHealthTracker) recordSuccess(rail PayoutRail, latency time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	st := t.getOrCreateLocked(rail)
	ms := latency.Milliseconds()
	st.totalRequests++
	st.lastLatencyMs = ms
	st.totalLatencyMs += ms
	st.probeInFlight = false

	if latency > t.maxLatency {
		st.consecutiveFailures++
		st.lastError = fmt.Sprintf("latency %dms exceeded threshold %dms", ms, t.maxLatency.Milliseconds())
		if st.state == CircuitHalfOpen || st.consecutiveFailures >= t.failureThreshold {
			st.state = CircuitOpen
			st.circuitOpenUntil = time.Now().Add(t.cooldown)
		}
		return
	}

	st.state = CircuitClosed
	st.consecutiveFailures = 0
	st.circuitOpenUntil = time.Time{}
}

func (t *railHealthTracker) recordFailure(rail PayoutRail, latency time.Duration, errMsg string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	st := t.getOrCreateLocked(rail)
	ms := latency.Milliseconds()
	st.totalRequests++
	st.totalFailures++
	st.consecutiveFailures++
	st.lastLatencyMs = ms
	st.totalLatencyMs += ms
	st.lastError = errMsg
	st.probeInFlight = false

	if st.state == CircuitHalfOpen || st.consecutiveFailures >= t.failureThreshold {
		st.state = CircuitOpen
		st.circuitOpenUntil = time.Now().Add(t.cooldown)
	}
}

func (t *railHealthTracker) getHealth(rail PayoutRail) RailHealth {
	t.mu.RLock()
	defer t.mu.RUnlock()
	st, ok := t.stats[rail]
	if !ok {
		return RailHealth{
			Rail:    rail,
			State:   CircuitClosed,
			Healthy: true,
		}
	}

	effectiveState := st.state
	if st.state == CircuitOpen && !time.Now().Before(st.circuitOpenUntil) {
		effectiveState = CircuitHalfOpen
	}
	circuitOpen := effectiveState == CircuitOpen
	avgMs := int64(0)
	if st.totalRequests > 0 {
		avgMs = st.totalLatencyMs / int64(st.totalRequests)
	}
	var openUntil *time.Time
	if circuitOpen {
		u := st.circuitOpenUntil
		openUntil = &u
	}
	return RailHealth{
		Rail:                rail,
		State:               effectiveState,
		Healthy:             effectiveState == CircuitClosed,
		CircuitOpen:         circuitOpen,
		ConsecutiveFailures: st.consecutiveFailures,
		TotalRequests:       st.totalRequests,
		TotalFailures:       st.totalFailures,
		LastLatencyMs:       st.lastLatencyMs,
		AvgLatencyMs:        avgMs,
		LastError:           st.lastError,
		CircuitOpenUntil:    openUntil,
	}
}
