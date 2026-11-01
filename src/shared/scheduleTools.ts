/**
 * Tools that let SideKick's agent see and manage the user's schedules. They arrive only with the
 * `schedules` skill, so ordinary runs carry none of their schemas. Listing is free; creating,
 * changing and deleting ask the user every time, whatever the permission mode.
 */
import type { AgentToolDefinition, AgentToolParameterProperty } from './agentToolDefinitions'
import { SCHEDULE_CADENCES, SCHEDULE_CHAT_MODES } from './schedules'

export const SCHEDULES_SKILL_ID = 'schedules'

export const SCHEDULES_LIST_TOOL = 'schedules_list'
export const SCHEDULES_CREATE_TOOL = 'schedules_create'
export const SCHEDULES_UPDATE_TOOL = 'schedules_update'
export const SCHEDULES_DELETE_TOOL = 'schedules_delete'

/** The schedule tools that save something, each only after the user approves it. */
export const SCHEDULE_CHANGE_TOOLS: readonly string[] = [
  SCHEDULES_CREATE_TOOL,
  SCHEDULES_UPDATE_TOOL,
  SCHEDULES_DELETE_TOOL
]

/** What a schedule tool call is called on its row and its approval card, or null for others. */
export function scheduleToolTitle(
  name: string,
  args: Readonly<Record<string, unknown>>
): string | null {
  if (name === SCHEDULES_LIST_TOOL) return 'List schedules'
  if (name === SCHEDULES_DELETE_TOOL) return 'Delete schedule'
  if (name !== SCHEDULES_CREATE_TOOL && name !== SCHEDULES_UPDATE_TOOL) return null
  const verb =
    name === SCHEDULES_CREATE_TOOL
      ? 'Create schedule'
      : args.enabled === false
        ? 'Pause schedule'
        : args.enabled === true
          ? 'Resume schedule'
          : 'Change schedule'
  const scheduleName = typeof args.name === 'string' ? args.name.trim().slice(0, 120) : ''
  return scheduleName ? `${verb} “${scheduleName}”` : verb
}

export const SCHEDULE_WEEKDAY_ARGUMENTS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
] as const

const scheduleFields: Record<string, AgentToolParameterProperty> = {
  name: {
    type: 'string',
    description: 'Short name the user will recognise; it also names the chats the runs create.'
  },
  prompt: {
    type: 'string',
    description:
      'The message each run starts with, written to stand alone: the run cannot see this chat.'
  },
  project_id: {
    type: 'string',
    description:
      'Project id from schedules_list, or "none" for a standalone chat. Omitted, this chat’s project.'
  },
  model_id: {
    type: 'string',
    description: 'Enabled model id from schedules_list. Omitted, this chat’s model.'
  },
  cadence: { type: 'string', enum: [...SCHEDULE_CADENCES] },
  time: {
    type: 'string',
    description:
      '24-hour local time, HH:MM, such as 09:00. An hourly schedule uses only the minutes.'
  },
  weekday: {
    type: 'string',
    enum: [...SCHEDULE_WEEKDAY_ARGUMENTS],
    description: 'The day a weekly schedule runs.'
  },
  each_run: {
    type: 'string',
    enum: [...SCHEDULE_CHAT_MODES],
    description:
      '"new" starts a fresh chat every run; "continue" adds each run to the last run’s chat.'
  },
  permission_ceiling: {
    type: 'string',
    enum: ['always-ask', 'sensitive-only', 'full-access'],
    description:
      'The most a run may do without asking. Never looser than this chat’s permission mode; omitted, that mode.'
  },
  catch_up: {
    type: 'boolean',
    description: 'Run once when SideKick starts or wakes after a time it missed. Defaults to true.'
  }
}

export const schedulesListTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: SCHEDULES_LIST_TOOL,
    description:
      "List the user's schedules with their state, next run and recent runs, and the projects, enabled models and permission mode a new schedule can use.",
    parameters: { type: 'object', properties: {} }
  }
}

export const schedulesCreateTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: SCHEDULES_CREATE_TOOL,
    description:
      'Create a schedule that sends a prompt to a new agent run at the times given. The user sees exactly what will be saved and must approve it; nothing is saved otherwise.',
    parameters: {
      type: 'object',
      required: ['name', 'prompt', 'cadence', 'time'],
      properties: scheduleFields
    }
  }
}

export const schedulesUpdateTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: SCHEDULES_UPDATE_TOOL,
    description:
      'Change a schedule, or pause or resume it with enabled. Omitted fields keep their values. The user sees what changes and must approve it.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Schedule id from schedules_list.' },
        ...scheduleFields,
        enabled: { type: 'boolean', description: 'false pauses the schedule; true resumes it.' }
      }
    }
  }
}

export const schedulesDeleteTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: SCHEDULES_DELETE_TOOL,
    description:
      'Delete a schedule. The chats it created are kept. The user must approve it; to stop it for a while, pause it with schedules_update instead.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Schedule id from schedules_list.' } }
    }
  }
}
