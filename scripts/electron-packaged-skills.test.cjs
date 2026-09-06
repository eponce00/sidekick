// Packaged runtime regression: controlled local provider, real preload/coordinator/shell.
const assert = require('node:assert/strict')
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync
} = require('node:fs')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { resolve, join, dirname, relative, sep, isAbsolute } = require('node:path')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { _electron: electron } = require('playwright')
const { closeOwned, withDeadline } = require('./electron-packaged-pdf-readonly.cjs')
// Explicit opt-in; the existing host/PowerShell variant remains the default.
const isolation = process.env.SIDEKICK_PACKAGED_SKILLS_DOCKER === '1' ? 'docker' : 'host'
const directOffice = process.env.SIDEKICK_PACKAGED_OFFICE_DIRECT_RUN === '1'

test(
  `packaged agent ${isolation} ${directOffice ? 'direct Office helper' : 'shell'} resolves shipped skill assets through actual preload routing`,
  {
    skip: process.env.SIDEKICK_PACKAGED_SKILLS_RUN !== '1' && !directOffice,
    timeout: 90_000
  },
  async () => {
    assert.equal(process.platform, 'win32', 'This focused packaged probe currently targets Windows')
    const interpreter = directOffice ? process.env.SIDEKICK_DIRECT_HELPER_PYTHON : undefined
    if (directOffice) {
      assert.equal(isolation, 'host', 'Direct helper test must never bypass Docker isolation')
      assert.ok(interpreter && isAbsolute(interpreter) && existsSync(interpreter))
    }
    const executable = resolve(process.env.SIDEKICK_E2E_EXECUTABLE || '')
    assert.ok(
      existsSync(executable) && executable.endsWith('.exe'),
      'Set the explicit packaged executable'
    )
    const expectedAssets = join(
      dirname(executable),
      'resources',
      'app.asar.unpacked',
      'resources',
      'skills'
    )
    assert.ok(existsSync(join(expectedAssets, 'preflight.py')), 'Packaged helper must exist')
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-packaged-skills-'))
    const workspace = join(profile, 'workspace')
    mkdirSync(workspace)
    // Minimal unpacked structural fixture, not a rendered/Office-conformance claim.
    const officeParts = {
      'valid/[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      'valid/_rels/.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'valid/xl/workbook.xml':
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test" sheetId="1" r:id="r1"/></sheets></workbook>',
      'valid/xl/_rels/workbook.xml.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'valid/xl/worksheets/sheet1.xml':
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
      'invalid.xlsx': 'intentionally not an Office archive'
    }
    const hostCommand =
      "$ErrorActionPreference = 'Stop'; $p = (Get-Item -LiteralPath $env:SIDEKICK_SKILLS).FullName; $h = Get-Item -LiteralPath (Join-Path $p 'preflight.py'); $text = Get-Content -LiteralPath $h.FullName -Raw; [ordered]@{assets=$p; helperReadable=($text.Length -gt 0); workspace=$env:WORKSPACE_FOLDER} | ConvertTo-Json -Compress"
    // Read immutable packaged assets only. Write denial is qualified separately on disposable copies.
    const containerProbe =
      "const fs=require('fs'),crypto=require('crypto');const assets=process.env.SIDEKICK_SKILLS;const data=fs.readFileSync(assets+'/preflight.py');console.log(JSON.stringify({assets,helperReadable:data.length>0,workspace:process.cwd(),helperDigest:crypto.createHash('sha256').update(data).digest('hex')}))"
    const command =
      isolation === 'docker' ? `node -e ${JSON.stringify(containerProbe)}` : hostCommand
    let completionCalls = 0
    const helperCatalog = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        if (request.url.endsWith('/models')) {
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify({ data: [{ id: 'packaged-fixture', context_length: 32768 }] })
          )
          return
        }
        if (!request.url.endsWith('/chat/completions')) {
          response.writeHead(404).end()
          return
        }
        const requestBody = JSON.parse(body)
        const toolMessages = (requestBody.messages || []).filter(
          (message) => message.role === 'tool'
        )
        if (directOffice)
          helperCatalog.push({
            afterTools: toolMessages.length,
            advertised: (requestBody.tools || []).some(
              (tool) => tool.function?.name === 'office_preflight'
            )
          })
        const call =
          toolMessages.length === 0
            ? { name: 'use_skill', arguments: JSON.stringify({ skill_id: 'xlsx' }) }
            : toolMessages.length === 1
              ? directOffice
                ? { name: 'office_preflight', arguments: JSON.stringify({ workflow: 'xlsx' }) }
                : { name: 'shell', arguments: JSON.stringify({ command }) }
              : directOffice && toolMessages.length === 2
                ? { name: 'office_validate', arguments: JSON.stringify({ path: 'invalid.xlsx' }) }
                : directOffice && toolMessages.length === 3
                  ? { name: 'office_validate', arguments: JSON.stringify({ path: 'valid' }) }
                  : null
        completionCalls++
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: `fixture-${completionCalls}`, type: 'function', function: call }] } : { content: 'Packaged helper access verified.' }, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`
        )
      })
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    let application
    let page
    let primaryError
    try {
      if (directOffice)
        for (const [relativePath, contents] of Object.entries(officeParts)) {
          const file = join(workspace, relativePath)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, contents, { flag: 'wx' })
        }
      application = await electron.launch({
        executablePath: executable,
        args: ['--disable-gpu', '--sidekick-packaged-smoke-test', '--sidekick-e2e'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          SIDEKICK_E2E_USER_DATA_DIR: profile,
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
        },
        timeout: 30_000
      })
      assert.equal(
        resolve(await application.evaluate(({ app }) => app.getPath('userData'))),
        resolve(profile)
      )
      assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
      page = await application.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.agentRuns))
      if (directOffice) {
        await application.evaluate(({ dialog }, interpreter) => {
          const original = dialog.showMessageBox
          globalThis.sidekickOfficeTestOriginalDialog = original
          globalThis.sidekickOfficeTestOriginalPicker = dialog.showOpenDialog
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [interpreter] })
          dialog.showMessageBox = async (...args) => {
            const options = args.at(-1)
            if (options.title === 'Confirm security-sensitive settings')
              return { response: 1, checkboxChecked: false }
            return original(...args)
          }
        }, interpreter)
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
        await settingsDialog.waitFor({ state: 'visible' })
        await page.getByRole('button', { name: /^Agent/ }).click()
        const field = page.getByRole('textbox', { name: 'Office Python interpreter' })
        assert.equal(await field.inputValue(), '')
        assert.equal(
          await page.getByRole('button', { name: 'Clear Office Python' }).isDisabled(),
          true
        )
        await page.getByRole('button', { name: 'Choose trusted Python' }).click()
        await page.waitForFunction(() =>
          Boolean(document.querySelector('[aria-label="Office Python interpreter"]')?.value)
        )
        await page.getByRole('button', { name: 'Clear Office Python' }).click()
        assert.equal(await field.inputValue(), '')
        await page.getByRole('button', { name: 'Choose trusted Python' }).click()
        await page.waitForFunction(() =>
          Boolean(document.querySelector('[aria-label="Office Python interpreter"]')?.value)
        )
        const selected = await field.inputValue()
        await page.getByRole('button', { name: 'Save changes', exact: true }).click()
        await settingsDialog.waitFor({ state: 'hidden' })
        assert.equal(
          await page.evaluate(
            async () => (await window.api.settings.load()).officeHelperInterpreter
          ),
          selected
        )
      }
      const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
      const runId = await page.evaluate(
        async ({ baseUrl, workspace, isolation, interpreter }) => {
          const model = {
            id: 'packaged-fixture',
            name: 'packaged-fixture',
            provider: 'litellm',
            providerKind: 'litellm',
            providerInstanceId: 'fixture-provider',
            providerModelId: 'packaged-fixture',
            contextLength: 32768,
            maxOutputTokens: 1024,
            supportsTools: true,
            supportsVision: false
          }
          await window.api.settings.save({
            ...(interpreter ? { officeHelperInterpreter: interpreter } : {}),
            providerInstances: [
              {
                id: 'fixture-provider',
                name: 'Loopback fixture',
                type: 'litellm',
                enabled: true,
                baseUrl,
                modelSource: 'manual',
                models: [
                  {
                    id: 'packaged-fixture',
                    enabled: true,
                    contextLength: 32768,
                    maxOutputTokens: 1024,
                    supportsTools: true
                  }
                ]
              }
            ],
            commandPermissionMode: 'full-access',
            shellIsolation: isolation,
            notificationsEnabled: false,
            toolCallLimit: 6
          })
          const project = await window.api.projects.create(workspace, 'Packaged skill fixture')
          const conversation = await window.api.conversations.create(
            'Packaged skill fixture',
            project.id
          )
          await window.api.conversations.saveMessage({
            id: 'fixture-user',
            conversation_id: conversation.id,
            role: 'user',
            content: interpreter
              ? 'Load the xlsx skill, run its direct preflight, then structurally validate invalid.xlsx and the valid unpacked directory. Distinguish invalid content from helper failure. Read-only; do not install packages or change files.'
              : 'Load the xlsx skill and check that its bundled helpers are accessible. Read-only check only; do not install packages or create output files.',
            timestamp: Date.now()
          })
          await window.api.conversations.saveMessage({
            id: 'fixture-assistant',
            conversation_id: conversation.id,
            role: 'agent',
            content: '',
            timestamp: Date.now() + 1
          })
          await window.api.agentRuns.startConversation({
            id: 'packaged-skill-run',
            conversationId: conversation.id,
            assistantMessageId: 'fixture-assistant',
            model
          })
          return 'packaged-skill-run'
        },
        { baseUrl, workspace, isolation, interpreter }
      )
      if (directOffice)
        await application.evaluate(({ dialog }) => {
          dialog.showMessageBox = globalThis.sidekickOfficeTestOriginalDialog
          dialog.showOpenDialog = globalThis.sidekickOfficeTestOriginalPicker
          delete globalThis.sidekickOfficeTestOriginalDialog
          delete globalThis.sidekickOfficeTestOriginalPicker
        })
      let snapshot
      const deadline = Date.now() + 45_000
      do {
        snapshot = await page.evaluate((id) => window.api.agentRuns.events(id), runId)
        if (snapshot.events.some((event) => event.type === 'run.finalized')) break
        await new Promise((done) => setTimeout(done, 100))
      } while (Date.now() < deadline)
      assert.ok(
        snapshot.events.some((event) => event.type === 'run.finalized'),
        'Run must durably finalize before inspection'
      )
      assert.equal(snapshot.run.phase, 'completed')
      const tools = snapshot.events.filter((event) => event.type === 'tool.completed')
      assert.equal(tools.length, directOffice ? 4 : 2)
      assert.deepEqual(
        tools.map((event) => event.payload.name),
        directOffice
          ? ['use_skill', 'office_preflight', 'office_validate', 'office_validate']
          : ['use_skill', 'shell']
      )
      assert.equal(tools[0].payload.result.status, 'success')
      assert.equal(tools[1].payload.result.status, 'success')
      if (directOffice) {
        assert.deepEqual(helperCatalog, [
          { afterTools: 0, advertised: false },
          { afterTools: 1, advertised: true },
          { afterTools: 2, advertised: true },
          { afterTools: 3, advertised: true },
          { afterTools: 4, advertised: true }
        ])
        assert.equal(tools[1].payload.toolCallId, 'fixture-2')
        assert.deepEqual(tools[1].payload.result.data, {
          helper: 'preflight',
          report: { evidence: 'helper_json_report', status: 'available', checks: 1, missing: 0 }
        })
        assert.equal(tools[2].payload.toolCallId, 'fixture-3')
        assert.equal(tools[3].payload.toolCallId, 'fixture-4')
        assert.equal(tools[2].payload.result.status, 'success')
        assert.equal(tools[3].payload.result.status, 'success')
        assert.deepEqual(tools[2].payload.result.data, {
          helper: 'validate',
          report: {
            evidence: 'helper_json_report',
            status: 'structurally_invalid',
            errors: 1,
            warnings: 0
          }
        })
        assert.deepEqual(tools[3].payload.result.data, {
          helper: 'validate',
          report: {
            evidence: 'helper_json_report',
            status: 'structurally_valid',
            errors: 0,
            warnings: 0,
            partsChecked: 5
          }
        })
        const files = readdirSync(workspace, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            relative(workspace, join(entry.parentPath, entry.name)).split(sep).join('/')
          )
          .sort()
        assert.deepEqual(files, Object.keys(officeParts).sort())
        for (const [file, contents] of Object.entries(officeParts))
          assert.equal(
            readFileSync(join(workspace, file), 'utf8'),
            contents,
            'Helpers must preserve fixture bytes'
          )
        assert.equal(completionCalls, 5)
        console.info(
          'Packaged direct Office preflight and valid/invalid structural checks passed through the real coordinator and shipped Python helpers; no model inference, dependency installation or durable private-receipt claim.'
        )
        return
      }
      const probe = JSON.parse(tools[1].payload.result.data.stdout)
      assert.equal(probe.helperReadable, true)
      if (isolation === 'docker') {
        assert.equal(probe.assets, '/sidekick-skills')
        assert.equal(probe.workspace, '/workspace')
        assert.equal(
          probe.helperDigest,
          createHash('sha256')
            .update(readFileSync(join(expectedAssets, 'preflight.py')))
            .digest('hex'),
          'Container helper bytes must match the immutable packaged helper'
        )
      } else {
        assert.equal(resolve(probe.assets), resolve(expectedAssets))
        assert.equal(resolve(probe.workspace), resolve(workspace))
      }
      assert.equal(completionCalls, 3)
      console.info(
        `Packaged skill/preload/${isolation} shell asset wiring passed; helper execution/dependencies not qualified, no installation or model inference used.`
      )
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      const cleanupErrors = []
      let applicationStopped = !application
      try {
        if (page && !page.isClosed())
          await withDeadline(
            () => page.evaluate(() => window.api.agentRuns.stop('packaged-skill-run')),
            5000
          )
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        if (application) await closeOwned(application)
        applicationStopped = true
      } catch (error) {
        cleanupErrors.push(error)
      }
      let containerCleanupConfirmed = isolation !== 'docker'
      try {
        if (isolation === 'docker') {
          // Conservative confirmation only: never stop unrelated app containers.
          const ownedContainers = () =>
            execFileSync(
              'docker',
              ['ps', '-aq', '--filter', 'label=sidekick.role=isolated-shell'],
              { encoding: 'utf8', timeout: 10_000 }
            )
              .trim()
              .split(/\s+/)
              .filter(Boolean)
          assert.deepEqual(
            ownedContainers(),
            [],
            'Fixture containers must stop before profile deletion'
          )
          containerCleanupConfirmed = true
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        server.closeAllConnections()
        await new Promise((done, reject) =>
          server.close((error) => (error ? reject(error) : done()))
        )
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        assert.ok(
          containerCleanupConfirmed && applicationStopped,
          'Retaining fixture profile: process/container cleanup unconfirmed'
        )
        const inside = relative(resolve(tmpdir()), resolve(profile))
        assert.ok(
          inside &&
            !inside.startsWith('..') &&
            !inside.includes(sep + '..') &&
            inside.startsWith('sidekick-e2e-packaged-skills-')
        )
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        assert.equal(existsSync(profile), false)
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length) {
        if (!primaryError)
          throw new AggregateError(cleanupErrors, 'Packaged skill fixture cleanup failed')
        console.error(
          `Packaged skill fixture cleanup also encountered ${cleanupErrors.length} error(s).`
        )
      }
    }
  }
)
