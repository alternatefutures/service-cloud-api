/**
 * Async wrappers for CLI execution, replacing execSync to avoid blocking the event loop.
 */

import { execFile, spawn } from 'child_process'

const DEFAULT_TIMEOUT_MS = 120_000

export function execAsync(
  command: string,
  args: string[],
  options?: {
    env?: Record<string, string>
    timeout?: number
    maxBuffer?: number
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS
    const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024

    const child = execFile(command, args, {
      env: options?.env,
      timeout,
      maxBuffer,
      encoding: 'utf-8',
    }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.slice(0, 500) || error.message
        reject(new Error(`${command} failed: ${msg}`))
        return
      }
      resolve(stdout)
    })

    child.on('error', reject)
  })
}

export function spawnAsync(
  command: string,
  args: string[],
  options?: {
    env?: Record<string, string>
    timeout?: number
    shell?: boolean
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS
    const child = spawn(command, args, {
      env: options?.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options?.shell,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out after ${timeout}ms`))
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(0, 500)}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
