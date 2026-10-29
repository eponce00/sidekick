import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  FolderGit2,
  FolderPlus,
  Globe,
  Mic,
  Moon,
  PanelLeft,
  RefreshCw,
  Settings,
  SquarePen,
  Sun
} from 'lucide-react'
import {
  CONVERSATION_JUMP_COUNT,
  shortcutLabel,
  type ShortcutId
} from '../../../shared/keyboardShortcuts'
import type { DesktopPlatform } from '../../../shared/platform'
import type { Conversation, Project } from '../types/app.types'
import type { CommandPaletteItem } from './commandPalette'

export interface CommandPaletteActions {
  newChat: () => void
  openSchedules: () => void
  openProject: () => void
  openSettings: () => void
  toggleSidebar: () => void
  toggleBrowserPanel: () => void
  toggleVoice: () => void
  toggleTheme: () => void
  checkForUpdates: () => void
  previousConversation: () => void
  nextConversation: () => void
  openConversation: (conversationId: string) => void
  openProjectConversations: (projectId: string) => void
  manageWorktrees: () => void
  /** Edits the current chat's project; absent when the chat has none. */
  editProject?: () => void
}

export interface CommandPaletteContext {
  platform: DesktopPlatform
  conversations: readonly Conversation[]
  projects: readonly Project[]
  /** Sidebar order, so the first nine chats show the key that opens them. */
  sidebarOrder: readonly string[]
  currentConversationId: string | null
  sidebarCollapsed: boolean
  browserPanelOpen: boolean
  /** Null when voice is off in Settings or unavailable on this machine. */
  voiceOn: boolean | null
  theme: 'dark' | 'light'
  actions: CommandPaletteActions
}

export function buildCommandPaletteItems(context: CommandPaletteContext): CommandPaletteItem[] {
  const { actions, platform } = context
  const label = (id: ShortcutId): string => shortcutLabel(id, platform)
  const items: CommandPaletteItem[] = [
    {
      id: 'action:new-chat',
      group: 'actions',
      title: 'New chat',
      icon: SquarePen,
      keywords: 'conversation start create',
      shortcut: label('new-chat'),
      run: actions.newChat
    },
    {
      id: 'action:open-schedules',
      group: 'actions',
      title: 'Schedules',
      icon: CalendarClock,
      keywords: 'schedule routine recurring automation cron timer',
      run: actions.openSchedules
    },
    {
      id: 'action:open-project',
      group: 'actions',
      title: 'Open project…',
      icon: FolderPlus,
      keywords: 'folder workspace',
      shortcut: label('open-project'),
      run: actions.openProject
    },
    ...(actions.editProject
      ? [
          {
            id: 'action:edit-project',
            group: 'actions' as const,
            title: 'Edit project…',
            icon: FolderPlus,
            keywords: 'folders add folder primary rename repository',
            run: actions.editProject
          }
        ]
      : []),
    {
      id: 'action:manage-worktrees',
      group: 'actions',
      title: 'Manage worktrees',
      icon: FolderGit2,
      keywords: 'git branch isolate parallel agents remove sync',
      run: actions.manageWorktrees
    },
    {
      id: 'action:open-settings',
      group: 'actions',
      title: 'Open settings',
      icon: Settings,
      keywords: 'preferences options providers models',
      shortcut: label('open-settings'),
      run: actions.openSettings
    },
    {
      id: 'action:toggle-sidebar',
      group: 'actions',
      title: context.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar',
      icon: PanelLeft,
      keywords: 'toggle sidebar conversations list',
      run: actions.toggleSidebar
    }
  ]
  items.push({
    id: 'action:toggle-browser-panel',
    group: 'actions',
    title: context.browserPanelOpen ? 'Hide browser panel' : 'Show browser panel',
    icon: Globe,
    keywords: 'toggle browser web activity panel',
    run: actions.toggleBrowserPanel
  })
  if (context.voiceOn !== null) {
    items.push({
      id: 'action:toggle-voice',
      group: 'actions',
      title: context.voiceOn ? 'Stop dictating' : 'Dictate',
      icon: Mic,
      keywords: 'toggle voice microphone dictation talk speak',
      shortcut: label('toggle-voice'),
      run: actions.toggleVoice
    })
  }
  items.push(
    {
      id: 'action:toggle-theme',
      group: 'actions',
      title: context.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      icon: context.theme === 'dark' ? Sun : Moon,
      keywords: 'theme appearance toggle',
      run: actions.toggleTheme
    },
    {
      id: 'action:previous-conversation',
      group: 'actions',
      title: 'Previous conversation',
      icon: ArrowUp,
      keywords: 'go back up',
      shortcut: label('previous-conversation'),
      disabled: context.sidebarOrder.length < 2,
      run: actions.previousConversation
    },
    {
      id: 'action:next-conversation',
      group: 'actions',
      title: 'Next conversation',
      icon: ArrowDown,
      keywords: 'go forward down',
      shortcut: label('next-conversation'),
      disabled: context.sidebarOrder.length < 2,
      run: actions.nextConversation
    },
    {
      id: 'action:check-for-updates',
      group: 'actions',
      title: 'Check for updates',
      icon: RefreshCw,
      keywords: 'update version release',
      run: actions.checkForUpdates
    }
  )

  const projectNames = new Map(context.projects.map((project) => [project.id, project.name]))
  const jumpPosition = new Map(
    context.sidebarOrder
      .slice(0, CONVERSATION_JUMP_COUNT)
      .map((conversationId, index) => [conversationId, index + 1])
  )
  for (const conversation of context.conversations) {
    const position = jumpPosition.get(conversation.id)
    items.push({
      id: `conversation:${conversation.id}`,
      group: 'conversations',
      title: conversation.title,
      detail:
        conversation.id === context.currentConversationId
          ? 'Open now'
          : conversation.project_id
            ? projectNames.get(conversation.project_id)
            : undefined,
      shortcut: position ? label(`jump-to-conversation-${position}` as ShortcutId) : undefined,
      recency: conversation.updated_at,
      run: () => actions.openConversation(conversation.id)
    })
  }
  for (const project of context.projects) {
    items.push({
      id: `project:${project.id}`,
      group: 'projects',
      title: project.name,
      detail: project.folders?.length
        ? `${project.folder_path} and ${project.folders.length} more ${project.folders.length === 1 ? 'folder' : 'folders'}`
        : project.folder_path,
      keywords: ['project folder', ...(project.folders ?? []).map((folder) => folder.name)].join(
        ' '
      ),
      recency: project.last_activity_at ?? project.updated_at,
      run: () => actions.openProjectConversations(project.id)
    })
  }
  return items
}

/** A project opens on its latest chat, or a new one when it has none. */
export function latestProjectConversationId(
  conversations: readonly Conversation[],
  projectId: string
): string | null {
  let latest: Conversation | null = null
  for (const conversation of conversations) {
    if (conversation.project_id !== projectId) continue
    if (!latest || conversation.updated_at > latest.updated_at) latest = conversation
  }
  return latest?.id ?? null
}
