import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetOpsAlertDedupeForTesting, opsAlert } from './opsAlert.js'

const originalFetch = global.fetch
const originalWebhook = process.env.OPS_ALERT_WEBHOOK_URL

describe('opsAlert', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetOpsAlertDedupeForTesting()
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalWebhook === undefined) {
      delete process.env.OPS_ALERT_WEBHOOK_URL
    } else {
      process.env.OPS_ALERT_WEBHOOK_URL = originalWebhook
    }
  })

  it('does not call fetch when OPS_ALERT_WEBHOOK_URL is unset', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL
    await opsAlert({
      key: 'test-no-webhook',
      title: 'test',
      message: 'test body',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts a discord embed when OPS_ALERT_WEBHOOK_URL is set', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://discord.example.test/hook'
    await opsAlert({
      key: 'test-webhook',
      title: 'Wallet low',
      message: 'Deployer wallet under threshold',
      context: { balanceAct: '4.20', thresholdUact: '5000000' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://discord.example.test/hook')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.embeds[0].title).toContain('Wallet low')
    expect(body.embeds[0].description).toContain(
      'Deployer wallet under threshold'
    )
    const fields = body.embeds[0].fields as Array<{
      name: string
      value: string
    }>
    expect(fields.find(f => f.name === 'balanceAct')?.value).toBe('4.20')
  })

  it('suppresses repeat alerts for the same key within the window', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://discord.example.test/hook'
    await opsAlert({
      key: 'dedupe-test',
      title: 't',
      message: 'm',
    })
    await opsAlert({
      key: 'dedupe-test',
      title: 't',
      message: 'm',
    })
    await opsAlert({
      key: 'dedupe-test',
      title: 't',
      message: 'm',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not suppress different keys', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://discord.example.test/hook'
    await opsAlert({ key: 'k1', title: 't', message: 'm' })
    await opsAlert({ key: 'k2', title: 't', message: 'm' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not throw when the webhook fetch fails', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://discord.example.test/hook'
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(
      opsAlert({ key: 'fetch-fail', title: 't', message: 'm' })
    ).resolves.toBeUndefined()
  })

  it('does not throw when the webhook returns non-2xx', async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://discord.example.test/hook'
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 })
    await expect(
      opsAlert({ key: 'fetch-429', title: 't', message: 'm' })
    ).resolves.toBeUndefined()
  })
})
