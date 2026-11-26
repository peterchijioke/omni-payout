import { CircuitState, HealthConfig, PayoutRail, RailHealth } from './types';

interface InternalHealthState {
  state: CircuitState;
  probeInFlight: boolean;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
  lastError?: string;
  circuitOpenUntil: number;
}

export class RailHealthTracker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxLatencyMs: number;
  private readonly stats = new Map<PayoutRail, InternalHealthState>();

  constructor(config?: HealthConfig) {
    this.failureThreshold = config?.failureThreshold ?? 3;
    this.cooldownMs = config?.cooldownMs ?? 30_000;
    this.maxLatencyMs = config?.maxLatencyMs ?? 10_000;
  }

  private getOrCreate(rail: PayoutRail): InternalHealthState {
    let st = this.stats.get(rail);
    if (!st) {
      st = {
        state: 'CLOSED',
        probeInFlight: false,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        totalLatencyMs: 0,
        lastLatencyMs: 0,
        circuitOpenUntil: 0,
      };
      this.stats.set(rail, st);
    }
    return st;
  }

  /**
   * Checks whether a rail can accept a request, transitioning OPEN -> HALF_OPEN
   * after cooldown and allowing a single recovery probe through.
   */
  tryAcquire(rail: PayoutRail): boolean {
    const st = this.stats.get(rail);
    if (!st || st.state === 'CLOSED') return true;

    const now = Date.now();
    if (st.state === 'OPEN') {
      if (now >= st.circuitOpenUntil) {
        st.state = 'HALF_OPEN';
        st.probeInFlight = true;
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow only one recovery probe at a time
    if (!st.probeInFlight) {
      st.probeInFlight = true;
      return true;
    }
    return false;
  }

  isAvailable(rail: PayoutRail): boolean {
    const st = this.stats.get(rail);
    if (!st || st.state === 'CLOSED') return true;
    if (st.state === 'OPEN') {
      return Date.now() >= st.circuitOpenUntil;
    }
    return !st.probeInFlight;
  }

  recordSuccess(rail: PayoutRail, latencyMs: number): void {
    const st = this.getOrCreate(rail);
    st.totalRequests += 1;
    st.lastLatencyMs = latencyMs;
    st.totalLatencyMs += latencyMs;
    st.probeInFlight = false;

    if (latencyMs > this.maxLatencyMs) {
      st.consecutiveFailures += 1;
      st.lastError = `Latency ${latencyMs}ms exceeded threshold ${this.maxLatencyMs}ms`;
      if (st.state === 'HALF_OPEN' || st.consecutiveFailures >= this.failureThreshold) {
        st.state = 'OPEN';
        st.circuitOpenUntil = Date.now() + this.cooldownMs;
      }
      return;
    }

    // Probe succeeded or normal request succeeded -> close circuit
    st.state = 'CLOSED';
    st.consecutiveFailures = 0;
    st.circuitOpenUntil = 0;
  }

  recordFailure(rail: PayoutRail, latencyMs: number, errorMessage: string): void {
    const st = this.getOrCreate(rail);
    st.totalRequests += 1;
    st.totalFailures += 1;
    st.consecutiveFailures += 1;
    st.lastLatencyMs = latencyMs;
    st.totalLatencyMs += latencyMs;
    st.lastError = errorMessage;
    st.probeInFlight = false;

    // If HALF_OPEN probe fails, re-open immediately; otherwise open at threshold
    if (st.state === 'HALF_OPEN' || st.consecutiveFailures >= this.failureThreshold) {
      st.state = 'OPEN';
      st.circuitOpenUntil = Date.now() + this.cooldownMs;
    }
  }

  getHealth(rail: PayoutRail): RailHealth {
    const st = this.stats.get(rail);
    if (!st) {
      return {
        rail,
        state: 'CLOSED',
        healthy: true,
        circuitOpen: false,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        lastLatencyMs: 0,
        avgLatencyMs: 0,
      };
    }

    const now = Date.now();
    let effectiveState: CircuitState = st.state;
    if (st.state === 'OPEN' && now >= st.circuitOpenUntil) {
      effectiveState = 'HALF_OPEN';
    }
    const circuitOpen = effectiveState === 'OPEN';

    return {
      rail,
      state: effectiveState,
      healthy: effectiveState === 'CLOSED',
      circuitOpen,
      consecutiveFailures: st.consecutiveFailures,
      totalRequests: st.totalRequests,
      totalFailures: st.totalFailures,
      lastLatencyMs: st.lastLatencyMs,
      avgLatencyMs: st.totalRequests > 0 ? Math.round(st.totalLatencyMs / st.totalRequests) : 0,
      lastError: st.lastError,
      circuitOpenUntil: circuitOpen ? new Date(st.circuitOpenUntil) : undefined,
    };
  }
}
