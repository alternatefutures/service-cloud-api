import { describe, expect, it } from 'vitest'
import { buildCustomDockerPlacementBlock } from './orchestrator.js'

/**
 * Regression tests for issue #233:
 *   "RTX 4060 shows 1 provider / $0.00 but deploys fail with
 *    'No bids received within timeout'"
 *
 * Root cause: generateCustomDockerSDL always included the `signedBy`
 * auditor filter, even for GPU deployments. The bid probe (probeBidSdl.ts)
 * uses `placement: any` with NO signedBy filter — so a non-audited GPU
 * provider (common for less-popular models like RTX 4060) would bid on the
 * probe, appear in the UI, but then be excluded by signedBy on the real
 * deployment SDL. Result: 0 bids → timeout.
 *
 * The fix mirrors the identical conditional in generateSDLFromTemplate
 * (src/templates/sdl.ts): omit signedBy when the deployment uses GPU.
 */
describe('buildCustomDockerPlacementBlock — signedBy conditional (issue #233)', () => {
  const AUDITOR = 'akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63'

  it('omits signedBy for GPU deployments so non-audited providers can bid', () => {
    const block = buildCustomDockerPlacementBlock('my-gpu-svc', true, 1_000_000)
    expect(block).not.toContain('signedBy')
    expect(block).not.toContain(AUDITOR)
  })

  it('includes signedBy for non-GPU deployments', () => {
    const block = buildCustomDockerPlacementBlock('my-web-svc', false, 1_000)
    expect(block).toContain('signedBy')
    expect(block).toContain(AUDITOR)
  })

  it('emits the correct denom and amount for GPU', () => {
    const block = buildCustomDockerPlacementBlock('svc', true, 1_000_000)
    expect(block).toContain('denom: uact')
    expect(block).toContain('amount: 1000000')
  })

  it('emits the correct denom and amount for non-GPU', () => {
    const block = buildCustomDockerPlacementBlock('svc', false, 1_000)
    expect(block).toContain('denom: uact')
    expect(block).toContain('amount: 1000')
  })

  it('uses the provided service name in the pricing block', () => {
    const block = buildCustomDockerPlacementBlock('rtx4060-svc', true, 1_000_000)
    expect(block).toContain('rtx4060-svc:')
  })

  it('produces valid YAML indentation with signedBy (non-GPU)', () => {
    const block = buildCustomDockerPlacementBlock('svc', false, 500)
    // signedBy must be a child of dcloud (6-space indent)
    expect(block).toContain('      signedBy:')
    // anyOf must be a child of signedBy (8-space indent)
    expect(block).toContain('        anyOf:')
    // auditor entry must be under anyOf (10-space indent)
    expect(block).toContain(`          - ${AUDITOR}`)
  })

  it('produces valid YAML indentation without signedBy (GPU)', () => {
    const block = buildCustomDockerPlacementBlock('svc', true, 1_000_000)
    // pricing must be a direct child of dcloud (6-space indent)
    expect(block).toContain('      pricing:')
  })
})
