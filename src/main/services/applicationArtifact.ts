import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { SupportDiagnostics } from '../../shared/supportDiagnostics'

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024

/** On-demand support identity, not signature verification or an in-memory attestation. */
export async function applicationArtifact(
  applicationRoot: string
): Promise<NonNullable<SupportDiagnostics['application']['artifact']>> {
  const unavailable = {
    scope: 'main-bundle-on-disk' as const,
    algorithm: 'sha256' as const,
    sha256: null
  }
  try {
    const handle = await fs.open(join(applicationRoot, 'out', 'main', 'index.js'), 'r')
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size <= 0 || before.size > MAX_BUNDLE_BYTES) return unavailable
      const bytes = Buffer.alloc(before.size + 1)
      let total = 0
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null)
        if (!bytesRead) break
        total += bytesRead
      }
      const after = await handle.stat()
      if (
        total !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        after.ino !== before.ino ||
        after.dev !== before.dev
      )
        return unavailable
      return {
        ...unavailable,
        sha256: createHash('sha256').update(bytes.subarray(0, total)).digest('hex')
      }
    } finally {
      await handle.close()
    }
  } catch {
    // Do not serialize paths, exception messages or an invented zero digest.
    return unavailable
  }
}
