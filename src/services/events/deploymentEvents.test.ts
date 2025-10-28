import { describe, it, expect, beforeEach } from 'vitest';
import { deploymentEvents } from './deploymentEvents.js';
import type { DeploymentLogEvent, DeploymentStatusEvent } from './deploymentEvents.js';

describe('DeploymentEventEmitter', () => {
  const deploymentId = 'test-deployment-123';

  beforeEach(() => {
    // Clear all listeners before each test
    deploymentEvents.removeAllListeners();
  });

  describe('Log Events', () => {
    it('should emit log events', () => {
      return new Promise<void>((resolve) => {
        const logEvent: DeploymentLogEvent = {
          deploymentId,
          timestamp: new Date(),
          message: 'Test log message',
          level: 'info',
        };

        deploymentEvents.onLog(deploymentId, (event) => {
          expect(event).toEqual(logEvent);
          resolve();
        });

        deploymentEvents.emitLog(logEvent);
      });
    });

    it('should handle multiple log listeners', () => {
      let listener1Called = false;
      let listener2Called = false;

      const logEvent: DeploymentLogEvent = {
        deploymentId,
        timestamp: new Date(),
        message: 'Test log',
        level: 'info',
      };

      deploymentEvents.onLog(deploymentId, () => {
        listener1Called = true;
      });

      deploymentEvents.onLog(deploymentId, () => {
        listener2Called = true;
      });

      deploymentEvents.emitLog(logEvent);

      expect(listener1Called).toBe(true);
      expect(listener2Called).toBe(true);
    });

    it('should support different log levels', () => {
      const levels: Array<'info' | 'error' | 'warn'> = ['info', 'error', 'warn'];
      const receivedLevels: string[] = [];

      deploymentEvents.onLog(deploymentId, (event) => {
        receivedLevels.push(event.level);
      });

      levels.forEach((level) => {
        deploymentEvents.emitLog({
          deploymentId,
          timestamp: new Date(),
          message: `Test ${level}`,
          level,
        });
      });

      expect(receivedLevels).toEqual(['info', 'error', 'warn']);
    });

    it('should remove log listeners', () => {
      let callCount = 0;

      const handler = () => {
        callCount++;
      };

      deploymentEvents.onLog(deploymentId, handler);

      deploymentEvents.emitLog({
        deploymentId,
        timestamp: new Date(),
        message: 'Test',
        level: 'info',
      });

      expect(callCount).toBe(1);

      deploymentEvents.removeLogListener(deploymentId, handler);

      deploymentEvents.emitLog({
        deploymentId,
        timestamp: new Date(),
        message: 'Test 2',
        level: 'info',
      });

      expect(callCount).toBe(1); // Should not increment
    });

    it('should only trigger listeners for specific deployment IDs', () => {
      let deployment1Count = 0;
      let deployment2Count = 0;

      deploymentEvents.onLog('deployment-1', () => {
        deployment1Count++;
      });

      deploymentEvents.onLog('deployment-2', () => {
        deployment2Count++;
      });

      deploymentEvents.emitLog({
        deploymentId: 'deployment-1',
        timestamp: new Date(),
        message: 'Test',
        level: 'info',
      });

      expect(deployment1Count).toBe(1);
      expect(deployment2Count).toBe(0);
    });
  });

  describe('Status Events', () => {
    it('should emit status events', () => {
      return new Promise<void>((resolve) => {
        const statusEvent: DeploymentStatusEvent = {
          deploymentId,
          status: 'BUILDING',
          timestamp: new Date(),
        };

        deploymentEvents.onStatus(deploymentId, (event) => {
          expect(event).toEqual(statusEvent);
          resolve();
        });

        deploymentEvents.emitStatus(statusEvent);
      });
    });

    it('should handle multiple status listeners', () => {
      let listener1Called = false;
      let listener2Called = false;

      const statusEvent: DeploymentStatusEvent = {
        deploymentId,
        status: 'SUCCESS',
        timestamp: new Date(),
      };

      deploymentEvents.onStatus(deploymentId, () => {
        listener1Called = true;
      });

      deploymentEvents.onStatus(deploymentId, () => {
        listener2Called = true;
      });

      deploymentEvents.emitStatus(statusEvent);

      expect(listener1Called).toBe(true);
      expect(listener2Called).toBe(true);
    });

    it('should support all deployment statuses', () => {
      const statuses = ['PENDING', 'BUILDING', 'UPLOADING', 'SUCCESS', 'FAILED'];
      const receivedStatuses: string[] = [];

      deploymentEvents.onStatus(deploymentId, (event) => {
        receivedStatuses.push(event.status);
      });

      statuses.forEach((status) => {
        deploymentEvents.emitStatus({
          deploymentId,
          status,
          timestamp: new Date(),
        });
      });

      expect(receivedStatuses).toEqual(statuses);
    });

    it('should remove status listeners', () => {
      let callCount = 0;

      const handler = () => {
        callCount++;
      };

      deploymentEvents.onStatus(deploymentId, handler);

      deploymentEvents.emitStatus({
        deploymentId,
        status: 'BUILDING',
        timestamp: new Date(),
      });

      expect(callCount).toBe(1);

      deploymentEvents.removeStatusListener(deploymentId, handler);

      deploymentEvents.emitStatus({
        deploymentId,
        status: 'SUCCESS',
        timestamp: new Date(),
      });

      expect(callCount).toBe(1); // Should not increment
    });

    it('should only trigger listeners for specific deployment IDs', () => {
      let deployment1Count = 0;
      let deployment2Count = 0;

      deploymentEvents.onStatus('deployment-1', () => {
        deployment1Count++;
      });

      deploymentEvents.onStatus('deployment-2', () => {
        deployment2Count++;
      });

      deploymentEvents.emitStatus({
        deploymentId: 'deployment-1',
        status: 'BUILDING',
        timestamp: new Date(),
      });

      expect(deployment1Count).toBe(1);
      expect(deployment2Count).toBe(0);
    });
  });

  describe('Mixed Events', () => {
    it('should handle both log and status events independently', () => {
      let logCount = 0;
      let statusCount = 0;

      deploymentEvents.onLog(deploymentId, () => {
        logCount++;
      });

      deploymentEvents.onStatus(deploymentId, () => {
        statusCount++;
      });

      deploymentEvents.emitLog({
        deploymentId,
        timestamp: new Date(),
        message: 'Test log',
        level: 'info',
      });

      deploymentEvents.emitStatus({
        deploymentId,
        status: 'BUILDING',
        timestamp: new Date(),
      });

      expect(logCount).toBe(1);
      expect(statusCount).toBe(1);
    });
  });
});
