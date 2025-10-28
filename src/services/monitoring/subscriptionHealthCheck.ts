import { EventEmitter } from 'events';

export interface SubscriptionMetrics {
  activeSubscriptions: number;
  totalSubscriptionsCreated: number;
  totalSubscriptionsClosed: number;
  totalEventsEmitted: number;
  lastEventTimestamp: Date | null;
  errors: Array<{
    timestamp: Date;
    error: string;
    deploymentId?: string;
  }>;
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  metrics: SubscriptionMetrics;
  alerts: string[];
}

class SubscriptionHealthMonitor extends EventEmitter {
  private metrics: SubscriptionMetrics = {
    activeSubscriptions: 0,
    totalSubscriptionsCreated: 0,
    totalSubscriptionsClosed: 0,
    totalEventsEmitted: 0,
    lastEventTimestamp: null,
    errors: [],
  };

  private readonly MAX_ERRORS_STORED = 100;
  private readonly STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  trackSubscriptionCreated(deploymentId: string): void {
    this.metrics.activeSubscriptions++;
    this.metrics.totalSubscriptionsCreated++;
    this.emit('subscription:created', { deploymentId, timestamp: new Date() });
  }

  trackSubscriptionClosed(deploymentId: string): void {
    this.metrics.activeSubscriptions = Math.max(0, this.metrics.activeSubscriptions - 1);
    this.metrics.totalSubscriptionsClosed++;
    this.emit('subscription:closed', { deploymentId, timestamp: new Date() });
  }

  trackEventEmitted(): void {
    this.metrics.totalEventsEmitted++;
    this.metrics.lastEventTimestamp = new Date();
  }

  trackError(error: string, deploymentId?: string): void {
    const errorEntry = {
      timestamp: new Date(),
      error,
      deploymentId,
    };

    this.metrics.errors.push(errorEntry);

    // Keep only the last MAX_ERRORS_STORED errors
    if (this.metrics.errors.length > this.MAX_ERRORS_STORED) {
      this.metrics.errors = this.metrics.errors.slice(-this.MAX_ERRORS_STORED);
    }

    this.emit('subscription:error', errorEntry);
  }

  getMetrics(): SubscriptionMetrics {
    return { ...this.metrics };
  }

  performHealthCheck(): HealthCheckResult {
    const alerts: string[] = [];
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    // Check for recent errors
    const recentErrors = this.metrics.errors.filter(
      (error) => Date.now() - error.timestamp.getTime() < 60000 // Last minute
    );

    if (recentErrors.length > 10) {
      alerts.push(`High error rate: ${recentErrors.length} errors in the last minute`);
      status = 'unhealthy';
    } else if (recentErrors.length > 5) {
      alerts.push(`Elevated error rate: ${recentErrors.length} errors in the last minute`);
      status = 'degraded';
    }

    // Check for stale events (only if we have active subscriptions)
    if (this.metrics.activeSubscriptions > 0 && this.metrics.lastEventTimestamp) {
      const timeSinceLastEvent = Date.now() - this.metrics.lastEventTimestamp.getTime();
      if (timeSinceLastEvent > this.STALE_THRESHOLD_MS) {
        alerts.push(
          `No events emitted for ${Math.floor(timeSinceLastEvent / 60000)} minutes despite ${
            this.metrics.activeSubscriptions
          } active subscriptions`
        );
        status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
      }
    }

    // Check for subscription leaks (too many active subscriptions)
    if (this.metrics.activeSubscriptions > 1000) {
      alerts.push(
        `Possible subscription leak: ${this.metrics.activeSubscriptions} active subscriptions`
      );
      status = 'unhealthy';
    } else if (this.metrics.activeSubscriptions > 500) {
      alerts.push(
        `High number of active subscriptions: ${this.metrics.activeSubscriptions}`
      );
      status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
    }

    return {
      status,
      metrics: this.getMetrics(),
      alerts,
    };
  }

  reset(): void {
    this.metrics = {
      activeSubscriptions: 0,
      totalSubscriptionsCreated: 0,
      totalSubscriptionsClosed: 0,
      totalEventsEmitted: 0,
      lastEventTimestamp: null,
      errors: [],
    };
  }
}

export const subscriptionHealthMonitor = new SubscriptionHealthMonitor();
