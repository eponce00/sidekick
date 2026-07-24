import { describe, expect, it } from 'vitest'
import { agentRunProfile, getAgentToolCatalog, getAgentToolDefinitions } from './agentToolCatalog'

const names = (options: Parameters<typeof getAgentToolDefinitions>[0]): string[] =>
  getAgentToolDefinitions(options).map(({ function: tool }) => tool.name)

describe('canonical agent tool catalog', () => {
  it('uses the same command/background names for conversations and collaboration', () => {
    const conversation = names({ surface: 'conversation', webSearchEnabled: true })
    const collaboration = names({ surface: 'collaboration', webSearchEnabled: true })

    for (const name of [
      'execute_command',
      'list_background_tasks',
      'cancel_background_task',
      'wait',
      'ask_user',
      'web_search',
      'web_image_search',
      'web_fetch'
    ]) {
      expect(conversation).toContain(name)
      expect(collaboration).toContain(name)
    }
    expect(collaboration).not.toEqual(
      expect.arrayContaining([
        'start_background_command',
        'list_background_commands',
        'cancel_background_command'
      ])
    )
  })

  it('selects exactly one model-specific editing dialect', () => {
    const openAi = names({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      editingTarget: { model: 'openai/gpt-5.4-codex', providerKind: 'openrouter' }
    })
    expect(openAi).toContain('apply_patch')
    expect(openAi).not.toEqual(expect.arrayContaining(['Edit', 'Write', 'edit', 'write']))

    const claude = names({
      surface: 'collaboration',
      workspaceRoot: '/workspace',
      editingTarget: { model: 'claude-sonnet-5', providerKind: 'anthropic' }
    })
    expect(claude).toEqual(expect.arrayContaining(['Edit', 'Write', 'delete_file']))
    expect(claude).not.toContain('apply_patch')
  })

  it('uses capabilities as the only tool availability filter', () => {
    const catalog = getAgentToolCatalog({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      capabilities: ['workspace.read', 'wait']
    })
    expect(catalog.map(({ definition }) => definition.function.name)).toEqual([
      'wait',
      'ask_user',
      'list_workspace_files',
      'read_workspace_file',
      'search_workspace_files'
    ])
    expect(catalog.every(({ host }) => host === 'main')).toBe(true)
  })

  it('exposes skill-owned tools only after activation', () => {
    expect(names({ surface: 'conversation' })).not.toContain('create_artifact')
    expect(names({ surface: 'conversation', activeSkillIds: ['web-artifacts'] })).toContain(
      'create_artifact'
    )
  })

  it('exposes goal completion control only inside a durable goal run', () => {
    expect(names({ surface: 'conversation' })).not.toContain('update_goal')
    expect(names({ surface: 'conversation', goalEnabled: true })).toContain('update_goal')
    expect(names({ surface: 'research', goalEnabled: true })).toContain('update_goal')
  })

  it('changes the plan contract tools and capabilities at enforced mode boundaries', () => {
    const inactive = names({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      planStage: 'inactive'
    })
    expect(inactive).toContain('enter_plan_mode')
    expect(inactive).not.toEqual(expect.arrayContaining(['present_plan', 'complete_plan']))

    const planning = names({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      planStage: 'planning',
      codeIntelligenceAvailable: true,
      mcpTools: [
        {
          type: 'function',
          function: { name: 'mcp_write', description: 'Write remotely', parameters: {} }
        }
      ]
    })
    expect(planning).toEqual(
      expect.arrayContaining([
        'present_plan',
        'read_workspace_file',
        'search_workspace_files',
        'code_intelligence'
      ])
    )
    expect(planning).not.toEqual(
      expect.arrayContaining([
        'enter_plan_mode',
        'complete_plan',
        'edit',
        'write',
        'apply_patch',
        'execute_command',
        'mcp_write',
        'create_artifact',
        'spawn_subagent'
      ])
    )
    expect(
      agentRunProfile({
        surface: 'conversation',
        workspaceRoot: '/workspace',
        planStage: 'planning'
      })
    ).toMatchObject({ executionMode: 'plan' })

    const executing = names({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      planStage: 'executing'
    })
    expect(executing).toEqual(expect.arrayContaining(['complete_plan', 'edit']))
    expect(executing).not.toEqual(expect.arrayContaining(['enter_plan_mode', 'present_plan']))
  })

  it('exposes language intelligence conditionally and consistently across coding surfaces', () => {
    for (const surface of ['conversation', 'collaboration', 'subagent'] as const) {
      expect(
        names({ surface, workspaceRoot: '/workspace', codeIntelligenceAvailable: false })
      ).not.toContain('code_intelligence')
      expect(
        names({ surface, workspaceRoot: '/workspace', codeIntelligenceAvailable: true })
      ).toContain('code_intelligence')
    }
    expect(
      names({
        surface: 'conversation',
        workspaceRoot: '/workspace',
        codeIntelligenceAvailable: true,
        capabilities: ['workspace.read']
      })
    ).not.toContain('code_intelligence')
    expect(
      getAgentToolCatalog({
        surface: 'conversation',
        workspaceRoot: '/workspace',
        codeIntelligenceAvailable: true,
        codeIntelligenceRisk: 'execute'
      }).find(({ definition }) => definition.function.name === 'code_intelligence')?.risk
    ).toBe('execute')
  })
})
