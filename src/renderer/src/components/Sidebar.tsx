import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Command,
  Folder,
  FolderGit2,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitFork,
  History,
  ListFilter,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Smartphone,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import type { Conversation, Project } from '../types/app.types'
import { SearchField } from './SearchField'
import type { MoveConversationInput } from '../../../shared/projects'
import { sidebarConversationOrder } from '../utils/sidebarConversationOrder'
import { LAYOUT_MOTION_MS } from '../utils/activityPanelLayout'
import { conversationRunStatus, type ConversationRunStatus } from '../utils/conversationAttention'
import {
  SIDEBAR_DOT_LABELS,
  dotFilterStatus,
  expandFamilies,
  familyDescendants,
  familyRollUpLabel,
  familyWorkers,
  indexSessionFamilies,
  mostUrgentDot,
  sidebarDot,
  type SidebarDot
} from '../utils/sessionFamilies'
import {
  SIDEBAR_STATUS_FILTER_LABELS,
  SIDEBAR_STATUS_FILTERS,
  SIDEBAR_VIEW_STORAGE_KEY,
  groupConversationsByRecency,
  matchesStatusFilter,
  storedSidebarView,
  type SidebarStatusFilter,
  type SidebarView
} from '../utils/sidebarView'
import { shortcutLabel } from '../../../shared/keyboardShortcuts'
import type { DesktopPlatform } from '../../../shared/platform'
import type { SessionStatus } from '../../../shared/sessions'
import ConfirmDialog from './ConfirmDialog'
import PhoneCompanionPanel from './PhoneCompanionPanel'
import { usePhoneCompanionStatus } from '../hooks/usePhoneCompanionStatus'
import ScheduledRunGroupRow from './ScheduledRunGroupRow'
import { groupScheduledConversations } from '../utils/scheduledRunGroups'
import { Reveal } from './Reveal'
import { WrittenTitle } from './WrittenTitle'
import './AppMenuHost.css'
import './Sidebar.css'

interface MenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode
  label: string
  /** A shortcut or count, right-aligned. */
  hint?: string | number
  /** A radio item's state, shown as a check at the end of the row. */
  checked?: boolean
  danger?: boolean
}

/** One row of the sidebar's menus, drawn as the app's other menus are (`.app-menu`). */
function MenuItem({
  icon,
  label,
  hint,
  checked,
  danger,
  role = 'menuitem',
  ...button
}: MenuItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      role={role}
      className={`app-menu-item${danger ? ' is-danger' : ''}`}
      {...button}
    >
      <span className="app-menu-mark" aria-hidden="true">
        {icon}
      </span>
      <span className="app-menu-label">{label}</span>
      {hint !== undefined && <span className="app-menu-shortcut">{hint}</span>}
      {checked && <Check size={14} className="app-menu-check" aria-hidden="true" />}
    </button>
  )
}

interface SidebarProps {
  conversations: Conversation[]
  projects: Project[]
  currentConversationId: string | null
  isCollapsed: boolean
  /** For the shortcut shown beside each menu item. */
  platform: DesktopPlatform
  busyConversationIds: ReadonlySet<string>
  unreadConversationIds: ReadonlySet<string>
  /** Conversations paused on the user's approval or answer. */
  waitingConversationIds?: ReadonlySet<string>
  onSelectConversation: (id: string) => void
  onToggleCollapsed: () => void
  onNewConversation: (projectId?: string | null) => void
  onOpenProject: () => void
  onOpenCommandPalette: () => void
  onDeleteConversation: (id: string) => void
  onDeleteAllConversations: () => void
  onForkConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onMoveConversation: (input: MoveConversationInput) => void
  onRenameProject: (id: string, name: string) => void
  onToggleConversationPin: (id: string, pinned: boolean) => void
  onToggleProjectPin: (id: string, pinned: boolean) => void
  onRemoveProject: (id: string) => void
  /** Opens the project's Edit project dialog: its name and folders. */
  onEditProject?: (id: string) => void
  /** The conversations as listed, top to bottom, for keyboard navigation. */
  onVisibleConversationOrderChange?: (conversationIds: string[]) => void
  /** Schedule names by id, for the rows that group each schedule's runs. */
  scheduleNames?: ReadonlyMap<string, string>
  onOpenSchedules?: () => void
  /** Each chat's state from the main process; chats missing from it are idle. */
  sessionStatuses?: ReadonlyMap<string, SessionStatus>
}

const NO_CONVERSATIONS: ReadonlySet<string> = new Set()
const NO_SESSION_STATUSES: ReadonlyMap<string, SessionStatus> = new Map()

const COLLAPSED_FAMILIES_STORAGE_KEY = 'collapsedSessionFamilies'

interface ConversationRowOptions {
  nested?: boolean
  showProject?: boolean
  /** Replaces the title, as "Run 3" does inside a schedule's group. */
  title?: string
  /** A worker row under its manager. */
  worker?: boolean
  /** A manager shown only because a filter matched one of its workers. */
  context?: boolean
}

const EMPTY_FILTER_MESSAGES: Record<ConversationRunStatus, string> = {
  waiting: 'Nothing needs your attention',
  working: 'No agents are working',
  unread: 'No unread replies'
}

type SidebarSection = 'projects' | 'chats'

