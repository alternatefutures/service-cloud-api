import { EventEmitter } from 'events'
import type { DeploymentProgressEvent } from '../queue/types.js'

export interface DeploymentLogEvent {
  deploymentId: string
  timestamp: Date
  message: string
  level: 'info' | 'error' | 'warn'
}

export interface DeploymentStatusEvent {
  deploymentId: string
  status: string
  timestamp: Date
}

class DeploymentEventEmitter extends EventEmitter {
  emitLog(event: DeploymentLogEvent) {
    this.emit('log', event)
    this.emit(`log:${event.deploymentId}`, event)
  }

  emitStatus(event: DeploymentStatusEvent) {
    this.emit('status', event)
    this.emit(`status:${event.deploymentId}`, event)
  }

  emitProgress(event: DeploymentProgressEvent) {
    this.emit('progress', event)
    this.emit(`progress:${event.deploymentId}`, event)
  }

  onLog(deploymentId: string, handler: (event: DeploymentLogEvent) => void) {
    this.on(`log:${deploymentId}`, handler)
  }

  onStatus(
    deploymentId: string,
    handler: (event: DeploymentStatusEvent) => void
  ) {
    this.on(`status:${deploymentId}`, handler)
  }

  onProgress(
    deploymentId: string,
    handler: (event: DeploymentProgressEvent) => void,
  ) {
    this.on(`progress:${deploymentId}`, handler)
  }

  removeLogListener(
    deploymentId: string,
    handler: (event: DeploymentLogEvent) => void
  ) {
    this.off(`log:${deploymentId}`, handler)
  }

  removeStatusListener(
    deploymentId: string,
    handler: (event: DeploymentStatusEvent) => void
  ) {
    this.off(`status:${deploymentId}`, handler)
  }

  removeProgressListener(
    deploymentId: string,
    handler: (event: DeploymentProgressEvent) => void,
  ) {
    this.off(`progress:${deploymentId}`, handler)
  }
}

// Singleton instance
export const deploymentEvents = new DeploymentEventEmitter()
