import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { LspClient } from './lspClient'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

describe('LspClient', () => {
  it('speaks JSON-RPC, receives diagnostics, and performs semantic requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidekick-lsp-client-'))
    roots.push(root)
    const source = join(root, 'app.ts')
    const server = join(root, 'server.cjs')
    await writeFile(source, 'const answer: number = "wrong"\n')
    await writeFile(
      server,
      `let buffer = Buffer.alloc(0)
const send = (message) => { const body = Buffer.from(JSON.stringify(message)); process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n'); process.stdout.write(body) }
process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const marker = buffer.indexOf('\\r\\n\\r\\n'); if (marker < 0) return; const length = Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, marker).toString())?.[1] || 0); if (buffer.length < marker + 4 + length) return; const message = JSON.parse(buffer.subarray(marker + 4, marker + 4 + length)); buffer = buffer.subarray(marker + 4 + length); if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { diagnosticProvider: true, hoverProvider: true } } }); else if (message.method === 'textDocument/didOpen') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: message.params.textDocument.uri, diagnostics: [{ severity: 1, message: 'Type mismatch', source: 'fake', range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } }] } }); else if (message.method === 'textDocument/diagnostic') send({ jsonrpc: '2.0', id: message.id, result: { kind: 'full', items: [{ severity: 1, message: 'Type mismatch', source: 'fake', range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } }] } }); else if (message.method === 'textDocument/hover') send({ jsonrpc: '2.0', id: message.id, result: { contents: 'number' } }); else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null }); } })`
    )
    const client = new LspClient(root, {
      id: 'fake',
      name: 'Fake language server',
      languages: ['typescript'],
      extensions: ['.ts'],
      rootMarkers: [],
      commands: [],
      command: process.execPath,
      args: [server],
      origin: 'path'
    })

    expect(await client.diagnosticsFor(source)).toContainEqual(
      expect.objectContaining({ severity: 'error', message: 'Type mismatch', line: 1, column: 7 })
    )
    expect(await client.requestForFile('textDocument/hover', source, 0, 6)).toEqual({
      contents: 'number'
    })
    await client.close()
  })
})
