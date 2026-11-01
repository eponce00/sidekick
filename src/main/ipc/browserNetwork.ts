import { ipcMain } from 'electron'
import { browserCertificateApprovals } from '../services/browserCertificateApprovals'
import { browserNetworkApprovals } from '../services/browserNetworkApprovals'
import { getAgentRuntimeCoordinator } from './agentRuns'

export function registerBrowserNetworkHandlers(): void {
  ipcMain.handle('browserNetwork:list', () => browserNetworkApprovals.list())
  ipcMain.handle('browserNetwork:revoke', (_event, origin: unknown) =>
    typeof origin === 'string'
      ? browserNetworkApprovals.revoke(origin)
      : browserNetworkApprovals.list()
  )
  ipcMain.handle('browserNetwork:certificates', () => browserCertificateApprovals.list())
  // Only ever removes: nothing the window sends can add a certificate.
  ipcMain.handle('browserNetwork:revokeCertificate', async (_event, origin: unknown) => {
    if (typeof origin !== 'string') return browserCertificateApprovals.list()
    const next = browserCertificateApprovals.revoke(origin)
    // A connection already past the certificate would otherwise outlive the approval.
    await getAgentRuntimeCoordinator().tools.browser?.service.closeConnections()
    return next
  })
}
