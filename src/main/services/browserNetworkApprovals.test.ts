import { describe, expect, it, vi } from 'vitest'

const mainWindow = { id: 'main' }
vi.mock('../ipc/state', () => ({
  getStore: () => undefined,
  appState: { mainWindowRef: mainWindow }
}))
const showTrustedDialog = vi.fn(async () => ({ response: 1, checkboxChecked: false }))
vi.mock('./trustedDialog', () => ({ showTrustedDialog }))

const { BrowserNetworkApprovals, confirmBrowserNetworkOrigin } =
  await import('./browserNetworkApprovals')

function memoryStore(): {
  get: (key: string, fallback?: unknown) => unknown
  set: (key: string, value: unknown) => void
} {
  const values = new Map<string, unknown>()
  return {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    set: (key, value) => values.set(key, value)
  }
}

describe('BrowserNetworkApprovals', () => {
  it('asks once for concurrent navigations, remembers an approval, and forgets a revoked one', async () => {
    const store = memoryStore()
    let resolve: (allowed: boolean) => void = () => undefined
    const confirm = vi.fn(() => new Promise<boolean>((done) => (resolve = done)))
    const approvals = new BrowserNetworkApprovals(
      () => store,
      confirm,
      () => 42
    )

    const first = approvals.approve('http://10.0.0.5:8080')
    const second = approvals.approve('http://10.0.0.5:8080')
    resolve(true)
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(approvals.list()).toEqual([{ origin: 'http://10.0.0.5:8080', approvedAt: 42 }])
    expect(await approvals.approve('http://10.0.0.5:8080')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)

    expect(approvals.revoke('http://10.0.0.5:8080')).toEqual([])
    expect(approvals.approved('http://10.0.0.5:8080')).toBe(false)
  })

  it('stores nothing when the user denies, and refuses anything but a plain HTTP origin', async () => {
    const store = memoryStore()
    const confirm = vi.fn(async () => false)
    const approvals = new BrowserNetworkApprovals(() => store, confirm)

    expect(await approvals.approve('http://10.0.0.5')).toBe(false)
    expect(approvals.list()).toEqual([])
    expect(await approvals.approve('http://10.0.0.5/path')).toBe(false)
    expect(await approvals.approve('https://10.0.0.5')).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)

    store.set('browserNetworkApprovals', [{ origin: 'javascript:alert(1)', approvedAt: 1 }, 'junk'])
    expect(approvals.list()).toEqual([])
  })

  it("hands the navigation's signal to the question, so stopping the run withdraws it", async () => {
    const confirm = vi.fn(async () => true)
    const approvals = new BrowserNetworkApprovals(() => memoryStore(), confirm)
    const run = new AbortController()
    await approvals.approve('http://192.168.1.1', run.signal)
    expect(confirm).toHaveBeenCalledWith('http://192.168.1.1', run.signal)
  })

  it("asks over the app's own window, never the browser page's off-screen one", async () => {
    const run = new AbortController()
    expect(await confirmBrowserNetworkOrigin('http://192.168.1.1', run.signal)).toBe(true)
    expect(showTrustedDialog).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({ message: "Allow SideKick's browser to open http://192.168.1.1?" }),
      { signal: run.signal }
    )
  })
})
