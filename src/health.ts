import { HealthConfig, PayoutRail, RailHealth } from './types';

interface InternalHealthState {
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
    let state = this.stats.get(rail);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        totalLatencyMs: 0,
        lastLatencyMs: 0,
        circuitOpenUntil: 0,
      };
      this.stats.set(rail, state);
    }
    return state;
  }

  isAvailable(rail: PayoutRail): boolean {
    const state = this.stats.get(rail);
    if (!state) return true;
    return Date.now() >= state.circuitOpenUntil;
  }

  recordSuccess(rail: PayoutRail, latencyMs: number): void {
    const state = this.getOrCreate(rail);
    state.totalRequests += 1;
    state.lastLatencyMs = latencyMs;
    state.totalLatencyMs += latencyMs;

    if (latencyMs > this.maxLatencyMs) {
      state.consecutiveFailures += 1;
      state.lastError = `Latency ${latencyMs}ms exceeded threshold ${this.maxLatencyMs}ms`;
      if (state.consecutiveFailures >= this.failureThreshold) {
        state.circuitOpenUntil = Date.now() + this.cooldownMs;
      }
      return;
    }

    state.consecutiveFailures = 0;
    state.circuitOpenUntil = 0;
  }

  recordFailure(rail: PayoutRail, latencyMs: number, errorMessage: string): void {
    const state = this.getOrCreate(rail);
    state.totalRequests += 1;
    state.totalFailures += 1;
    state.consecutiveFailures += 1;
    state.lastLatencyMs = latencyMs;
    state.totalLatencyMs += latencyMs;
    state.lastError = errorMessage;

    if (state.consecutiveFailures >= this.failureThreshold) {
      state.circuitOpenUntil = Date.now() + this.cooldownMs;
    }
  }

  getHealth(rail: PayoutRail): RailHealth {
    const state = this.stats.get(rail);
    if (!state) {
      return {
        rail,
        healthy: true,
        circuitOpen: false,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        lastLatencyMs: 0,
        avgLatencyMs: 0,
      };
    }

    const circuitOpen = Date.now() < state.circuitOpenUntil;
    return {
      rail,
      healthy: !circuitOpen,
      circuitOpen,
      consecutiveFailures: state.consecutiveFailures,
      totalRequests: state.totalRequests,
      totalFailures: state.totalFailures,
      lastLatencyMs: state.lastLatencyMs,
      avgLatencyMs: state.totalRequests > 0 ? Math.round(state.totalLatencyMs / state.totalRequests) : 0,
      lastError: state.lastError,
      circuitOpenUntil: circuitOpen ? new Date(state.circuitOpenUntil) : undefined,
    };
  }
}
