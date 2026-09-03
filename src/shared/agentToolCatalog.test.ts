import { describe, expect, it } from 'vitest'
import { agentRunProfile, getAgentToolCatalog, getAgentToolDefinitions } from './agentToolCatalog'

const names = (options: Parameters<typeof getAgentToolDefinitions>[0]): string[] =>
  getAgentToolDefinitions(options).map(({ function: tool }) => tool.name)

describe('canonical agent tool catalog', () => {
  it('uses the same command/background names for conversations and collaboration', () => {
    const conversation = names({ surface: 'conversation', webSearchEnabled: true })
    const collaboration = names({ surface: 'collaboration', webSearchEnabled: true })

    for (const name of [
      'shell',
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

  it('ignores provider editing dialect metadata and exposes one contract', () => {
    const openAi = names({
      surface: 'conversation',
      workspaceRoot: '/workspace'
    })
    expect(openAi).toContain('apply_patch')
    expect(openAi).toEqual(expect.arrayContaining(['read', 'shell', 'apply_patch', 'tool_output']))

    const claude = names({
      surface: 'collaboration',
      workspaceRoot: '/workspace'
    })
    expect(claude).toEqual(expect.arrayContaining(['read', 'shell', 'apply_patch', 'tool_output']))
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
      'read'
    ])
    expect(catalog.find(({ definition }) => definition.function.name === 'read')).toMatchObject({
      host: 'main',
      concurrency: 'parallel',
      timeoutMs: 30_000
    })
  })

  it('exposes skill-owned tools only after activation', () => {
    expect(names({ surface: 'conversation' })).not.toContain('create_artifact')
    expect(names({ surface: 'conversation', activeSkillIds: ['web-artifacts'] })).toContain(
      'create_artifact'
    )
  })

  it('exposes the complete first-party visual browser only for compatible runs', () => {
    expect(names({ surface: 'conversation', browserEnabled: false })).not.toContain('browser_open')
    const browser = names({
      surface: 'conversation',
      workspaceRoot: '/workspace',
      browserEnabled: true
    })
    expect(browser).toEqual(
      expect.arrayContaining([
        'view_image',
        'browser_open',
        'browser_observe',
        'browser_screenshot',
        'browser_click',
        'browser_type',
        'browser_select',
        'browser_fill_form',
        'browser_press',
        'browser_scroll',
        'browser_hover',
        'browser_wait',
        'browser_navigate',
        'browser_resize',
        'browser_tabs',
        'browser_console',
        'browser_network',
        'browser_evaluate',
        'browser_verify',
        'browser_close'
      ])
    )
    const observation = getAgentToolCatalog({
      surface: 'conversation',
      browserEnabled: true
    }).find(({ definition }) => definition.function.name === 'browser_observe')
    expect(observation).toMatchObject({
      capability: 'browser',
      risk: 'read',
      presentation: { kind: 'browser' }
    })
    const evaluation = getAgentToolCatalog({
      surface: 'conversation',
      browserEnabled: true
    }).find(({ definition }) => definition.function.name === 'browser_evaluate')
    expect(evaluation?.definition.function.description).toContain('read-only')
    expect(evaluation?.definition.function.description).toContain('dedicated browser action tools')
    const formFill = getAgentToolCatalog({
      surface: 'conversation',
      browserEnabled: true
    }).find(({ definition }) => definition.function.name === 'browser_fill_form')
    expect(formFill).toMatchObject({
      capability: 'browser',
      risk: 'execute',
      presentation: { kind: 'browser' },
      definition: {
        function: {
          parameters: {
            required: ['fields'],
            properties: { fields: { minItems: 1, maxItems: 25 } }
          }
        }
      }
    })
    const click = getAgentToolCatalog({
      surface: 'conversation',
      browserEnabled: true
    }).find(({ definition }) => definition.function.name === 'browser_click')
    expect(click?.definition.function.parameters).toMatchObject({
      anyOf: expect.arrayContaining([{ required: ['x', 'y', 'screenshot_id'] }]),
      properties: { screenshot_id: { type: 'string' } }
    })
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
    expect(planning).toEqual(expect.arrayContaining(['present_plan', 'read', 'code_intelligence']))
    expect(planning).not.toEqual(
      expect.arrayContaining([
        'enter_plan_mode',
        'complete_plan',
        'apply_patch',
        'shell',
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
    expect(executing).toEqual(expect.arrayContaining(['complete_plan', 'apply_patch']))
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
