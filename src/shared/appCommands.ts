export const APP_COMMANDS = ['open-settings', 'new-chat', 'open-project'] as const

export type AppCommand = (typeof APP_COMMANDS)[number]

export function isAppCommand(value: unknown): value is AppCommand {
  return typeof value === 'string' && APP_COMMANDS.includes(value as AppCommand)
}
