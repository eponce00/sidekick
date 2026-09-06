import { afterAll, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentScenarioHarness, type AgentKernelScenarioInput } from './agentScenarioHarness'
import {
  summarizeReliabilityRun,
  shouldStopReliabilityBatch,
  type ReliabilityMutationExpectation
} from './sessionReliabilityEvidence'
import { openAICompatibleHeaders } from '../providers/openAICompatibleClient'
import { configureCheckpointStorageRoot } from '../services/checkpoints'

const enabled = process.env.SIDEKICK_SESSION_RELIABILITY_RUN === '1'
const startedAt = Date.now()
const deadline = startedAt + 540_000
const evidence: Array<Record<string, unknown>> = []
let providerBlocked = false
const note = (owner: string, revision: string) =>
  `owner=${owner}\nrevision=${revision}\nappend-count=0\n`

async function writeReport(complete = false): Promise<void> {
  if (!enabled) return
  const report = {
    schemaVersion: 4,
    status: complete ? 'complete' : 'running',
    scope:
      'production kernel; retained in-memory conversation history; real disposable Git worktrees; sequential sessions; synthetic text-file side effects; streamed cancellation',
    limitations:
      'Not installed UI, persisted history reconstruction, parallel model decode, general external side-effect reconciliation, or statistical qualification.',
    modelRequested: process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model',
    checkpointIdentity:
      'unverified by this harness; consult independently observed deployment evidence',
    maxOutputTokens: 2048,
    maxToolRounds: 8,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: complete ? new Date().toISOString() : null,
    elapsedMs: Date.now() - startedAt,
    missions: evidence
  }
  const destination = process.env.SIDEKICK_SESSION_RELIABILITY_REPORT
  if (destination) {
    await mkdir(dirname(resolve(destination)), { recursive: true })
    const temporary = resolve(destination) + '.tmp'
    await writeFile(temporary, JSON.stringify(report, null, 2))
    await rename(temporary, resolve(destination))
  }
  if (complete) console.info('[session-reliability]', JSON.stringify(report))
}

afterAll(() => writeReport(true))

