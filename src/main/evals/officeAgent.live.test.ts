import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { configureCheckpointStorageRoot } from '../services/checkpoints'
import { AgentScenarioHarness } from './agentScenarioHarness'
import {
  OFFICE_AGENT_REPORT_SCHEMA_VERSION,
  officeAgentCapabilities,
  officeAgentScenarios,
  officeAgentSystemPrompt,
  officeArtifactOutcome,
  officeSourceDigest,
  officeSourceUnchanged,
  summarizeOfficeTrace,
  type OfficeToolTrace
} from './officeAgentScenarios'

const execute = promisify(execFile)
const enabled = process.env.SIDEKICK_OFFICE_AGENT_EVAL_RUN === '1'
const helpers = resolve('resources/skills')
const fixture = resolve('src/main/evals/fixtures/office-agent/fixture.py')
const python =
  process.env.SIDEKICK_OFFICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

it.skipIf(!enabled)(
  'qualifies actual skill, shell and saved Office artifact journeys serially',
  async () => {
    const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY?.trim()
    if (!key) throw new Error('Office evaluation requires an explicit evaluation API key')
    const endpoint = process.env.SIDEKICK_AGENT_EVAL_URL || process.env.SIDEKICK_AGENT_EVAL_ENDPOINT
    if (!endpoint) throw new Error('Office evaluation requires an explicit endpoint')
    const model = process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model'
    const repetitions = Number(process.env.SIDEKICK_OFFICE_AGENT_EVAL_REPETITIONS || '1')
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3)
      throw new Error('Repetitions must be 1–3')
    const reports: Array<Record<string, unknown> & { passed: boolean }> = []
    let abortLane = false
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const scenario of officeAgentScenarios) {
        const root = await fs.mkdtemp(join(tmpdir(), 'sidekick-office-agent-'))
        const workspace = join(root, 'workspace')
        await fs.mkdir(workspace)
        const harness = new AgentScenarioHarness(join(root, 'runtime'), {
          endpoint,
          model,
          headers: { Authorization: `Bearer ${key}` },
          skillAssetsPath: helpers,
          maxOutputTokens: 4096,
          requestTimeoutMs: 120_000
        })
        const trace: OfficeToolTrace[] = []
        const runId = randomUUID()
        const started = Date.now()
        let timer: ReturnType<typeof setTimeout> | undefined
        let stage: 'fixture_creation' | 'agent_run' | 'artifact_reopen' | 'structural_validation' =
          'fixture_creation'
        let sourceUnchanged: boolean | null = null
        let phase: string | null = null
        let original: string | null = null
        const sourcePath = join(workspace, scenario.input)
        try {
          await execute(python, ['-B', fixture, 'create', scenario.id, workspace], {
            timeout: 30_000
          })
          original = await officeSourceDigest(sourcePath)
          configureCheckpointStorageRoot(join(root, 'checkpoints'))
          await harness.initialize()
          timer = setTimeout(() => harness.stop(runId), 300_000)
          stage = 'agent_run'
          const result = await harness.run({
            runId,
            workspaceRoot: workspace,
            capabilities: officeAgentCapabilities,
            maxToolRounds: 24,
            messages: [
              { role: 'system', content: officeAgentSystemPrompt(workspace, helpers, model) },
              {
                role: 'user',
                content: `${scenario.task}\nFirst load the relevant skill and run its read-only workflow preflight. This is a synthetic content/structure test: do not render, use a browser or install dependencies. Use project script files for generated task code. Verify the saved artifact before reporting success.`
              }
            ],
            afterToolExecution: async (name, args, result) => {
              const tool = result as {
                status?: unknown
                data?: { stdout?: string; exitCode?: number }
                error?: { code?: unknown; recoveryAction?: unknown }
              }
              trace.push({
                name,
                arguments: args,
                status: tool.status,
                stdout: tool.data?.stdout,
                exitCode: tool.data?.exitCode,
                errorCode: tool.error?.code,
                recoveryAction: tool.error?.recoveryAction
              })
            }
          })
          phase = result.phase
          sourceUnchanged = await officeSourceUnchanged(sourcePath, original)
          if (result.phase !== 'completed') {
            abortLane = true
            throw new Error('Run did not complete; stopping the lane conservatively')
          }
          stage = 'artifact_reopen'
          const verification = await execute(
            python,
            ['-B', fixture, 'verify', scenario.id, workspace],
            { timeout: 30_000 }
          )
          stage = 'structural_validation'
          await execute(
            python,
            ['-B', join(helpers, 'office/validate.py'), join(workspace, scenario.output)],
            { timeout: 30_000 }
          )
          const artifacts = JSON.parse(verification.stdout)
          const journey = summarizeOfficeTrace(scenario, trace)
          reports.push({
            ...officeArtifactOutcome(
              result.phase,
              sourceUnchanged === true,
              artifacts.passed === true,
              journey.passed
            ),
            scenario: scenario.id,
            repetition,
            phase: result.phase,
            sourceUnchanged,
            artifacts,
            journey,
            wallMs: Date.now() - started
          })
        } catch {
          if (stage === 'agent_run') abortLane = true
          sourceUnchanged = await officeSourceUnchanged(sourcePath, original)
          reports.push({
            passed: false,
            scenario: scenario.id,
            repetition,
            failureStage: stage,
            phase,
            sourceUnchanged,
            journey: summarizeOfficeTrace(scenario, trace),
            wallMs: Date.now() - started
          })
        } finally {
          if (timer) clearTimeout(timer)
          await harness.close()
          await fs.rm(root, { recursive: true, force: true })
          const reportPath = process.env.SIDEKICK_OFFICE_AGENT_EVAL_REPORT
          if (reportPath)
            await fs.writeFile(
              reportPath,
              JSON.stringify(
                {
                  schemaVersion: OFFICE_AGENT_REPORT_SCHEMA_VERSION,
                  scope: 'synthetic-content-structure-no-render',
                  requestedModel: model,
                  reports
                },
                null,
                2
              )
            )
        }
        if (abortLane) break
      }
      if (abortLane) break
    }
    expect(
      reports.every((report) => report.passed),
      JSON.stringify(reports)
    ).toBe(true)
  },
  2_900_000
)
