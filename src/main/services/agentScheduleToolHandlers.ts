import {
  toolExecutionFailed,
  toolExecutionSucceeded,
  type AgentApprovalPreview,
  type ToolExecutionResult
} from '../../shared/agentRuntime'
import {
  isPermissionMode,
  PERMISSION_MODE_LABELS,
  permissionModeWithin,
  type PermissionMode
} from '../../shared/permissions'
import {
  SCHEDULE_CHANGE_TOOLS,
  SCHEDULE_WEEKDAY_ARGUMENTS,
  SCHEDULES_CREATE_TOOL,
  SCHEDULES_LIST_TOOL,
  SCHEDULES_UPDATE_TOOL
} from '../../shared/scheduleTools'
import {
  AGENT_ACTIVE_SCHEDULE_LIMIT,
  describeScheduleTiming,
  nextScheduleOccurrence,
  scheduleWeekdayName,
  validateScheduleInput,
  type Schedule,
  type ScheduleInput,
  type ScheduleRun
} from '../../shared/schedules'
import type {
  AgentToolHandlerInput,
  AgentToolHandlerRegistry,
  AgentToolPreviewContext
} from './agentToolHandlerRegistry'
import type { ScheduleService } from './scheduleService'

/** The chat a schedule tool is called from. */
export interface ScheduleToolChat {
  projectId: string | null
  /** The model the chat runs with, which a new schedule uses unless told otherwise. */
  modelId: string | null
  /** A schedule created the chat, or the chat that started it. */
  startedBySchedule: boolean
}

/** What the schedule tools may use: the canonical scheduler and read-only facts about the app. */
export interface ScheduleToolAccess {
  schedules: Pick<
    ScheduleService,
    | 'list'
    | 'get'
    | 'runs'
    | 'create'
    | 'update'
    | 'pause'
    | 'resume'
    | 'delete'
    | 'activeAgentCreatedCount'
  >
  /** Enabled models a schedule may run with. */
  models: () => Array<{ id: string; name: string }>
  projects: () => Array<{ id: string; name: string }>
  chat: (conversationId: string) => ScheduleToolChat | undefined
  /** The user's permission setting. */
  settingMode: () => PermissionMode
  now?: () => number
}

type ScheduleDecision =
  | { refused: string }
  | { kind: 'create'; input: ScheduleInput }
  | { kind: 'update'; schedule: Schedule; input: ScheduleInput; enabled?: boolean }
  | { kind: 'delete'; schedule: Schedule }

/** A list result shows this much of each prompt; the rest stays as it is unless replaced. */
const LISTED_PROMPT_LENGTH = 2_000

const CHAT_MODE_LABELS = { new: 'Start a new chat', continue: 'Continue the last chat' } as const

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message)
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function excerpt(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

function parseTime(value: unknown): { hour: number; minute: number } {
  const match = typeof value === 'string' ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value) : null
  const hour = match ? Number(match[1]) : NaN
  const minute = match ? Number(match[2]) : NaN
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    refuse('time must be a 24-hour local time, HH:MM, such as 09:00.')
  }
  return { hour, minute }
}

function parseWeekday(value: unknown): number {
  const index = SCHEDULE_WEEKDAY_ARGUMENTS.indexOf(
    String(value).toLowerCase() as (typeof SCHEDULE_WEEKDAY_ARGUMENTS)[number]
  )
  if (index < 0) refuse(`weekday must be one of ${SCHEDULE_WEEKDAY_ARGUMENTS.join(', ')}.`)
  return index
}

/** The comparison key that proves an approved change is still the one the user saw. */
function decisionKey(decision: ScheduleDecision): string {
  if ('refused' in decision) return 'refused'
  if (decision.kind === 'create') return JSON.stringify(['create', decision.input])
  if (decision.kind === 'delete') return JSON.stringify(['delete', decision.schedule.id])
  return JSON.stringify(['update', decision.schedule.id, decision.input, decision.enabled])
}

function scheduleFields(schedule: ScheduleInput): ScheduleInput {
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    projectId: schedule.projectId,
    modelId: schedule.modelId,
    cadence: schedule.cadence,
    hour: schedule.hour,
    minute: schedule.minute,
    weekday: schedule.weekday,
    catchUp: schedule.catchUp,
    chatMode: schedule.chatMode ?? 'new',
    permissionCeiling: schedule.permissionCeiling ?? null
  }
}

