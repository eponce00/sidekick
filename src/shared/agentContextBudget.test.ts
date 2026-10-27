import { expect, it } from 'vitest'
import { getAgentToolDefinitions, type AgentToolCatalogOptions } from './agentToolCatalog'
import { DEFAULT_TOOL_CALL_LIMIT } from './agentLimits'
import { PromptComposer, capabilitiesFromTools, createPromptModelProfile } from './prompts'

/**
 * What SideKick sends a model on every turn before any history: the system prompt and the tool
 * schemas. Small local models have little context, so these bytes are a budget. The numbers are
 * checked in beside this test and must match exactly, and CI refuses a pull request that raises
 * one unless it carries the `agent-context-increase` label (scripts/check-agent-context-budget.cjs).
 * After a deliberate change, update the file with `npx vitest run src/shared/agentContextBudget -u`.
 */

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

function toolBudget(options: AgentToolCatalogOptions) {
  const tools = getAgentToolDefinitions(options)
  return {
    tools,
    budget: {
      toolCount: tools.length,
      toolJsonBytes: bytes(JSON.stringify(tools)),
      toolBytes: Object.fromEntries(
        tools
          .map((tool) => [tool.function.name, bytes(JSON.stringify(tool))] as const)
          .sort(([a], [b]) => a.localeCompare(b))
      )
    }
  }
}

it('keeps the per-turn system prompt and tool schemas within the recorded budget', async () => {
  // A full conversation turn on the work machine's setup: a project folder, web search, the
  // browser and code intelligence, as a chat that can start other chats, on a local model.
  const conversation = toolBudget({
    surface: 'conversation',
    sessionRole: 'manager',
    workspaceRoot: '/project',
    webSearchEnabled: true,
    browserEnabled: true,
    codeIntelligenceAvailable: true,
    activeSkillIds: []
  })
  const prompt = new PromptComposer().compose({
    platform: 'windows',
    capabilities: capabilitiesFromTools(conversation.tools),
    permissionMode: 'sensitive-only',
    model: createPromptModelProfile({
      id: 'local:qwen3-27b',
      name: 'Qwen3 27B',
      provider: 'lmstudio',
      providerModelId: 'qwen3-27b'
    }),
    project: { workspaceRoot: '/project', instructions: '', instructionSources: [], memory: '' },
    currentDate: 'Tuesday, October 27, 2026',
    toolRoundLimit: DEFAULT_TOOL_CALL_LIMIT,
    activeSkillIds: [],
    skillAssetsPath: '/skills'
  })
  // A sub-agent reuses its parent's system prompt, so only its tools differ.
  const subagent = toolBudget({
    surface: 'subagent',
    workspaceRoot: '/project',
    webSearchEnabled: true,
    codeIntelligenceAvailable: true
  })
  const budget = {
    conversation: {
      systemPromptBytes: bytes(prompt.content),
      ...conversation.budget
    },
    subagent: subagent.budget
  }
  await expect(`${JSON.stringify(budget, null, 2)}\n`).toMatchFileSnapshot(
    './agentContextBudget.json'
  )
})
