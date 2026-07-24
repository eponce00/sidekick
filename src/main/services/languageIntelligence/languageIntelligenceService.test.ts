import { existsSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { LanguageIntelligenceService } from './languageIntelligenceService'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('LanguageIntelligenceService', () => {
  it('does not auto-run a project binary, then provides new and resolved diagnostic deltas after trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-language-intelligence-'))
    roots.push(root)
    const source = join(root, 'app.ts')
    const marker = join(root, 'server-started')
    const server = join(root, 'fake-server.cjs')
    const bin = join(root, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    await writeFile(source, 'const answer = "wrong"\n')
    await writeFile(
      server,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')
let buffer = Buffer.alloc(0); const documents = new Map()
const send = (message) => { const body = Buffer.from(JSON.stringify(message)); process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n'); process.stdout.write(body) }
const diagnostics = (uri) => String(documents.get(uri) || '').includes('wrong') ? [{ severity: 1, message: 'Wrong value', source: 'fake', range: { start: { line: 0, character: 15 }, end: { line: 0, character: 22 } } }] : []
process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const marker = buffer.indexOf('\\r\\n\\r\\n'); if (marker < 0) return; const length = Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, marker).toString())?.[1] || 0); if (buffer.length < marker + 4 + length) return; const message = JSON.parse(buffer.subarray(marker + 4, marker + 4 + length)); buffer = buffer.subarray(marker + 4 + length); if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { diagnosticProvider: true } } }); else if (message.method === 'textDocument/didOpen') documents.set(message.params.textDocument.uri, message.params.textDocument.text); else if (message.method === 'textDocument/didChange') documents.set(message.params.textDocument.uri, message.params.contentChanges[0].text); else if (message.method === 'textDocument/diagnostic') send({ jsonrpc: '2.0', id: message.id, result: { kind: 'full', items: diagnostics(message.params.textDocument.uri) } }); else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null }); } })`
    )
    const executable = join(bin, 'typescript-language-server')
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}\n`
    )
    await chmod(executable, 0o755)

    const service = new LanguageIntelligenceService()
    expect(service.workspaceStatus(root)).toMatchObject({
      available: true,
      availableServers: [expect.objectContaining({ id: 'typescript', origin: 'workspace' })]
    })
    service.observeFile(root, 'app.ts')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(existsSync(marker)).toBe(false)

    const explicit = await service.execute(root, {
      operation: 'diagnostics',
      filePath: 'app.ts'
    })
    expect(existsSync(marker)).toBe(true)
    expect(explicit.result).toEqual([
      expect.objectContaining({ severity: 'error', message: 'Wrong value' })
    ])

    await writeFile(source, 'const answer = "still wrong"\n')
    expect(
      await service.diagnosticsAfterChanges(root, [{ path: 'app.ts', kind: 'update' }])
    ).toMatchObject({
      complete: true,
      diagnostics: [expect.objectContaining({ message: 'Wrong value', state: 'new' })]
    })

    await writeFile(source, 'const answer = 42\n')
    expect(
      await service.diagnosticsAfterChanges(root, [{ path: 'app.ts', kind: 'update' }])
    ).toMatchObject({
      complete: true,
      diagnostics: [expect.objectContaining({ message: 'Wrong value', state: 'resolved' })]
    })
    await service.close()
  })

  it('rejects semantic paths outside the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-language-security-'))
    roots.push(root)
    const service = new LanguageIntelligenceService()
    await expect(
      service.execute(root, { operation: 'diagnostics', filePath: '../outside.ts' })
    ).rejects.toThrow('Path escapes the project root')
    await service.close()
  })
})