/**
 * Registers the tools that let SideKick's agent see and manage the user's schedules. Every
 * create, change and delete is decided once, when the runtime asks how much the call needs: an
 * invalid one is refused without asking, and a valid one asks the user every time, showing
 * exactly what the decision will save. The handler saves only a decision it recorded as valid,
 * and only while it is still the same, so nothing is saved unseen.
 */
export function registerScheduleToolHandlers(
  handlers: AgentToolHandlerRegistry,
  access: ScheduleToolAccess,
  options: { permissionMode?: PermissionMode }
): {
  /** Decides a change once and records it for its approval card and its handler. */
  requestedAccess: (
    name: string,
    args: Record<string, unknown>,
    context: AgentToolPreviewContext
  ) => 'always' | 'auto' | undefined
} {
  const now = access.now ?? Date.now
  const decisions = new Map<string, ScheduleDecision>()
  const chatMode = (): PermissionMode => options.permissionMode ?? access.settingMode()
  const projectName = (projectId: string | null): string =>
    projectId
      ? (access.projects().find(({ id }) => id === projectId)?.name ?? 'A removed project')
      : 'Standalone chat'
  const modelName = (modelId: string): string =>
    access.models().find(({ id }) => id === modelId)?.name ?? `${modelId} (not enabled)`
  const ceilingLabel = (ceiling: PermissionMode | null | undefined): string =>
    ceiling ? PERMISSION_MODE_LABELS[ceiling] : 'Follow my permission setting'

  function requireProject(value: unknown): string | null {
    if (value === 'none') return null
    const id = String(value)
    if (!access.projects().some((project) => project.id === id)) {
      refuse(`No project has id ${id}. Call schedules_list for project ids, or use "none".`)
    }
    return id
  }

  function requireModel(value: unknown): string {
    const id = String(value)
    if (!access.models().some((model) => model.id === id)) {
      refuse(`${id} is not an enabled model. Call schedules_list for the enabled models.`)
    }
    return id
  }

  /** A ceiling the agent may save: never more than the chat asking for it may do. */
  function requireCeiling(ceiling: unknown): PermissionMode {
    if (!isPermissionMode(ceiling)) {
      refuse('permission_ceiling must be always-ask, sensitive-only, or full-access.')
    }
    const mode = chatMode()
    if (!permissionModeWithin(ceiling, mode)) {
      refuse(
        `A schedule cannot do more without asking than this chat may: ${PERMISSION_MODE_LABELS[mode]}. Use permission_ceiling "${mode}" or stricter.`
      )
    }
    return ceiling
  }

  function timing(
    args: Record<string, unknown>,
    current?: Schedule
  ): Pick<ScheduleInput, 'cadence' | 'hour' | 'minute' | 'weekday'> {
    const cadence = (args.cadence ?? current?.cadence) as ScheduleInput['cadence']
    const time = args.time !== undefined ? parseTime(args.time) : current
    if (!time) refuse('Give the time the schedule runs, as HH:MM.')
    const weekday =
      args.weekday !== undefined ? parseWeekday(args.weekday) : (current?.weekday ?? null)
    if (cadence === 'weekly' && weekday === null) refuse('A weekly schedule needs a weekday.')
    return { cadence, hour: time.hour, minute: time.minute, weekday: weekday ?? 1 }
  }

  function validated(raw: Record<string, unknown>): ScheduleInput {
    try {
      return scheduleFields(validateScheduleInput(raw))
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    }
  }

  function decideCreate(args: Record<string, unknown>, chat: ScheduleToolChat): ScheduleDecision {
    if (chat.startedBySchedule) {
      refuse(
        'A schedule started this chat, and a scheduled run cannot create schedules. The user can create one in Schedules, or ask for it in a chat they started.'
      )
    }
    if (access.schedules.activeAgentCreatedCount() >= AGENT_ACTIVE_SCHEDULE_LIMIT) {
      refuse(
        `The agent already has ${AGENT_ACTIVE_SCHEDULE_LIMIT} active schedules, the most it may have. Ask the user to pause or delete one in Schedules, or to create this one there themselves.`
      )
    }
    const modelId = args.model_id !== undefined ? requireModel(args.model_id) : chat.modelId
    if (!modelId) refuse('This chat has no model to reuse. Give model_id from schedules_list.')
    const input = validated({
      name: args.name,
      prompt: args.prompt,
      projectId: args.project_id !== undefined ? requireProject(args.project_id) : chat.projectId,
      modelId: requireModel(modelId),
      ...timing(args),
      catchUp: args.catch_up !== false,
      chatMode: args.each_run ?? 'new',
      permissionCeiling: requireCeiling(args.permission_ceiling ?? chatMode())
    })
    return { kind: 'create', input }
  }

  function requireSchedule(args: Record<string, unknown>): Schedule {
    const schedule = typeof args.id === 'string' ? access.schedules.get(args.id) : undefined
    if (!schedule) refuse('No schedule has that id. Call schedules_list for the schedules.')
    return schedule
  }

  function decideUpdate(args: Record<string, unknown>, chat: ScheduleToolChat): ScheduleDecision {
    const schedule = requireSchedule(args)
    const fields = Object.keys(args).filter((key) => key !== 'id' && args[key] !== undefined)
    if (chat.startedBySchedule && !(fields.length === 1 && args.enabled === false)) {
      refuse(
        'A schedule started this chat, so it may only pause or delete schedules, not change or resume them.'
      )
    }
    const input = validated({
      name: args.name ?? schedule.name,
      prompt: args.prompt ?? schedule.prompt,
      projectId:
        args.project_id !== undefined ? requireProject(args.project_id) : schedule.projectId,
      modelId: args.model_id !== undefined ? requireModel(args.model_id) : schedule.modelId,
      ...timing(args, schedule),
      catchUp: typeof args.catch_up === 'boolean' ? args.catch_up : schedule.catchUp,
      chatMode: args.each_run ?? schedule.chatMode ?? 'new',
      permissionCeiling: args.permission_ceiling ?? schedule.permissionCeiling ?? null
    })
    const changesFields = JSON.stringify(input) !== JSON.stringify(scheduleFields(schedule))
    const enabled =
      typeof args.enabled === 'boolean' && args.enabled !== schedule.enabled
        ? args.enabled
        : undefined
    if (!changesFields && enabled === undefined) refuse('Nothing would change.')
    // Pausing only takes permissions away; anything else the agent saves or turns back on must
    // run with an enabled model in an existing project, and may not do more than this chat may.
    if (changesFields || enabled === true) {
      requireModel(input.modelId)
      if (input.projectId) requireProject(input.projectId)
      requireCeiling(input.permissionCeiling ?? access.settingMode())
    }
    if (
      enabled === true &&
      schedule.createdBy &&
      access.schedules.activeAgentCreatedCount() >= AGENT_ACTIVE_SCHEDULE_LIMIT
    ) {
      refuse(
        `The agent already has ${AGENT_ACTIVE_SCHEDULE_LIMIT} active schedules, the most it may have. Ask the user to pause or delete one first.`
      )
    }
    return { kind: 'update', schedule, input, ...(enabled !== undefined ? { enabled } : {}) }
  }

  function decide(
    name: string,
    args: Record<string, unknown>,
    conversationId: string | undefined
  ): ScheduleDecision {
    try {
      const chat = conversationId ? access.chat(conversationId) : undefined
      if (!chat) refuse('Schedules can be managed only from a chat.')
      if (name === SCHEDULES_CREATE_TOOL) return decideCreate(args, chat)
      if (name === SCHEDULES_UPDATE_TOOL) return decideUpdate(args, chat)
      return { kind: 'delete', schedule: requireSchedule(args) }
    } catch (error) {
      if (error instanceof Refusal) return { refused: error.message }
      throw error
    }
  }

  function scheduleFacts(input: ScheduleInput, enabled: boolean): AgentApprovalPreview['facts'] {
    return [
      { label: 'Name', value: input.name },
      { label: 'Project', value: projectName(input.projectId) },
      { label: 'Model', value: modelName(input.modelId) },
      { label: 'Repeat', value: `${describeScheduleTiming(input)}, in this computer’s time` },
      {
        label: 'Next run',
        value: enabled ? formatTime(nextScheduleOccurrence(input, now())) : 'None while paused'
      },
      { label: 'Each run', value: CHAT_MODE_LABELS[input.chatMode ?? 'new'] },
      { label: 'Without asking, runs may', value: ceilingLabel(input.permissionCeiling) },
      {
        label: 'Missed times',
        value: input.catchUp ? 'Run once when SideKick starts or wakes' : 'Skipped'
      }
    ]
  }

  function preview(decision: ScheduleDecision): AgentApprovalPreview | undefined {
    if ('refused' in decision) return undefined
    if (decision.kind === 'create') {
      return {
        summary:
          'The agent asks to save this schedule. It starts runs on its own at these times until you pause or delete it in Schedules.',
        changes: [],
        facts: scheduleFacts(decision.input, true),
        quote: {
          label: 'Prompt each run sends, as the agent wrote it',
          text: decision.input.prompt
        }
      }
    }
    if (decision.kind === 'delete') {
      const { schedule } = decision
      return {
        summary: 'The agent asks to delete this schedule. It stops running; its chats are kept.',
        changes: [],
        facts: [
          { label: 'Name', value: schedule.name },
          { label: 'Repeat', value: describeScheduleTiming(schedule) },
          { label: 'Project', value: projectName(schedule.projectId) },
          {
            label: 'Made by',
            value: schedule.createdBy ? 'The agent, in a chat' : 'You, in Schedules'
          }
        ]
      }
    }
    const { schedule, input, enabled } = decision
    const before = scheduleFields(schedule)
    const changes: AgentApprovalPreview['changes'] = []
    const compare = (label: string, from: string, to: string): void => {
      if (from !== to) changes.push({ label, before: from, after: to })
    }
    if (enabled !== undefined) {
      compare('State', schedule.enabled ? 'Active' : 'Paused', enabled ? 'Active' : 'Paused')
    }
    compare('Name', before.name, input.name)
    if (before.prompt !== input.prompt) {
      changes.push({ label: 'Prompt', before: excerpt(before.prompt, 80), after: 'below' })
    }
    compare('Project', projectName(before.projectId), projectName(input.projectId))
    compare('Model', modelName(before.modelId), modelName(input.modelId))
    compare('Repeat', describeScheduleTiming(before), describeScheduleTiming(input))
    compare(
      'Each run',
      CHAT_MODE_LABELS[before.chatMode ?? 'new'],
      CHAT_MODE_LABELS[input.chatMode ?? 'new']
    )
    compare(
      'Without asking, runs may',
      ceilingLabel(before.permissionCeiling),
      ceilingLabel(input.permissionCeiling)
    )
    compare(
      'Missed times',
      before.catchUp ? 'Run once' : 'Skipped',
      input.catchUp ? 'Run once' : 'Skipped'
    )
    return {
      summary:
        enabled === false && changes.length === 1
          ? 'The agent asks to pause this schedule. It stops starting runs until it is resumed.'
          : 'The agent asks to change this schedule. This is how it will be saved.',
      changes,
      facts: scheduleFacts(input, enabled ?? schedule.enabled),
      ...(before.prompt !== input.prompt
        ? {
            quote: { label: 'New prompt each run sends, as the agent wrote it', text: input.prompt }
          }
        : {})
    }
  }

  function described(schedule: Schedule): Record<string, unknown> {
    const runs = access.schedules.runs(schedule.id).slice(0, 3)
    return {
      id: schedule.id,
      name: schedule.name,
      state: schedule.activeRun
        ? schedule.activeRun.phase.startsWith('awaiting')
          ? 'running, waiting for the user'
          : 'running'
        : schedule.enabled
          ? 'active'
          : 'paused',
      ...(schedule.pausedReason ? { pausedReason: schedule.pausedReason } : {}),
      repeat: describeScheduleTiming(schedule),
      cadence: schedule.cadence,
      time: `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`,
      ...(schedule.cadence === 'weekly'
        ? { weekday: scheduleWeekdayName(schedule.weekday).toLowerCase() }
        : {}),
      nextRun: schedule.nextRunAt ? formatTime(schedule.nextRunAt) : null,
      lastRun: schedule.lastRunAt ? formatTime(schedule.lastRunAt) : null,
      project: schedule.projectId
        ? { id: schedule.projectId, name: projectName(schedule.projectId) }
        : null,
      model: { id: schedule.modelId, name: modelName(schedule.modelId) },
      eachRun: schedule.chatMode ?? 'new',
      permissionCeiling: schedule.permissionCeiling ?? 'follows the permission setting',
      catchUp: schedule.catchUp,
      madeBy: schedule.createdBy ? 'the agent' : 'the user',
      prompt:
        schedule.prompt.length > LISTED_PROMPT_LENGTH
          ? `${schedule.prompt.slice(0, LISTED_PROMPT_LENGTH)}… (${schedule.prompt.length} characters; kept unless replaced)`
          : schedule.prompt,
      recentRuns: runs.map((run: ScheduleRun) => ({
        at: formatTime(run.startedAt ?? run.scheduledFor),
        outcome: run.outcome,
        ...(run.agentPhase ? { chat: run.agentPhase } : {}),
        ...(run.reason ? { reason: run.reason } : {})
      }))
    }
  }

  handlers.register(SCHEDULES_LIST_TOOL, async ({ title, context }) => {
    const chat = context.conversationId ? access.chat(context.conversationId) : undefined
    const data = {
      thisChat: {
        projectId: chat?.projectId ?? null,
        modelId: chat?.modelId ?? null,
        permissionMode: chatMode(),
        startedBySchedule: chat?.startedBySchedule ?? false
      },
      agentSchedules: {
        active: access.schedules.activeAgentCreatedCount(),
        limit: AGENT_ACTIVE_SCHEDULE_LIMIT
      },
      projects: access.projects(),
      models: access.models(),
      schedules: access.schedules.list().map(described)
    }
    return toolExecutionSucceeded({ title, data, modelContent: JSON.stringify(data, null, 2) })
  })

  const apply = (
    decision: Exclude<ScheduleDecision, { refused: string }>,
    conversationId: string
  ): string => {
    if (decision.kind === 'create') {
      const saved = access.schedules.create(decision.input, { conversationId })
      return `Saved “${saved.name}”: ${describeScheduleTiming(saved)}, next run ${saved.nextRunAt ? formatTime(saved.nextRunAt) : 'none'}. It is listed in Schedules as made in this chat, where the user can pause or delete it. Its id is ${saved.id}.`
    }
    if (decision.kind === 'delete') {
      access.schedules.delete(decision.schedule.id)
      return `Deleted “${decision.schedule.name}”. The chats it created are kept.`
    }
    const { schedule, input, enabled } = decision
    let saved =
      JSON.stringify(input) !== JSON.stringify(scheduleFields(schedule))
        ? access.schedules.update(schedule.id, input)
        : schedule
    if (enabled === false) saved = access.schedules.pause(schedule.id)
    if (enabled === true) saved = access.schedules.resume(schedule.id)
    return `Saved “${saved.name}”: ${saved.enabled ? `${describeScheduleTiming(saved)}, next run ${saved.nextRunAt ? formatTime(saved.nextRunAt) : 'none'}` : 'paused'}.`
  }

  const change = async ({
    name,
    title,
    arguments: args,
    context
  }: AgentToolHandlerInput): Promise<ToolExecutionResult> => {
    const recorded = context.toolCallId ? decisions.get(context.toolCallId) : undefined
    if (context.toolCallId) decisions.delete(context.toolCallId)
    if (!recorded || !context.conversationId) {
      return toolExecutionFailed({
        title,
        code: 'permission_denied',
        message: 'Nothing was saved: SideKick could not ask the user to approve this change.',
        status: 'denied'
      })
    }
    if ('refused' in recorded) {
      return toolExecutionFailed({
        title,
        code: 'invalid_arguments',
        message: `Nothing was saved: ${recorded.refused}`,
        recoveryAction: 'change_strategy'
      })
    }
    // The user approved what they saw; save it only if it is still exactly that.
    const current = decide(name, args, context.conversationId)
    if (decisionKey(current) !== decisionKey(recorded)) {
      return toolExecutionFailed({
        title,
        code: 'conflict',
        message: `Nothing was saved: ${'refused' in current ? current.refused : 'the schedule changed while the user was deciding. Call schedules_list and try again.'}`,
        recoveryAction: 'change_strategy'
      })
    }
    try {
      const message = apply(recorded, context.conversationId)
      return toolExecutionSucceeded({ title, data: { saved: true }, modelContent: message })
    } catch (error) {
      return toolExecutionFailed({
        title,
        code: 'invalid_arguments',
        message: `Nothing was saved: ${error instanceof Error ? error.message : String(error)}`,
        recoveryAction: 'change_strategy'
      })
    }
  }

  handlers.register(SCHEDULE_CHANGE_TOOLS, change, {
    preview: async (_args, context) => {
      const decision = context?.toolCallId ? decisions.get(context.toolCallId) : undefined
      return decision ? preview(decision) : undefined
    }
  })

  return {
    requestedAccess: (name, args, context) => {
      if (!SCHEDULE_CHANGE_TOOLS.includes(name)) return undefined
      const decision = decide(name, args, context.conversationId)
      if (context.toolCallId) decisions.set(context.toolCallId, decision)
      return 'refused' in decision ? 'auto' : 'always'
    }
  }
}
