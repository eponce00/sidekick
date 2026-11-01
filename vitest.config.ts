import { configDefaults, defineConfig } from 'vitest/config'

const windows = process.platform === 'win32'

// Generated artifacts and private user workspaces are never test inputs.
// A positive source boundary also excludes future output directory names.
const include = ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)']

/**
 * Tests that start shells, PowerShell or helper programs. On Windows, process creation contends
 * and side-by-side runs left orphaned PowerShell trees, so these run one file at a time there.
 */
const processTests = [
  'src/main/control/commandLineTool.test.ts',
  'src/main/evals/*.live.test.ts',
  'src/main/evals/harnessFaults.test.ts',
  'src/main/evals/officeAgentScenarios.test.ts',
  'src/main/evals/officeHarnessWiring.test.ts',
  'src/main/ipc/worktreeSetup.test.ts',
  'src/main/services/*.live.test.ts',
  'src/main/services/agentBrowserToolHandlers.test.ts',
  'src/main/services/agentRecoveryCrash.test.ts',
  'src/main/services/agentRunCrash.test.ts',
  'src/main/services/agentRunKernel.test.ts',
  'src/main/services/agentSkillToolHandlers.test.ts',
  'src/main/services/agentToolRuntime.test.ts',
  'src/main/services/appUpdateInstaller.test.ts',
  'src/main/services/command*.test.ts',
  'src/main/services/conversationRunPreparer.*.test.ts',
  'src/main/services/credentialRedactionPoints.test.ts',
  'src/main/services/directOfficeHelper*.test.ts',
  'src/main/services/officeHelperWiring.test.ts',
  'src/main/services/toolRefusals.test.ts',
  'src/main/services/workspaceVerificationService.test.ts',
  'src/main/services/worktreeCreationHooks.test.ts'
]

/**
 * Tests that run git in repositories of their own and start no shell. They run in parallel, but
 * git on Windows is slow enough under antivirus scanning that a test can take over 15 seconds.
 * Together they were two thirds of a ten-minute run when every file ran one at a time.
 */
const gitTests = [
  'src/main/services/checkpoints.test.ts',
  'src/main/services/managedWorktreeService.test.ts'
]

export default defineConfig({
  test: {
    // Windows process starts are slow; the default 5 seconds failed tests that only waited.
    ...(windows ? { testTimeout: 15_000, hookTimeout: 15_000 } : {}),
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include,
          exclude: [...configDefaults.exclude, ...processTests, ...gitTests]
        }
      },
      {
        extends: true,
        test: {
          name: 'git',
          include: gitTests,
          testTimeout: windows ? 60_000 : 30_000,
          hookTimeout: windows ? 60_000 : 30_000
        }
      },
      {
        extends: true,
        test: { name: 'processes', include: processTests, fileParallelism: !windows }
      }
    ]
  }
})
