import type { CompanionChat, CompanionProject } from '../../../shared/companion'

/** A project and its chats, as the desktop's sidebar groups them. */
export interface ProjectGroup {
  /** Null for a project the computer did not list, known only by a chat's name for it. */
  project: CompanionProject | null
  name: string
  chats: CompanionChat[]
}

export interface ChatGroups {
  projects: ProjectGroup[]
  /** Chats outside any project. */
  chats: CompanionChat[]
}

/**
 * Chats under their projects, then the rest. Projects come in the computer's order, those without
 * chats too, so a chat can be started in any of them; the computer sends pinned chats first and
 * then the most recent, and the chats inside each project keep that order.
 */
export function groupChats(
  chats: readonly CompanionChat[],
  projects: readonly CompanionProject[] = []
): ChatGroups {
  const groups = new Map<string, ProjectGroup>()
  for (const project of projects)
    groups.set(`id:${project.id}`, { project, name: project.name, chats: [] })
  const standalone: CompanionChat[] = []
  for (const chat of chats) {
    if (!chat.projectId && !chat.projectName) {
      standalone.push(chat)
      continue
    }
    const key =
      chat.projectId && groups.has(`id:${chat.projectId}`)
        ? `id:${chat.projectId}`
        : `name:${chat.projectName}`
    const group = groups.get(key)
    if (group) group.chats.push(chat)
    else groups.set(key, { project: null, name: chat.projectName ?? 'Project', chats: [chat] })
  }
  return { projects: [...groups.values()], chats: standalone }
}

/**
 * The chats whose title or project contains every word of the query, ignoring case; the phone
 * searches only what it already has, as titles are all the list holds.
 */
export function searchChats(chats: readonly CompanionChat[], query: string): CompanionChat[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...chats]
  return chats.filter((chat) => {
    const text = `${chat.title} ${chat.projectName ?? ''}`.toLocaleLowerCase()
    return words.every((word) => text.includes(word))
  })
}
