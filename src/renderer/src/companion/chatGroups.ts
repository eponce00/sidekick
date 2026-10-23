import type { CompanionChat } from '../../../shared/companion'

/** A project and its chats, as the desktop's sidebar groups them. */
export interface ProjectGroup {
  name: string
  chats: CompanionChat[]
}

export interface ChatGroups {
  projects: ProjectGroup[]
  /** Chats outside any project. */
  chats: CompanionChat[]
}

/**
 * Chats under their projects, then the rest. The computer sends pinned chats first and then the
 * most recent, so both the projects and the chats inside each keep that order.
 */
export function groupChats(chats: readonly CompanionChat[]): ChatGroups {
  const projects = new Map<string, CompanionChat[]>()
  const standalone: CompanionChat[] = []
  for (const chat of chats) {
    if (!chat.projectName) {
      standalone.push(chat)
      continue
    }
    const group = projects.get(chat.projectName)
    if (group) group.push(chat)
    else projects.set(chat.projectName, [chat])
  }
  return {
    projects: Array.from(projects, ([name, members]) => ({ name, chats: members })),
    chats: standalone
  }
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