it.skipIf(!enabled).for([1, 2, 3, 4, 5])(
  'mission %i: retains corrections, recovers tool failure, cancels and resumes without cross-worktree writes',
  { timeout: 360_000 },
  async (mission, context) => {
    if (providerBlocked) {
      evidence.push({ mission, passed: false, notRunReason: 'prior_provider_failure', stages: [] })
      await writeReport()
      context.skip('Prior provider failure; no further inference requested')
    }
    expect(Date.now()).toBeLessThan(deadline)
    const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY || ''
    expect(Boolean(key)).toBe(true)
    const root = await mkdtemp(join(tmpdir(), 'sidekick-session-reliability-'))
    const repository = join(root, 'repository')
    const workspaceA = join(root, 'worktree-a')
    const workspaceB = join(root, 'worktree-b')
    const hooks = join(root, 'empty-hooks')
    const record: Record<string, unknown> = { mission, passed: false, stages: [] }
    const stages = record.stages as Array<Record<string, unknown>>
    evidence.push(record)
    const missionStart = performance.now()
    const harness = new AgentScenarioHarness(join(root, 'runtime'), {
      endpoint: process.env.SIDEKICK_AGENT_EVAL_URL || 'https://llm.midecasa.com/v1',
      model: process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model',
      headers: openAICompatibleHeaders(key),
      maxOutputTokens: 2048,
      requestTimeoutMs: 60_000
    })
    const threadA = randomUUID()
    const threadB = randomUUID()
    const system = {
      role: 'system' as const,
      content:
        'Use the workspace tools to complete the user task in your assigned project. Read existing files before editing and verify exact final file contents. Preserve unrelated text. Do not append duplicate records or create extra files. Follow recoverable tool errors and report a blocker instead of claiming success when the task is incomplete.'
    }
    const run = async (
      label: string,
      input: AgentKernelScenarioInput,
      options: {
        injectedToolCallIds?: ReadonlySet<string>
        expectation?: ReliabilityMutationExpectation
      } = {}
    ) => {
      const remaining = deadline - Date.now()
      expect(remaining).toBeGreaterThan(0)
      const runId = input.runId ?? randomUUID()
      const timer = setTimeout(() => harness.stop(runId), Math.min(remaining, 90_000))
      const time = performance.now()
      try {
        const result = await harness.run({
          capabilities: ['workspace.read', 'workspace.write'],
          maxToolRounds: 8,
          ...input,
          runId
        })
        const summary = summarizeReliabilityRun(
          result,
          options.injectedToolCallIds,
          options.expectation
        )
        if (shouldStopReliabilityBatch(summary, label === 'a-stream-cancel')) providerBlocked = true
        const stage = {
          label,
          ...summary,
          ...(options.expectation
            ? {
                finalTargetMatchesExpected: await readFile(
                  join(input.workspaceRoot, options.expectation.path),
                  'utf8'
                ).then(
                  (content) => content === options.expectation!.after,
                  () => false
                ),
                finalWorkspaceNamesMatch: await readdir(input.workspaceRoot).then(
                  (names) => JSON.stringify(names.sort()) === JSON.stringify(['.git', 'note.txt']),
                  () => false
                )
              }
            : {}),
          elapsedMs: Math.round(performance.now() - time)
        }
        stages.push(stage)
        console.info('[session-reliability-stage]', JSON.stringify({ mission, ...stage }))
        await writeReport()
        return result
      } finally {
        clearTimeout(timer)
      }
    }
    const assertEdited = (result: Awaited<ReturnType<typeof run>>) => {
      expect(result.phase).toBe('completed')
      expect(summarizeReliabilityRun(result).successfulPatches).toBe(1)
      expect(summarizeReliabilityRun(result).terminalEvents).toBe(1)
    }
    try {
      await mkdir(repository)
      await mkdir(hooks)
      const git = (...args: string[]) =>
        promisify(execFile)('git', ['-c', `core.hooksPath=${hooks}`, '-C', repository, ...args], {
          windowsHide: true
        })
      await git('init', '--quiet')
      await writeFile(join(repository, 'note.txt'), note('seed', 'R1'))
      await git('add', 'note.txt')
      await git(
        '-c',
        'user.name=SideKick Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'synthetic fixture'
      )
      await git('worktree', 'add', '--quiet', '-b', 'session-a', workspaceA)
      await git('worktree', 'add', '--quiet', '-b', 'session-b', workspaceB)
      await writeFile(join(workspaceA, 'note.txt'), note(`alpha-${mission}`, 'R1'))
      await writeFile(join(workspaceB, 'note.txt'), note(`beta-${mission}`, 'R1'))
      configureCheckpointStorageRoot(join(root, 'checkpoints'))
      await harness.initialize()
      let injected = false
      const injectedToolCallIds = new Set<string>()
      let runningPatchId: string | undefined
      const a = await run(
        'a-initial-with-failure',
        {
          workspaceRoot: workspaceA,
          threadId: threadA,
          onEvent: (event) => {
            if (event.type === 'tool.running' && event.payload.name === 'apply_patch')
              runningPatchId = String(event.payload.toolCallId)
          },
          onWorkspaceWillMutate: async () => {
            if (injected) return
            expect(runningPatchId).toBeDefined()
            expect(await readFile(join(workspaceA, 'note.txt'), 'utf8')).toBe(
              note(`alpha-${mission}`, 'R1')
            )
            injected = true
            injectedToolCallIds.add(runningPatchId!)
            throw new Error(
              'Injected transient write failure before any filesystem mutation. Re-read note.txt and retry the requested edit; do not assume it succeeded.'
            )
          },
          messages: [
            system,
            {
              role: 'user',
              content:
                'In note.txt change only revision=R1 to revision=R2. Preserve the owner and append-count lines exactly. Read back and verify the file before reporting completion.'
            }
          ]
        },
        {
          injectedToolCallIds,
          expectation: {
            path: 'note.txt',
            before: note(`alpha-${mission}`, 'R1'),
            after: note(`alpha-${mission}`, 'R2')
          }
        }
      )
      assertEdited(a)
      expect(injected).toBe(true)
      expect(summarizeReliabilityRun(a).toolErrors).toBeGreaterThanOrEqual(1)
      expect(await readFile(join(workspaceA, 'note.txt'), 'utf8')).toBe(
        note(`alpha-${mission}`, 'R2')
      )
      expect(await readFile(join(workspaceB, 'note.txt'), 'utf8')).toBe(
        note(`beta-${mission}`, 'R1')
      )
      const b = await run(
        'b-independent-session',
        {
          workspaceRoot: workspaceB,
          threadId: threadB,
          messages: [
            system,
            {
              role: 'user',
              content:
                'In note.txt change only revision=R1 to revision=B9. Preserve all other lines exactly and verify the result.'
            }
          ]
        },
        {
          expectation: {
            path: 'note.txt',
            before: note(`beta-${mission}`, 'R1'),
            after: note(`beta-${mission}`, 'B9')
          }
        }
      )
      assertEdited(b)
      expect(await readFile(join(workspaceB, 'note.txt'), 'utf8')).toBe(
        note(`beta-${mission}`, 'B9')
      )
      expect(await readFile(join(workspaceA, 'note.txt'), 'utf8')).toBe(
        note(`alpha-${mission}`, 'R2')
      )
      const cancelledId = randomUUID()
      let stopAccepted = false
      const cancelled = await run('a-stream-cancel', {
        runId: cancelledId,
        threadId: threadA,
        workspaceRoot: workspaceA,
        capabilities: [],
        messages: [
          ...a.messages,
          {
            role: 'user',
            content:
              'Do not edit files. Write a detailed numbered list of 100 synthetic review considerations for this tiny note format.'
          }
        ],
        onEvent: (event) => {
          if (!stopAccepted && event.type === 'assistant.delta')
            stopAccepted = harness.stop(cancelledId)
        }
      })
      expect(stopAccepted).toBe(true)
      expect(cancelled.phase).toBe('cancelled')
      expect(cancelled.toolNames).toEqual([])
      expect(summarizeReliabilityRun(cancelled).terminalEvents).toBe(1)
      const corrected = await run(
        'a-correction-after-cancel',
        {
          workspaceRoot: workspaceA,
          threadId: threadA,
          messages: [
            ...a.messages,
            {
              role: 'user',
              content:
                'I cancelled the review. Correction: use revision=R3, not R2, in note.txt. Keep the original owner and append-count unchanged. Edit only that revision line and verify the exact final contents.'
            }
          ]
        },
        {
          expectation: {
            path: 'note.txt',
            before: note(`alpha-${mission}`, 'R2'),
            after: note(`alpha-${mission}`, 'R3')
          }
        }
      )
      assertEdited(corrected)
      expect(await readFile(join(workspaceA, 'note.txt'), 'utf8')).toBe(
        note(`alpha-${mission}`, 'R3')
      )
      expect(await readFile(join(workspaceB, 'note.txt'), 'utf8')).toBe(
        note(`beta-${mission}`, 'B9')
      )
      expect(await readFile(join(repository, 'note.txt'), 'utf8')).toBe(note('seed', 'R1'))
      expect((await git('status', '--porcelain')).stdout.trim()).toBe('')
      expect((await readdir(workspaceA)).sort()).toEqual(['.git', 'note.txt'])
      expect((await readdir(workspaceB)).sort()).toEqual(['.git', 'note.txt'])
      record.passed = true
    } finally {
      record.elapsedMs = Math.round(performance.now() - missionStart)
      await harness.close()
      await rm(root, { recursive: true, force: true })
      await writeReport()
    }
  }
)
