import { describe, it, expect, beforeEach, vi } from 'vitest'
import { subscriptionHealthMonitor } from './subscriptionHealthCheck.js'

describe('SubscriptionHealthMonitor', () => {
  beforeEach(() => {
    subscriptionHealthMonitor.reset()
    subscriptionHealthMonitor.removeAllListeners()
  })

  describe('Metrics Tracking', () => {
    it('should track subscription creation', () => {
      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-1')
      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-2')

      const metrics = subscriptionHealthMonitor.getMetrics()
      expect(metrics.activeSubscriptions).toBe(2)
      expect(metrics.totalSubscriptionsCreated).toBe(2)
    })

    it('should track subscription closure', () => {
      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-1')
      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-2')
      subscriptionHealthMonitor.trackSubscriptionClosed('deployment-1')

      const metrics = subscriptionHealthMonitor.getMetrics()
      expect(metrics.activeSubscriptions).toBe(1)
      expect(metrics.totalSubscriptionsClosed).toBe(1)
    })

    it('should not go below zero active subscriptions', () => {
      subscriptionHealthMonitor.trackSubscriptionClosed('deployment-1')

      const metrics = subscriptionHealthMonitor.getMetrics()
      expect(metrics.activeSubscriptions).toBe(0)
    })

    it('should track event emissions', () => {
      subscriptionHealthMonitor.trackEventEmitted()
      subscriptionHealthMonitor.trackEventEmitted()

      const metrics = subscriptionHealthMonitor.getMetrics()
      expect(metrics.totalEventsEmitted).toBe(2)
      expect(metrics.lastEventTimestamp).toBeInstanceOf(Date)
    })

    it('should track errors', () => {
      subscriptionHealthMonitor.trackError('Test error 1', 'deployment-1')
      subscriptionHealthMonitor.trackError('Test error 2')

      const metrics = subscriptionHealthMonitor.getMetrics()
      expect(metrics.errors).toHaveLength(2)
      expect(metrics.errors[0].error).toBe('Test error 1')
      expect(metrics.errors[0].deploymentId).toBe('deployment-1')
      expect(metrics.errors[1].error).toBe('Test error 2')
    })

    it('should limit stored errors to MAX_ERRORS_STORED', () => {
      // Add 150 errors (max is 100)
      for (let i = 0; i < 150; i++) {
        subscriptionHealthMonitor.trackError(`Error ${i}`)
      }

      const metrics = subscriptionHealthMonitor.getMetrics()
      expect(metrics.errors).toHaveLength(100)
      // Should have the last 100 errors
      expect(metrics.errors[0].error).toBe('Error 50')
      expect(metrics.errors[99].error).toBe('Error 149')
    })
  })

  describe('Health Checks', () => {
    it('should report healthy status with no issues', () => {
      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-1')
      subscriptionHealthMonitor.trackEventEmitted()

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('healthy')
      expect(health.alerts).toHaveLength(0)
    })

    it('should report unhealthy status with high error rate', () => {
      // Add 11 errors in the last minute
      for (let i = 0; i < 11; i++) {
        subscriptionHealthMonitor.trackError(`Error ${i}`)
      }

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('unhealthy')
      expect(health.alerts).toContain(
        'High error rate: 11 errors in the last minute'
      )
    })

    it('should report degraded status with moderate error rate', () => {
      // Add 6 errors in the last minute
      for (let i = 0; i < 6; i++) {
        subscriptionHealthMonitor.trackError(`Error ${i}`)
      }

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('degraded')
      expect(health.alerts).toContain(
        'Elevated error rate: 6 errors in the last minute'
      )
    })

    it('should not alert on old errors', () => {
      // Add an old error (more than 1 minute ago)
      subscriptionHealthMonitor.trackError('Old error')

      // Manually set the error timestamp to be old
      const metrics = subscriptionHealthMonitor.getMetrics()
      if (metrics.errors.length > 0) {
        metrics.errors[0].timestamp = new Date(Date.now() - 2 * 60 * 1000)
      }

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('healthy')
      expect(health.alerts).toHaveLength(0)
    })

    it('should alert on stale events with active subscriptions', () => {
      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-1')

      // Set last event to 6 minutes ago (threshold is 5 minutes)
      subscriptionHealthMonitor.trackEventEmitted()
      const metrics = subscriptionHealthMonitor.getMetrics()
      if (metrics.lastEventTimestamp) {
        // @ts-ignore - Accessing private property for testing
        subscriptionHealthMonitor.metrics.lastEventTimestamp = new Date(
          Date.now() - 6 * 60 * 1000
        )
      }

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('degraded')
      expect(
        health.alerts.some(alert => alert.includes('No events emitted'))
      ).toBe(true)
    })

    it('should not alert on stale events with no active subscriptions', () => {
      // No active subscriptions, so stale events are expected
      subscriptionHealthMonitor.trackEventEmitted()
      const metrics = subscriptionHealthMonitor.getMetrics()
      if (metrics.lastEventTimestamp) {
        // @ts-ignore - Accessing private property for testing
        subscriptionHealthMonitor.metrics.lastEventTimestamp = new Date(
          Date.now() - 6 * 60 * 1000
        )
      }

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('healthy')
      expect(health.alerts).toHaveLength(0)
    })

    it('should alert on possible subscription leak', () => {
      // Create 1001 subscriptions
      for (let i = 0; i < 1001; i++) {
        subscriptionHealthMonitor.trackSubscriptionCreated(`deployment-${i}`)
      }

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('unhealthy')
      expect(
        health.alerts.some(alert =>
          alert.includes('Possible subscription leak')
        )
      ).toBe(true)
    })

    it('should alert on high number of subscriptions', () => {
      // Create 501 subscriptions
      for (let i = 0; i < 501; i++) {
        subscriptionHealthMonitor.trackSubscriptionCreated(`deployment-${i}`)
      }

      const health = subscriptionHealthMonitor.performHealthCheck()
      expect(health.status).toBe('degraded')
      expect(
        health.alerts.some(alert =>
          alert.includes('High number of active subscriptions')
        )
      ).toBe(true)
    })
  })

  describe('Event Emission', () => {
    it('should emit subscription:created event', () => {
      const handler = vi.fn()
      subscriptionHealthMonitor.on('subscription:created', handler)

      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-1')

      expect(handler).toHaveBeenCalledWith({
        deploymentId: 'deployment-1',
        timestamp: expect.any(Date),
      })
    })

    it('should emit subscription:closed event', () => {
      const handler = vi.fn()
      subscriptionHealthMonitor.on('subscription:closed', handler)

      subscriptionHealthMonitor.trackSubscriptionClosed('deployment-1')

      expect(handler).toHaveBeenCalledWith({
        deploymentId: 'deployment-1',
        timestamp: expect.any(Date),
      })
    })

    it('should emit subscription:error event', () => {
      const handler = vi.fn()
      subscriptionHealthMonitor.on('subscription:error', handler)

      subscriptionHealthMonitor.trackError('Test error', 'deployment-1')

      expect(handler).toHaveBeenCalledWith({
        timestamp: expect.any(Date),
        error: 'Test error',
        deploymentId: 'deployment-1',
      })
    })
  })

  describe('Reset', () => {
    it('should reset all metrics', () => {
      subscriptionHealthMonitor.trackSubscriptionCreated('deployment-1')
      subscriptionHealthMonitor.trackEventEmitted()
      subscriptionHealthMonitor.trackError('Error')

      subscriptionHealthMonitor.reset()

      const metrics = subscriptionHealthMonitor.getMetrics()
      expect(metrics.activeSubscriptions).toBe(0)
      expect(metrics.totalSubscriptionsCreated).toBe(0)
      expect(metrics.totalSubscriptionsClosed).toBe(0)
      expect(metrics.totalEventsEmitted).toBe(0)
      expect(metrics.lastEventTimestamp).toBeNull()
      expect(metrics.errors).toHaveLength(0)
    })
  })
})
