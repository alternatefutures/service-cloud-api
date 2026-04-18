/**
 * Contract / regression test for the `runAkashTxAsync` invariant.
 *
 * Akash chain-tx safety:
 *
 *   Every Akash chain-state transition (`akash tx <subcommand>`)
 *   MUST go through `runAkashTxAsync`. That helper is the only path
 *   that:
 *     1. parses the broadcast envelope strictly,
 *     2. asserts `code === 0` (chain acceptance),
 *     3. waits for block inclusion and re-asserts `code === 0` on
 *        the indexed tx.
 *
 *   Bypassing it (calling `runAkashAsync(['tx', ...])` directly,
 *   shelling out to `execCli('akash', ['tx', ...])`, etc.) silently
 *   swallows chain rejections, which is exactly the class of bug
 *   that lost us deployments to "bid taken" / "sequence mismatch"
 *   for hours before the audit caught it.
 *
 * This test scans the production source tree and fails CI if a new
 * direct-tx call site sneaks in. Allow-list entries below are the
 * three places where bypass is *intentional*:
 *
 *   * `runAkashTxAsync` itself, which calls `runAkashAsync` after
 *     adding -o/-y and forwarding through the wallet mutex.
 *   * `akashSteps.ts → failDirectly`: explicit best-effort cleanup
 *     in an *already-failing* enqueue path. We can't afford to throw
 *     on chain errors here because the goal is just to nudge the
 *     on-chain lease toward closed before we mark the local row
 *     FAILED. The caller already swallows the error.
 *   * `providerVerification.ts`: tear-down at the end of the
 *     verifier test suite. Best-effort, gated by a try/catch, runs
 *     in a non-production code path (provider verifier).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// __dirname here is .../src/services/akash; src root is two levels up.
const SRC_DIR = path.join(__dirname, '..', '..')
// SRC_DIR === <repo>/src ; relative paths in violations are e.g.
// "services/akash/orchestrator.ts".

/**
 * Files allowed to call `akash tx ...` outside `runAkashTxAsync`.
 * Each entry should be paired with a clear in-source comment
 * explaining WHY the bypass is intentional and bounded.
 */
const ALLOWED_BYPASS_FILES = new Set<string>([
  // The helper itself wraps runAkashAsync.
  'services/akash/orchestrator.ts',
  // Documented best-effort cleanup paths (see comments above).
  'services/queue/akashSteps.ts',
  'services/providers/providerVerification.ts',
])

const TX_PATTERN = /\b(?:runAkashAsync|execCli|execFileSync|execSync|spawn)\s*\(\s*(?:['"]akash['"]\s*,\s*)?\[?\s*['"]tx['"]/

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...(await walk(full)))
    } else if (entry.isFile() && /\.(ts|js)$/.test(entry.name) && !/\.test\.[tj]s$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('Akash chain-tx safety contract', () => {
  it('every "akash tx" call site goes through runAkashTxAsync', async () => {
    const files = await walk(SRC_DIR)
    const violations: Array<{ file: string; lineNumber: number; line: string }> = []

    for (const file of files) {
      const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/')
      if (ALLOWED_BYPASS_FILES.has(rel)) continue

      const contents = await fs.readFile(file, 'utf8')
      const lines = contents.split(/\r?\n/)
      lines.forEach((line, idx) => {
        // Strip line comments to avoid matching reference docs.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '')
        if (TX_PATTERN.test(code)) {
          violations.push({ file: rel, lineNumber: idx + 1, line: line.trim() })
        }
      })
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  ${v.file}:${v.lineNumber}: ${v.line}`)
        .join('\n')
      throw new Error(
        `Found ${violations.length} Akash-tx call site(s) bypassing runAkashTxAsync:\n${report}\n\n` +
          `Either route the call through runAkashTxAsync (preferred) or, if the bypass is intentional ` +
          `(e.g. best-effort cleanup), add the file to ALLOWED_BYPASS_FILES in this test with a ` +
          `comment explaining why.`,
      )
    }

    expect(violations).toEqual([])
  })
})
