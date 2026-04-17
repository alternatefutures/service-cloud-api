/**
 * Wrap a long-lived child process as a LogStream.
 *
 * Lives outside orchestrator.ts so the smoke test can exercise the
 * line-buffering / cleanup logic against a fake command (e.g. `bash -c "for i
 * in 1 2 3; do echo line-$i; sleep 0.05; done"`) without needing a real
 * `provider-services` binary or Akash deployment.
 *
 * Contract:
 *   - emits one `onLine` per LF-terminated line of stdout/stderr
 *   - flushes the trailing partial line on process exit
 *   - emits exactly one `onClose` (with the underlying exit code)
 *   - `close()` SIGTERMs the child, then SIGKILLs after 2s if it lingers
 */

import { spawn } from 'node:child_process'
import type { LogStream } from '../providers/types.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('spawn-log-stream')

export interface SpawnLogStreamOptions {
  /** Time to wait after SIGTERM before SIGKILL. */
  killGraceMs?: number
}

export function spawnLogStream(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: SpawnLogStreamOptions = {},
): LogStream {
  const killGraceMs = opts.killGraceMs ?? 2000

  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const lineCallbacks: Array<(line: string) => void> = []
  const errorCallbacks: Array<(err: Error) => void> = []
  const closeCallbacks: Array<(code: number | null) => void> = []
  let userClosed = false
  let processExited = false
  let stdoutBuf = ''
  let stderrBuf = ''

  const flushPartial = () => {
    for (const remainder of [stdoutBuf, stderrBuf]) {
      if (remainder.length === 0) continue
      for (const cb of lineCallbacks) {
        try { cb(remainder) } catch { /* swallow */ }
      }
    }
    stdoutBuf = ''
    stderrBuf = ''
  }

  const consume = (chunk: string, target: 'out' | 'err') => {
    if (userClosed) return
    const buf = (target === 'out' ? stdoutBuf : stderrBuf) + chunk
    const parts = buf.split('\n')
    const remainder = parts.pop() ?? ''
    if (target === 'out') stdoutBuf = remainder
    else stderrBuf = remainder
    for (const line of parts) {
      if (line.length === 0) continue
      for (const cb of lineCallbacks) {
        try { cb(line) } catch (e) {
          log.warn({ err: e }, 'log stream line callback threw')
        }
      }
    }
  }

  child.stdout.on('data', (c: Buffer) => consume(c.toString(), 'out'))
  child.stderr.on('data', (c: Buffer) => consume(c.toString(), 'err'))

  child.on('error', (err) => {
    if (userClosed) return
    for (const cb of errorCallbacks) {
      try { cb(err) } catch (e) {
        log.warn({ err: e }, 'log stream error callback threw')
      }
    }
  })

  child.on('close', (code) => {
    if (processExited) return
    processExited = true
    if (!userClosed) flushPartial()
    for (const cb of closeCallbacks) {
      try { cb(code) } catch (e) {
        log.warn({ err: e }, 'log stream close callback threw')
      }
    }
  })

  return {
    onLine(cb) { lineCallbacks.push(cb) },
    onError(cb) { errorCallbacks.push(cb) },
    onClose(cb) { closeCallbacks.push(cb) },
    close() {
      if (userClosed) return
      userClosed = true
      // Stop emitting lines immediately. The child.on('close') handler will
      // still fire exactly once after the process actually exits, so callers
      // who await onClose will be unblocked.
      try { child.kill('SIGTERM') } catch (e) {
        log.warn({ err: e }, 'failed to SIGTERM child')
      }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* swallow */ }
      }, killGraceMs)
      child.once('exit', () => clearTimeout(killTimer))
    },
  }
}