function Sidebar({
  conversations,
  projects,
  currentConversationId,
  isCollapsed: collapseRequested,
  platform,
  busyConversationIds,
  unreadConversationIds,
  waitingConversationIds = NO_CONVERSATIONS,
  onSelectConversation,
  onToggleCollapsed,
  onNewConversation,
  onOpenProject,
  onOpenCommandPalette,
  onDeleteConversation,
  onDeleteAllConversations,
  onForkConversation,
  onRenameConversation,
  onMoveConversation,
  onRenameProject,
  onToggleConversationPin,
  onToggleProjectPin,
  onRemoveProject,
  onEditProject,
  onVisibleConversationOrderChange,
  scheduleNames,
  onOpenSchedules,
  sessionStatuses = NO_SESSION_STATUSES
}: SidebarProps): React.JSX.Element {
  // Folding slides the full sidebar closed and only then shows the rail, so nothing re-lays out
  // while it moves. Opening shows the full sidebar at once and reveals it as it widens.
  const [railShown, setRailShown] = useState(collapseRequested)
  const [lastCollapseRequest, setLastCollapseRequest] = useState(collapseRequested)
  if (lastCollapseRequest !== collapseRequested) {
    setLastCollapseRequest(collapseRequested)
    if (!collapseRequested) setRailShown(false)
  }
  useEffect(() => {
    if (!collapseRequested || railShown) return
    const timer = window.setTimeout(() => setRailShown(true), LAYOUT_MOTION_MS)
    return () => window.clearTimeout(timer)
  }, [collapseRequested, railShown])
  const isCollapsed = collapseRequested && railShown
  const isClosing = collapseRequested && !railShown
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [removeProjectConfirm, setRemoveProjectConfirm] = useState<string | null>(null)
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isPhoneOpen, setIsPhoneOpen] = useState(false)
  const phoneButtonRef = useRef<HTMLButtonElement>(null)
  const closePhone = useCallback(() => setIsPhoneOpen(false), [])
  const phone = usePhoneCompanionStatus()
  const phoneConnected = phone?.status?.devices.some(({ connected }) => connected) ?? false
  const [openActionsMenu, setOpenActionsMenu] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Conversation[]>([])
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [movingConversationId, setMovingConversationId] = useState<string | null>(null)
  const [draggingConversationId, setDraggingConversationId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    projectId: string | null
    anchorConversationId: string | null
    placement: 'before' | 'after' | 'end'
    allowed: boolean
  } | null>(null)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem('collapsedProjectIds') || '[]'))
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    window.localStorage.setItem('collapsedProjectIds', JSON.stringify([...collapsedProjectIds]))
  }, [collapsedProjectIds])
  const allProjectsCollapsed =
    projects.length > 0 && projects.every(({ id }) => collapsedProjectIds.has(id))
  const [collapsedFamilyIds, setCollapsedFamilyIds] = useState<Set<string>>(() => {
    try {
      return new Set(
        JSON.parse(window.localStorage.getItem(COLLAPSED_FAMILIES_STORAGE_KEY) || '[]')
      )
    } catch {
      return new Set()
    }
  })
  const toggleFamily = (managerId: string): void =>
    setCollapsedFamilyIds((current) => {
      const next = new Set(current)
      if (!next.delete(managerId)) next.add(managerId)
      try {
        window.localStorage.setItem(COLLAPSED_FAMILIES_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // The choice still applies for this session.
      }
      return next
    })
  const [collapsedSections, setCollapsedSections] = useState<Set<SidebarSection>>(() => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem('collapsedSidebarSections') || '[]'))
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    window.localStorage.setItem('collapsedSidebarSections', JSON.stringify([...collapsedSections]))
  }, [collapsedSections])
  const toggleSection = (section: SidebarSection): void =>
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (!next.delete(section)) next.add(section)
      return next
    })
  const [view, setView] = useState<SidebarView>(() => {
    try {
      return storedSidebarView(window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY))
    } catch {
      return 'folders'
    }
  })
  const changeView = (next: SidebarView): void => {
    setView(next)
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, next)
    } catch {
      // The choice still applies for this session.
    }
  }
  // Not remembered: a filter left on at the next launch would read as missing chats.
  const [statusFilter, setStatusFilter] = useState<SidebarStatusFilter>('all')
  const filtering = statusFilter !== 'all'
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false)
  const filterMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isFilterMenuOpen) return
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setIsFilterMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsFilterMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [isFilterMenuOpen])

  useEffect(() => {
    if (!isMenuOpen) return
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setIsMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [isMenuOpen])

  useEffect(() => {
    if (!openActionsMenu) return
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!(event.target as Element).closest('.sidebar-overflow-wrap')) setOpenActionsMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenActionsMenu(null)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [openActionsMenu])

  useEffect(() => {
    const normalized = query.trim()
    if (!normalized) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      window.api.conversations.search(normalized).then((results) => {
        if (!cancelled) setSearchResults(results)
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query])

  // Archived chats leave the list; search still finds them.
  const liveConversations = useMemo(
    () => conversations.filter((conversation) => !conversation.archived_at),
    [conversations]
  )
  const families = useMemo(() => indexSessionFamilies(liveConversations), [liveConversations])
  // Workers are listed under their manager, wherever each one's project is.
  const topLevelConversations = useMemo(
    () => liveConversations.filter(({ id }) => !families.nestedIds.has(id)),
    [families, liveConversations]
  )

  const conversationsByProject = useMemo(() => {
    const grouped = new Map<string, Conversation[]>()
    for (const conversation of topLevelConversations) {
      if (!conversation.project_id) continue
      const group = grouped.get(conversation.project_id) || []
      group.push(conversation)
      grouped.set(conversation.project_id, group)
    }
    return grouped
  }, [topLevelConversations])

  const standaloneConversations = useMemo(
    () => topLevelConversations.filter((conversation) => !conversation.project_id),
    [topLevelConversations]
  )

  const dotById = useMemo(() => {
    const dots = new Map<string, SidebarDot | null>()
    for (const { id } of conversations) {
      const runStatus = conversationRunStatus(id, {
        waiting: waitingConversationIds,
        busy: busyConversationIds,
        unread: unreadConversationIds
      })
      dots.set(id, sidebarDot(runStatus, sessionStatuses.get(id)?.state))
    }
    return dots
  }, [
    busyConversationIds,
    conversations,
    sessionStatuses,
    unreadConversationIds,
    waitingConversationIds
  ])
  const statusById = useMemo(() => {
    const statuses = new Map<string, ConversationRunStatus | null>()
    for (const [id, dot] of dotById) statuses.set(id, dotFilterStatus(dot))
    return statuses
  }, [dotById])
  const conversationMatches = useCallback(
    (conversation: Conversation): boolean =>
      matchesStatusFilter(statusById.get(conversation.id) ?? null, statusFilter),
    [statusById, statusFilter]
  )
  // A manager is listed when it or one of its workers matches, so a match keeps its context.
  const familyMatches = useCallback(
    (conversation: Conversation): boolean =>
      conversationMatches(conversation) ||
      familyDescendants(families, conversation.id).some(conversationMatches),
    [conversationMatches, families]
  )
  const isFamilyCollapsed = useCallback(
    (managerId: string): boolean => !filtering && collapsedFamilyIds.has(managerId),
    [collapsedFamilyIds, filtering]
  )
  const statusCounts = useMemo(() => {
    const counts: Record<ConversationRunStatus, number> = { waiting: 0, working: 0, unread: 0 }
    for (const status of statusById.values()) if (status) counts[status] += 1
    return counts
  }, [statusById])
  const filteredConversations = useMemo(
    () => topLevelConversations.filter(familyMatches),
    [familyMatches, topLevelConversations]
  )
  // Day headings only depend on the date, so the clock advances once, at midnight.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(() => setNow(Date.now()), midnight.getTime() - now)
    return () => window.clearTimeout(timer)
  }, [now])
  // A family is as recent as its latest chat, so a busy worker keeps its manager near the top.
  const recentGroups = useMemo(
    () =>
      groupConversationsByRecency(
        filteredConversations.map((conversation) => {
          const latest = Math.max(
            conversation.updated_at,
            ...familyDescendants(families, conversation.id).map(({ updated_at }) => updated_at)
          )
          return latest > conversation.updated_at
            ? { ...conversation, updated_at: latest }
            : conversation
        }),
        now
      ),
    [families, filteredConversations, now]
  )
  const standaloneMatches = filtering
    ? standaloneConversations.filter(familyMatches)
    : standaloneConversations
  const listedProjects = projects
  const projectsWithMatches = filtering
    ? listedProjects.filter((project) =>
        (conversationsByProject.get(project.id) || []).some(familyMatches)
      )
    : listedProjects
  // A filter shows every match, so it opens closed sections and projects.
  const isSectionCollapsed = (section: SidebarSection): boolean =>
    !filtering && collapsedSections.has(section)

  const searching = !isCollapsed && query.trim().length > 0
  const visibleSearchResults = useMemo(
    () => searchResults.filter(conversationMatches),
    [conversationMatches, searchResults]
  )
  // Keyboard moves follow the rows as shown: each manager, then its visible workers.
  const visibleConversationOrder = useMemo(() => {
    if (searching) return visibleSearchResults.map(({ id }) => id)
    if (isCollapsed) {
      return expandFamilies(
        sidebarConversationOrder(topLevelConversations, projects),
        families,
        () => false
      )
    }
    const include = filtering ? conversationMatches : undefined
    if (view === 'recent') {
      return expandFamilies(
        recentGroups.flatMap((group) => group.conversations.map(({ id }) => id)),
        families,
        isFamilyCollapsed,
        include
      )
    }
    return expandFamilies(
      filtering
        ? sidebarConversationOrder(filteredConversations, projects)
        : sidebarConversationOrder(
            topLevelConversations,
            projects,
            collapsedSections.has('projects')
              ? new Set(projects.map(({ id }) => id))
              : collapsedProjectIds,
            collapsedSections.has('chats')
          ),
      families,
      isFamilyCollapsed,
      include
    )
  }, [
    collapsedProjectIds,
    collapsedSections,
    conversationMatches,
    families,
    filteredConversations,
    filtering,
    isCollapsed,
    isFamilyCollapsed,
    projects,
    recentGroups,
    searching,
    topLevelConversations,
    view,
    visibleSearchResults
  ])
  useEffect(() => {
    onVisibleConversationOrderChange?.(visibleConversationOrder)
  }, [onVisibleConversationOrderChange, visibleConversationOrder])

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )

  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations]
  )

  const currentConversation = currentConversationId
    ? conversationById.get(currentConversationId)
    : undefined
  const compactDestination = currentConversation?.project_id
    ? 'projects'
    : currentConversation
      ? 'chats'
      : null

  const canMoveToProject = (conversation: Conversation, projectId: string | null): boolean => {
    if (conversation.project_id === projectId) return true
    if (projectId === null) return conversation.project_id !== null
    if (conversation.project_id !== null) return false
    const project = projects.find((candidate) => candidate.id === projectId)
    if (!project) return false
    return (
      conversation.home_workspace_root === null ||
      conversation.home_workspace_root === project.folder_path
    )
  }

  const finishDrop = (target: NonNullable<typeof dropTarget>): void => {
    if (!draggingConversationId || !target.allowed) return
    const conversation = conversationById.get(draggingConversationId)
    if (!conversation) return
    onMoveConversation({
      conversationId: conversation.id,
      projectId: target.projectId,
      anchorConversationId: target.anchorConversationId,
      placement: target.placement,
      expectedProjectContextVersion: conversation.project_context_version
    })
    setDraggingConversationId(null)
    setDropTarget(null)
  }

  const setSectionDropTarget = (event: React.DragEvent, projectId: string | null): void => {
    if (!draggingConversationId || busyConversationIds.has(draggingConversationId)) return
    const conversation = conversationById.get(draggingConversationId)
    if (!conversation) return
    const allowed = canMoveToProject(conversation, projectId)
    if (allowed) event.preventDefault()
    event.stopPropagation()
    setDropTarget({ projectId, anchorConversationId: null, placement: 'end', allowed })
  }

  const toggleProject = (projectId: string): void => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const beginConversationRename = (conversation: Conversation): void => {
    setRenamingConversationId(conversation.id)
    setRenamingProjectId(null)
    setRenameValue(conversation.title)
  }

  const beginProjectRename = (project: Project): void => {
    setRenamingProjectId(project.id)
    setRenamingConversationId(null)
    setRenameValue(project.name)
  }

  const finishRename = (): void => {
    const normalized = renameValue.trim()
    if (normalized && renamingConversationId) {
      onRenameConversation(renamingConversationId, normalized)
    }
    if (normalized && renamingProjectId) onRenameProject(renamingProjectId, normalized)
    setRenamingConversationId(null)
    setRenamingProjectId(null)
  }

  const renderConversation = (
    conversation: Conversation,
    options: ConversationRowOptions = {}
  ): React.JSX.Element => {
    const isConversationBusy = busyConversationIds.has(conversation.id)
    const actionsMenuKey = `conversation:${conversation.id}`
    const workers = familyWorkers(families, conversation.id)
    const descendants = workers.length ? familyDescendants(families, conversation.id) : []
    const familyCollapsed = workers.length > 0 && isFamilyCollapsed(conversation.id)
    const ownDot = dotById.get(conversation.id) ?? null
    const workerDots = descendants.map(({ id }) => dotById.get(id) ?? null)
    // A worker that needs the user marks its manager too; a closed family shows its most urgent.
    const dot = familyCollapsed
      ? mostUrgentDot([ownDot, ...workerDots])
      : workerDots.includes('waiting')
        ? 'waiting'
        : ownDot
    const rollUp = workers.length ? familyRollUpLabel(workerDots) : ''
    const manager = options.worker
      ? conversationById.get(conversation.started_by_conversation_id ?? '')
      : undefined
    // A worker elsewhere stays with its manager and names its own project instead.
    const workerHome = conversation.project_id
    const projectTag =
      manager && workerHome && workerHome !== manager.project_id
        ? (projectNameById.get(workerHome) ?? conversation.home_project_name)
        : null
    const label =
      options.title ?? (options.worker && conversation.session_handle) ?? conversation.title
    return (
      <div
        key={conversation.id}
        className={`conversation-item ${options.nested ? 'nested' : ''} ${
          options.worker ? 'session-worker' : ''
        } ${workers.length ? 'session-manager' : ''} ${options.context ? 'is-context' : ''} ${
          currentConversationId === conversation.id ? 'active' : ''
        } ${draggingConversationId === conversation.id ? 'dragging' : ''} ${
          dropTarget?.anchorConversationId === conversation.id
            ? dropTarget.allowed
              ? `drop-${dropTarget.placement}`
              : 'drop-invalid'
            : ''
        }`}
        // Order is the user's only in the unfiltered folder view; elsewhere "Move to" remains.
        // Workers belong to their manager's family and move with it.
        draggable={
          view === 'folders' &&
          !filtering &&
          !options.worker &&
          !isConversationBusy &&
          renamingConversationId !== conversation.id
        }
        onDragStart={(event) => {
          setDraggingConversationId(conversation.id)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', conversation.id)
        }}
        onDragEnd={() => {
          setDraggingConversationId(null)
          setDropTarget(null)
        }}
        onDragOver={(event) => {
          if (
            options.worker ||
            !draggingConversationId ||
            draggingConversationId === conversation.id
          )
            return
          const dragged = conversationById.get(draggingConversationId)
          if (!dragged) return
          const allowed = canMoveToProject(dragged, conversation.project_id)
          if (allowed) event.preventDefault()
          event.stopPropagation()
          const bounds = event.currentTarget.getBoundingClientRect()
          setDropTarget({
            projectId: conversation.project_id,
            anchorConversationId: conversation.id,
            placement: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
            allowed
          })
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (dropTarget) finishDrop(dropTarget)
        }}
      >
        <>
          {workers.length > 0 && (
            <button
              type="button"
              className="session-family-toggle"
              onClick={() => toggleFamily(conversation.id)}
              disabled={filtering}
              aria-expanded={!familyCollapsed}
              aria-label={`${familyCollapsed ? 'Show' : 'Hide'} the chats ${conversation.title} started`}
              title={familyCollapsed ? 'Show the chats it started' : 'Hide the chats it started'}
            >
              {familyCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
          <span className="conversation-main">
            {renamingConversationId === conversation.id ? (
              <div className="conversation-content">
                <input
                  className="conversation-rename-input"
                  value={renameValue}
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={finishRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') setRenamingConversationId(null)
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                className="conversation-select-button conversation-content"
                onClick={() => onSelectConversation(conversation.id)}
                onDoubleClick={() => beginConversationRename(conversation)}
                title={`${conversation.title}${projectTag ? ` · in ${projectTag}` : ''} — double-click to rename`}
              >
                <span className="conversation-title">
                  {conversation.worktree_id && (
                    <FolderGit2
                      size={12}
                      className="conversation-worktree-icon"
                      aria-label="Works in its own worktree"
                    />
                  )}
                  <WrittenTitle text={label || conversation.title} identity={conversation.id} />
                </span>
                {rollUp && (
                  // Whole items drop off the end when the row is narrow, rather than a cut word.
                  <span className="conversation-metadata session-roll-up">
                    {rollUp.split(' · ').map((item, index) => (
                      <Fragment key={item}>
                        {index > 0 && ' '}
                        <span className="session-roll-up-item">
                          {index > 0 && '· '}
                          {item}
                        </span>
                      </Fragment>
                    ))}
                  </span>
                )}
                {options.showProject && conversation.project_id && (
                  <span className="conversation-metadata">
                    {projectNameById.get(conversation.project_id)}
                  </span>
                )}
                {!conversation.project_id && conversation.home_project_name && (
                  <span className="conversation-metadata">
                    Detached from {conversation.home_project_name}
                  </span>
                )}
              </button>
            )}
            {/* Wraps onto the hidden second line, and so disappears, when too little of it fits.
                Renaming hides it, since the row's clipped height would cut the field. */}
            {projectTag && renamingConversationId !== conversation.id && (
              <span className="session-project-tag" title={`In ${projectTag}`}>
                {projectTag}
              </span>
            )}
          </span>
          {dot && (
            <span
              className={`conversation-run-indicator ${dot}`}
              title={SIDEBAR_DOT_LABELS[dot]}
              aria-label={SIDEBAR_DOT_LABELS[dot]}
            />
          )}
          <span className="conversation-actions">
            <button
              type="button"
              className="conversation-action-button conversation-delete-button"
              disabled={isConversationBusy}
              onClick={(event) => {
                event.stopPropagation()
                setOpenActionsMenu(null)
                setDeleteConfirm(conversation.id)
              }}
              title="Delete chat"
              aria-label={`Delete ${conversation.title}`}
            >
              <Trash2 size={14} />
            </button>
            <span className="sidebar-overflow-wrap">
              <button
                type="button"
                className="conversation-action-button"
                onClick={(event) => {
                  event.stopPropagation()
                  setOpenActionsMenu((current) =>
                    current === actionsMenuKey ? null : actionsMenuKey
                  )
                }}
                title="Chat actions"
                aria-label={`Actions for ${conversation.title}`}
                aria-haspopup="menu"
                aria-expanded={openActionsMenu === actionsMenuKey}
              >
                <MoreHorizontal size={15} />
              </button>
              {openActionsMenu === actionsMenuKey && (
                <div className="app-menu sidebar-overflow-menu" role="menu">
                  <MenuItem
                    icon={<Pencil size={14} />}
                    label="Rename"
                    onClick={() => {
                      setOpenActionsMenu(null)
                      beginConversationRename(conversation)
                    }}
                  />
                  <MenuItem
                    icon={conversation.is_pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    label={conversation.is_pinned ? 'Unpin chat' : 'Pin chat'}
                    onClick={() => {
                      setOpenActionsMenu(null)
                      onToggleConversationPin(conversation.id, !conversation.is_pinned)
                    }}
                  />
                  <MenuItem
                    icon={<FolderInput size={14} />}
                    label="Move to"
                    disabled={isConversationBusy}
                    onClick={() => {
                      setOpenActionsMenu(null)
                      setMovingConversationId(conversation.id)
                    }}
                  />
                  <MenuItem
                    icon={<GitFork size={14} />}
                    label="Fork chat"
                    disabled={isConversationBusy}
                    onClick={() => {
                      setOpenActionsMenu(null)
                      onForkConversation(conversation.id)
                    }}
                  />
                </div>
              )}
            </span>
          </span>
          {movingConversationId === conversation.id && (
            <div
              className="app-menu conversation-move-menu"
              role="menu"
              aria-label="Move to"
              onMouseLeave={() => setMovingConversationId(null)}
            >
              <div className="app-menu-heading section-heading" role="presentation">
                Move to
              </div>
              <MenuItem
                role="menuitemradio"
                aria-checked={!conversation.project_id}
                icon={!conversation.project_id && <Check size={14} />}
                label="Standalone chat"
                disabled={!conversation.project_id}
                onClick={() => {
                  onMoveConversation({
                    conversationId: conversation.id,
                    projectId: null,
                    placement: 'start',
                    expectedProjectContextVersion: conversation.project_context_version
                  })
                  setMovingConversationId(null)
                }}
              />
              {projects
                .filter((project) => canMoveToProject(conversation, project.id))
                .map((project) => (
                  <MenuItem
                    role="menuitemradio"
                    aria-checked={conversation.project_id === project.id}
                    icon={conversation.project_id === project.id && <Check size={14} />}
                    label={project.name}
                    title={project.name}
                    key={project.id}
                    onClick={() => {
                      onMoveConversation({
                        conversationId: conversation.id,
                        projectId: project.id,
                        placement: 'start',
                        expectedProjectContextVersion: conversation.project_context_version
                      })
                      setMovingConversationId(null)
                    }}
                  />
                ))}
            </div>
          )}
        </>
      </div>
    )
  }

  // A chat and, under a thin guide line, the chats it started. A filter lists only the workers
  // it matches, with their manager kept as context.
  const renderFamily = (
    conversation: Conversation,
    options: ConversationRowOptions = {}
  ): React.JSX.Element => {
    const workers = familyWorkers(families, conversation.id)
    if (!workers.length) return renderConversation(conversation, options)
    const shown = filtering
      ? workers.filter(
          (worker) =>
            conversationMatches(worker) ||
            familyDescendants(families, worker.id).some(conversationMatches)
        )
      : workers
    return (
      <div className="session-family" key={conversation.id}>
        {renderConversation(conversation, {
          ...options,
          context: filtering && !conversationMatches(conversation)
        })}
        {shown.length > 0 && (
          <Reveal open={!isFamilyCollapsed(conversation.id)}>
            <div
              className="session-family-workers"
              role="group"
              aria-label={`Chats ${conversation.title} started`}
            >
              {shown.map((worker) => renderFamily(worker, { nested: true, worker: true }))}
            </div>
          </Reveal>
        )}
      </div>
    )
  }

  // A schedule's chats share one row, so its runs do not crowd out the user's own chats.
  const renderConversationList = (
    list: Conversation[],
    options: { nested?: boolean; showProject?: boolean } = {}
  ): React.JSX.Element[] =>
    groupScheduledConversations(list, scheduleNames).map((entry) =>
      entry.kind === 'conversation' ? (
        renderFamily(entry.conversation, options)
      ) : (
        <ScheduledRunGroupRow
          key={`schedule:${entry.group.scheduleId}`}
          group={entry.group}
          currentConversationId={currentConversationId}
          nested={options.nested}
          waiting={waitingConversationIds}
          busy={busyConversationIds}
          unread={unreadConversationIds}
          renderConversation={(conversation, title) =>
            renderFamily(conversation, { nested: true, title })
          }
        />
      )
    )

  const sectionHeading = (
    section: SidebarSection,
    label: string,
    count: number
  ): React.JSX.Element => {
    if (filtering) return <span>{label}</span>
    const collapsed = collapsedSections.has(section)
    return (
      <button
        type="button"
        className="sidebar-section-toggle"
        onClick={() => toggleSection(section)}
        aria-expanded={!collapsed}
        title={collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
      >
        <ChevronDown
          size={12}
          className={`sidebar-section-chevron ${collapsed ? 'is-collapsed' : ''}`}
          aria-hidden="true"
        />
        <span>{label}</span>
        {/* What a closed section holds, so nothing seems to have gone missing. */}
        {collapsed && count > 0 && <span className="sidebar-section-count">{count}</span>}
      </button>
    )
  }

  const moreMenu = (
    <div className="sidebar-menu-wrap" ref={menuRef}>
      <button
        className={`sidebar-icon-btn sidebar-menu-btn ${isMenuOpen ? 'active' : ''}`}
        onClick={() => setIsMenuOpen((current) => !current)}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
      >
        <MoreHorizontal size={16} />
      </button>
      {isMenuOpen && (
        <div className="app-menu sidebar-menu" role="menu">
          <MenuItem
            icon={<SquarePen size={14} />}
            label="New chat"
            hint={shortcutLabel('new-chat', platform)}
            onClick={() => {
              setIsMenuOpen(false)
              onNewConversation(null)
            }}
          />
          <MenuItem
            icon={<Command size={14} />}
            label="Command palette"
            hint={shortcutLabel('command-palette', platform)}
            onClick={() => {
              setIsMenuOpen(false)
              onOpenCommandPalette()
            }}
          />
          {/* Expanded, these live on their section's heading, and Recent has no Projects heading. */}
          {(isCollapsed || view === 'recent') && (
            <MenuItem
              icon={<FolderPlus size={14} />}
              label="Open project"
              hint={shortcutLabel('open-project', platform)}
              onClick={() => {
                setIsMenuOpen(false)
                onOpenProject()
              }}
            />
          )}
          {projects.length > 1 && !isCollapsed && view === 'folders' && (
            <MenuItem
              icon={
                allProjectsCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />
              }
              label={allProjectsCollapsed ? 'Expand all projects' : 'Collapse all projects'}
              onClick={() => {
                setIsMenuOpen(false)
                setCollapsedProjectIds(
                  allProjectsCollapsed ? new Set() : new Set(projects.map(({ id }) => id))
                )
              }}
            />
          )}
          {conversations.length > 0 && !isCollapsed && (
            <>
              <div className="app-menu-separator" role="separator" />
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                label="Clear all chats"
                disabled={busyConversationIds.size > 0}
                title={
                  busyConversationIds.size > 0
                    ? 'Stop active conversations before clearing chat history'
                    : 'Delete all conversation history'
                }
                onClick={() => {
                  setIsMenuOpen(false)
                  setDeleteAllConfirm(true)
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  )

  // Expanded, a labelled row on the tree's grid with the connection dot in its status slot; on
  // the rail, an icon button with the dot cut out of the glyph's corner. The dot is the shared
  // 6px one in the accent, shown only while a phone is connected.
  const phoneButton = phone && (
    <button
      ref={phoneButtonRef}
      type="button"
      className={`${isCollapsed ? 'sidebar-icon-btn sidebar-phone-btn' : 'sidebar-phone-row'}${isPhoneOpen ? ' active' : ''}`}
      onClick={() => setIsPhoneOpen((current) => !current)}
      title={phoneConnected ? 'Phone connected' : 'Phone'}
      aria-label={phoneConnected ? 'Phone connected' : 'Phone'}
      aria-haspopup="dialog"
      aria-expanded={isPhoneOpen}
    >
      <span className="sidebar-phone-glyph">
        <Smartphone size={16} />
        {isCollapsed && phoneConnected && (
          <span className="conversation-run-indicator sidebar-phone-dot" aria-hidden="true" />
        )}
      </span>
      {!isCollapsed && <span className="sidebar-phone-label">Phone</span>}
      {!isCollapsed && phoneConnected && (
        <span className="conversation-run-indicator" aria-hidden="true" />
      )}
    </button>
  )

  // Surfaces waiting chats even inside closed projects, and on the rail, where the filter that
  // carries this count is folded away: expanding the sidebar leads back to it.
  // Folded, the toggle carries the waiting count whatever the filter, since the filter's own badge
  // is hidden with the header; expanded, the filter button shows it unless it already filters by it.
  const hasWaiting = statusCounts.waiting > 0
  const showWaitingCount = hasWaiting && statusFilter !== 'waiting'
  const waitingLabel = `${statusCounts.waiting} need attention`

  return (
    <>
      <aside
        className={`sidebar${isCollapsed ? ' collapsed' : ''}${isClosing ? ' is-closing' : ''}`}
      >
        <div className="sidebar-header">
          <button
            className="sidebar-icon-btn sidebar-toggle-btn"
            onClick={onToggleCollapsed}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={
              isCollapsed
                ? `Expand sidebar${hasWaiting ? `, ${waitingLabel}` : ''}`
                : 'Collapse sidebar'
            }
          >
            <PanelLeft size={16} />
            {isCollapsed && hasWaiting && (
              <span className="count-badge is-attention" aria-hidden="true">
                {statusCounts.waiting}
              </span>
            )}
          </button>
          {!isCollapsed && <span className="sidebar-heading">SideKick</span>}
          <div className="sidebar-header-actions">
            {!isCollapsed && onOpenSchedules && (
              <button
                type="button"
                className="sidebar-icon-btn"
                onClick={onOpenSchedules}
                title="Schedules"
                aria-label="Schedules"
              >
                <CalendarClock size={15} />
              </button>
            )}
            {!isCollapsed && (conversations.length > 0 || filtering) && (
              <>
                {/* One button flips the layout, so the header keeps room for the name. */}
                <button
                  type="button"
                  className="sidebar-icon-btn sidebar-view-toggle"
                  data-view={view}
                  onClick={() => changeView(view === 'folders' ? 'recent' : 'folders')}
                  title={
                    view === 'folders'
                      ? 'Grouped by folder. Click to list by recent activity'
                      : 'Listed by recent activity. Click to group by folder'
                  }
                  aria-label={
                    view === 'folders'
                      ? 'Grouped by folder, switch to recent activity'
                      : 'Listed by recent activity, switch to folders'
                  }
                >
                  {view === 'folders' ? <Folder size={15} /> : <History size={15} />}
                </button>
                <div className="sidebar-menu-wrap" ref={filterMenuRef}>
                  <button
                    className={`sidebar-icon-btn sidebar-filter-btn ${
                      filtering || isFilterMenuOpen ? 'active' : ''
                    }`}
                    onClick={() => setIsFilterMenuOpen((current) => !current)}
                    title={
                      filtering
                        ? `Showing: ${SIDEBAR_STATUS_FILTER_LABELS[statusFilter]}`
                        : 'Filter chats'
                    }
                    aria-label="Filter chats"
                    aria-haspopup="menu"
                    aria-expanded={isFilterMenuOpen}
                  >
                    <ListFilter size={15} />
                    {showWaitingCount && (
                      <span
                        className="sidebar-filter-badge count-badge is-attention"
                        aria-label={waitingLabel}
                      >
                        {statusCounts.waiting}
                      </span>
                    )}
                  </button>
                  {isFilterMenuOpen && (
                    <div className="app-menu sidebar-menu sidebar-filter-menu" role="menu">
                      {SIDEBAR_STATUS_FILTERS.map((filter) => (
                        <MenuItem
                          role="menuitemradio"
                          aria-checked={statusFilter === filter}
                          checked={statusFilter === filter}
                          key={filter}
                          icon={
                            filter === 'all' ? (
                              <MessageSquare size={14} />
                            ) : (
                              <span className={`conversation-run-indicator ${filter}`} />
                            )
                          }
                          label={SIDEBAR_STATUS_FILTER_LABELS[filter]}
                          hint={filter === 'all' ? undefined : statusCounts[filter]}
                          onClick={() => {
                            setIsFilterMenuOpen(false)
                            setStatusFilter(filter)
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            {!isCollapsed && moreMenu}
          </div>
        </div>

        {!isCollapsed && (conversations.length > 0 || projects.length > 0) && (
          <SearchField
            className="sidebar-search"
            value={query}
            onChange={setQuery}
            placeholder="Search chats"
            aria-label="Search conversations"
          />
        )}

        {!isCollapsed && filtering && (
          <div className="sidebar-filter-chip">
            <span className={`conversation-run-indicator ${statusFilter}`} aria-hidden="true" />
            <span>{SIDEBAR_STATUS_FILTER_LABELS[statusFilter]}</span>
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              title="Show all chats"
              aria-label="Show all chats"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {!isCollapsed && (
          <div className="sidebar-new-chat">
            <button
              type="button"
              className="sidebar-new-chat-row"
              onClick={() => onNewConversation(null)}
              title={`New chat (${shortcutLabel('new-chat', platform)})`}
            >
              <SquarePen size={16} aria-hidden="true" />
              <span>New chat</span>
            </button>
          </div>
        )}

        <div className="conversation-list">
          {isCollapsed ? (
            <nav className="collapsed-sidebar-nav" aria-label="Sidebar destinations">
              {listedProjects.length > 0 && (
                <button
                  type="button"
                  className={compactDestination === 'projects' ? 'active' : ''}
                  onClick={onToggleCollapsed}
                  title={`Projects · ${listedProjects.length}`}
                  aria-label={`Expand projects, ${listedProjects.length} total`}
                >
                  <FolderOpen size={16} />
                  <span className="count-badge" aria-hidden="true">
                    {listedProjects.length}
                  </span>
                </button>
              )}
              {standaloneConversations.length > 0 && (
                <button
                  type="button"
                  className={compactDestination === 'chats' ? 'active' : ''}
                  onClick={onToggleCollapsed}
                  title={`Chats · ${standaloneConversations.length}`}
                  aria-label={`Expand standalone chats, ${standaloneConversations.length} total`}
                >
                  <MessageSquare size={16} />
                  <span className="count-badge" aria-hidden="true">
                    {standaloneConversations.length}
                  </span>
                </button>
              )}
              {onOpenSchedules && (
                <>
                  {/* Chat lists above, other places below. */}
                  <span className="collapsed-sidebar-divider" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={onOpenSchedules}
                    title="Schedules"
                    aria-label="Schedules"
                  >
                    <CalendarClock size={16} />
                  </button>
                </>
              )}
            </nav>
          ) : query.trim() ? (
            <section className="sidebar-section">
              <div className="section-heading sidebar-section-label">Search results</div>
              {visibleSearchResults.length > 0 ? (
                visibleSearchResults.map((conversation) =>
                  renderConversation(conversation, { showProject: true })
                )
              ) : (
                <div className="empty-conversations">No matching chats</div>
              )}
            </section>
          ) : (
            <>
              {view === 'recent' ? (
                recentGroups.map((group) => (
                  <section className="sidebar-section recent-section" key={group.bucket}>
                    <div className="section-heading sidebar-section-label">{group.label}</div>
                    {renderConversationList(group.conversations, { showProject: true })}
                  </section>
                ))
              ) : (
                <>
                  {(!filtering || projectsWithMatches.length > 0) && (
                    <section className="sidebar-section project-section">
                      <div className="section-heading sidebar-section-label sidebar-section-label-with-action">
                        {sectionHeading('projects', 'Projects', listedProjects.length)}
                        <button
                          type="button"
                          className="sidebar-section-create"
                          onClick={onOpenProject}
                          title={`Open a folder as a project (${shortcutLabel('open-project', platform)})`}
                          aria-label="Open a folder as a project"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      {isSectionCollapsed('projects') ? null : listedProjects.length === 0 ? (
                        <button
                          type="button"
                          className="project-empty-action"
                          onClick={onOpenProject}
                        >
                          <FolderPlus size={15} />
                          <span>Open a folder as a project</span>
                        </button>
                      ) : (
                        projectsWithMatches.map((project) => {
                          const projectConversations = (
                            conversationsByProject.get(project.id) || []
                          ).filter(familyMatches)
                          const isProjectCollapsed =
                            !filtering && collapsedProjectIds.has(project.id)
                          const hasActiveConversation = projectConversations.some(
                            (conversation) => conversation.id === currentConversationId
                          )
                          return (
                            <div
                              className={`project-group ${
                                dropTarget?.projectId === project.id &&
                                dropTarget.anchorConversationId === null
                                  ? dropTarget.allowed
                                    ? 'drop-zone-active'
                                    : 'drop-zone-invalid'
                                  : ''
                              }`}
                              key={project.id}
                              onDragOver={(event) => setSectionDropTarget(event, project.id)}
                              onDragLeave={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                                  setDropTarget(null)
                                }
                              }}
                              onDrop={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                if (dropTarget) finishDrop(dropTarget)
                              }}
                            >
                              <div
                                className={`project-row ${hasActiveConversation ? 'contains-active' : ''}`}
                              >
                                <button
                                  type="button"
                                  className="project-toggle"
                                  onClick={() => toggleProject(project.id)}
                                  aria-label={`${isProjectCollapsed ? 'Expand' : 'Collapse'} ${project.name}`}
                                >
                                  {isProjectCollapsed ? (
                                    <ChevronRight size={13} />
                                  ) : (
                                    <ChevronDown size={13} />
                                  )}
                                </button>
                                <FolderOpen size={15} className="project-folder-icon" />
                                {renamingProjectId === project.id ? (
                                  <input
                                    className="project-rename-input"
                                    value={renameValue}
                                    autoFocus
                                    onChange={(event) => setRenameValue(event.target.value)}
                                    onBlur={finishRename}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') event.currentTarget.blur()
                                      if (event.key === 'Escape') setRenamingProjectId(null)
                                    }}
                                  />
                                ) : (
                                  <button
                                    type="button"
                                    className="project-name"
                                    onClick={() => toggleProject(project.id)}
                                    onDoubleClick={() => beginProjectRename(project)}
                                    title={`${[project.folder_path, ...(project.folders ?? []).map((folder) => folder.path)].join('\n')}\nDouble-click to rename`}
                                  >
                                    {project.name}
                                  </button>
                                )}
                                <span className="project-actions">
                                  <button
                                    type="button"
                                    onClick={() => onNewConversation(project.id)}
                                    title={`New chat in ${project.name}`}
                                    aria-label={`New chat in ${project.name}`}
                                  >
                                    <SquarePen size={13} />
                                  </button>
                                  <span className="sidebar-overflow-wrap">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setOpenActionsMenu((current) =>
                                          current === `project:${project.id}`
                                            ? null
                                            : `project:${project.id}`
                                        )
                                      }
                                      title="Project actions"
                                      aria-label={`Actions for ${project.name}`}
                                      aria-haspopup="menu"
                                      aria-expanded={openActionsMenu === `project:${project.id}`}
                                    >
                                      <MoreHorizontal size={15} />
                                    </button>
                                    {openActionsMenu === `project:${project.id}` && (
                                      <div className="app-menu sidebar-overflow-menu" role="menu">
                                        <MenuItem
                                          icon={<Pencil size={14} />}
                                          label="Rename"
                                          onClick={() => {
                                            setOpenActionsMenu(null)
                                            beginProjectRename(project)
                                          }}
                                        />
                                        {onEditProject && (
                                          <MenuItem
                                            icon={<FolderPlus size={14} />}
                                            label="Edit project…"
                                            onClick={() => {
                                              setOpenActionsMenu(null)
                                              onEditProject(project.id)
                                            }}
                                          />
                                        )}
                                        <MenuItem
                                          icon={
                                            project.is_pinned ? (
                                              <PinOff size={14} />
                                            ) : (
                                              <Pin size={14} />
                                            )
                                          }
                                          label={project.is_pinned ? 'Unpin' : 'Pin'}
                                          onClick={() => {
                                            setOpenActionsMenu(null)
                                            onToggleProjectPin(project.id, !project.is_pinned)
                                          }}
                                        />
                                        <div className="app-menu-separator" role="separator" />
                                        <MenuItem
                                          danger
                                          icon={<Trash2 size={14} />}
                                          label="Remove project"
                                          onClick={() => {
                                            setOpenActionsMenu(null)
                                            setRemoveProjectConfirm(project.id)
                                          }}
                                          disabled={(
                                            conversationsByProject.get(project.id) || []
                                          ).some((conversation) =>
                                            busyConversationIds.has(conversation.id)
                                          )}
                                        />
                                      </div>
                                    )}
                                  </span>
                                </span>
                              </div>
                              <Reveal open={!isProjectCollapsed}>
                                <div className="project-conversations">
                                  {renderConversationList(projectConversations, { nested: true })}
                                  {!filtering && projectConversations.length === 0 ? (
                                    <button
                                      type="button"
                                      className="project-new-chat-empty"
                                      onClick={() => onNewConversation(project.id)}
                                    >
                                      <SquarePen size={14} aria-hidden="true" />
                                      <span>New chat</span>
                                    </button>
                                  ) : null}
                                </div>
                              </Reveal>
                            </div>
                          )
                        })
                      )}
                    </section>
                  )}

                  {(!filtering || standaloneMatches.length > 0) && (
                    <section
                      className={`sidebar-section standalone-section ${
                        dropTarget?.projectId === null && dropTarget.anchorConversationId === null
                          ? dropTarget.allowed
                            ? 'drop-zone-active'
                            : 'drop-zone-invalid'
                          : ''
                      }`}
                      onDragOver={(event) => setSectionDropTarget(event, null)}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node))
                          setDropTarget(null)
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        if (dropTarget) finishDrop(dropTarget)
                      }}
                    >
                      <div className="section-heading sidebar-section-label sidebar-section-label-with-action">
                        {sectionHeading('chats', 'Chats', standaloneConversations.length)}
                        <button
                          type="button"
                          className="sidebar-section-create"
                          onClick={() => onNewConversation(null)}
                          title="New chat"
                          aria-label="New standalone chat"
                        >
                          <SquarePen size={13} />
                        </button>
                      </div>
                      {isSectionCollapsed('chats') ? null : standaloneMatches.length > 0 ? (
                        renderConversationList(standaloneMatches)
                      ) : (
                        <div className="empty-conversations compact">
                          <Folder size={15} />
                          <span>Standalone chats appear here</span>
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}

              {filtering && filteredConversations.length === 0 ? (
                <div className="empty-conversations">{EMPTY_FILTER_MESSAGES[statusFilter]}</div>
              ) : view === 'recent' && conversations.length === 0 ? (
                <div className="empty-conversations compact">
                  <MessageSquare size={15} />
                  <span>Chats appear here</span>
                </div>
              ) : null}
            </>
          )}
        </div>
        {/* The rail keeps its menu at the bottom, out of the way of the places above. */}
        {isCollapsed ? (
          <div className="sidebar-rail-footer">
            {phoneButton}
            {moreMenu}
          </div>
        ) : (
          phoneButton && <div className="sidebar-footer">{phoneButton}</div>
        )}
      </aside>

      {phone && (
        <PhoneCompanionPanel
          isOpen={isPhoneOpen}
          companion={phone}
          anchorRef={phoneButtonRef}
          placement={isCollapsed ? 'beside' : 'above'}
          onClose={closePhone}
        />
      )}

      <ConfirmDialog
        isOpen={deleteConfirm !== null}
        title="Delete conversation?"
        message="This conversation and its messages will be permanently deleted."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        onConfirm={() => {
          if (deleteConfirm) onDeleteConversation(deleteConfirm)
          setDeleteConfirm(null)
        }}
        onCancel={() => setDeleteConfirm(null)}
      />

      <ConfirmDialog
        isOpen={removeProjectConfirm !== null}
        title="Remove project?"
        message="The folder will not be changed. Its conversations will be kept as standalone chats."
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
        onConfirm={() => {
          if (removeProjectConfirm) onRemoveProject(removeProjectConfirm)
          setRemoveProjectConfirm(null)
        }}
        onCancel={() => setRemoveProjectConfirm(null)}
      />

      <ConfirmDialog
        isOpen={deleteAllConfirm}
        title="Clear all conversations?"
        message={`Delete all ${conversations.length} conversation${conversations.length === 1 ? '' : 's'}? Project folders will remain.`}
        confirmText="Clear all"
        cancelText="Cancel"
        variant="danger"
        onConfirm={() => {
          onDeleteAllConversations()
          setDeleteAllConfirm(false)
        }}
        onCancel={() => setDeleteAllConfirm(false)}
      />
    </>
  )
}

export default Sidebar
