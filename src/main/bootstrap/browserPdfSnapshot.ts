import { constants, promises as fs } from 'fs'

// Match the default remote PDF input limit; saving has its separate output limit.
export const MAX_BROWSER_PDF_SOURCE_BYTES = 64 * 1024 * 1024

const messages = {
  unavailable: 'PDF session or source is no longer available',
  invalid: 'PDF source must be a nonempty regular file',
  oversized: 'PDF source exceeds the 64 MiB input limit; open a smaller document',
  changed: 'PDF source changed while being read; close and reopen the document',
  unreadable: 'Could not read the PDF source safely; close and reopen the document'
} as const
export class BrowserPdfSnapshotError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
  }
}
function safeReadError(error: unknown): BrowserPdfSnapshotError {
  if (error instanceof BrowserPdfSnapshotError) return error
  return new BrowserPdfSnapshotError(
    (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'unavailable' : 'unreadable'
  )
}

/** Read one bounded version through one handle; never reopen a mutable path mid-read. */
export async function readBrowserPdfSnapshot(
  sourcePath: string,
  assertActive: () => void
): Promise<Buffer> {
  assertActive()
  // On POSIX, opening a named pipe must not block before fstat can reject it.
  const handle = await fs
    .open(
      sourcePath,
      process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK
    )
    .catch((error) => {
      throw safeReadError(error)
    })
  let result: Buffer
  let closeError: unknown
  try {
    assertActive()
    const before = await handle.stat()
    assertActive()
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0)
      throw new BrowserPdfSnapshotError('invalid')
    if (before.size > MAX_BROWSER_PDF_SOURCE_BYTES) throw new BrowserPdfSnapshotError('oversized')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      assertActive()
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(65536, bytes.length - offset),
        offset
      )
      if (!bytesRead) throw new BrowserPdfSnapshotError('changed')
      offset += bytesRead
    }
    // An extra byte detects growth without allocating from a later, untrusted size.
    assertActive()
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset)
    const after = await handle.stat()
    assertActive()
    if (
      extra.bytesRead ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new BrowserPdfSnapshotError('changed')
    }
    result = bytes
  } catch (error) {
    throw safeReadError(error)
  } finally {
    try {
      await handle.close()
    } catch (error) {
      closeError = error
    }
  }
  if (closeError) throw safeReadError(closeError)
  return result
}
