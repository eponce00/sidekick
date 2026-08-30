import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
  Users
} from 'lucide-react'
import type { Conversation, Project } from '../types/app.types'
import type { MoveConversationInput } from '../../../shared/projects'
import type { CollaborationGroup } from '../../../shared/collaboration'
import { groupAgentSessionsByProject } from '../utils/projectAgentSessions'
import ConfirmDialog from './ConfirmDialog'
import './Sidebar.css'

interface SidebarProps {
  conversations: Conversation[]
  projects: Project[]
  groups: CollaborationGroup[]
  currentConversationId: string | null
  currentGroupId: string | null
  currentGroupSessionId: string | null
  isCollapsed: boolean
  busyConversationIds: ReadonlySet<string>
  unreadConversationIds: ReadonlySet<string>
  onSelectConversation: (id: string) => void
  onSelectGroup: (id: string) => void
  onSelectGroupSession: (groupId: string, sessionId: string) => void
  onToggleCollapsed: () => void
  onNewConversation: (projectId?: string | null) => void
  onNewGroup: () => void
  onOpenProject: () => void
  onDeleteConversation: (id: string) => void
  onDeleteGroup: (id: string) => void
  onDeleteAllConversations: () => void
  onForkConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onRenameGroup: (id: string, title: string) => void
  onRenameGroupSession: (id: string, title: string) => void
  onMoveConversation: (input: MoveConversationInput) => void
  onRenameProject: (id: string, name: string) => void
  onToggleConversationPin: (id: string, pinned: boolean) => void
  onToggleProjectPin: (id: string, pinned: boolean) => void
  onRemoveProject: (id: string) => void
}

function Sidebar({
  conversations,
  projects,
  groups,
  currentConversationId,
  currentGroupId,
  currentGroupSessionId,
  isCollapsed,
  busyConversationIds,
  unreadConversationIds,
  onSelectConversation,
  onSelectGroup,
  onSelectGroupSession,
  onToggleCollapsed,
  onNewConversation,
  onNewGroup,
  onOpenProject,
  onDeleteConversation,
  onDeleteGroup,
  onDeleteAllConversations,
  onForkConversation,
  onRenameConversation,
  onRenameGroup,
  onRenameGroupSession,
  onMoveConversation,
  onRenameProject,
  onToggleConversationPin,
  onToggleProjectPin,
  onRemoveProject
}: SidebarProps): React.JSX.Element {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [deleteGroupConfirm, setDeleteGroupConfirm] = useState<string | null>(null)
  const [removeProjectConfirm, setRemoveProjectConfirm] = useState<string | null>(null)
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false)
  const [isNewMenuOpen, setIsNewMenuOpen] = useState(false)
  const [openActionsMenu, setOpenActionsMenu] = useState<string | null>(null)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Conversation[]>([])
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [renamingGroupSessionId, setRenamingGroupSessionId] = useState<string | null>(null)
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

  useEffect(() => {
    if (!isNewMenuOpen) return
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (!newMenuRef.current?.contains(event.target as Node)) setIsNewMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsNewMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [isNewMenuOpen])

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

  const conversationsByProject = useMemo(() => {
    const grouped = new Map<string, Conversation[]>()
    for (const conversation of conversations) {
      if (!conversation.project_id) continue
      const group = grouped.get(conversation.project_id) || []
      group.push(conversation)
      grouped.set(conversation.project_id, group)
    }
    return grouped
  }, [conversations])

  const standaloneConversations = useMemo(
    () => conversations.filter((conversation) => !conversation.project_id),
    [conversations]
  )

  const activeGroups = useMemo(() => groups.filter(({ status }) => status === 'active'), [groups])

  const agentSessionsByProject = useMemo(() => groupAgentSessionsByProject(groups), [groups])

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
  const compactDestination = currentGroupId
    ? currentGroupSessionId
      ? 'projects'
      : 'groups'
    : currentConversation?.project_id
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
    setRenamingGroupId(null)
    setRenamingGroupSessionId(null)
    setRenamingProjectId(null)
    setRenameValue(conversation.title)
  }

  const beginProjectRename = (project: Project): void => {
    setRenamingProjectId(project.id)
    setRenamingConversationId(null)
    setRenamingGroupId(null)
    setRenamingGroupSessionId(null)
    setRenameValue(project.name)
  }

  const beginGroupSessionRename = (session: CollaborationGroup['agentSessions'][number]): void => {
    setRenamingGroupSessionId(session.id)
    setRenamingConversationId(null)
    setRenamingGroupId(null)
    setRenamingProjectId(null)
    setRenameValue(session.title)
  }

  const beginGroupRename = (group: CollaborationGroup): void => {
    setRenamingGroupId(group.id)
    setRenamingConversationId(null)
    setRenamingGroupSessionId(null)
    setRenamingProjectId(null)
    setRenameValue(group.title)
  }

  const finishRename = (): void => {
    const normalized = renameValue.trim()
    if (normalized && renamingConversationId) {
      onRenameConversation(renamingConversationId, normalized)
    }
    if (normalized && renamingGroupId) onRenameGroup(renamingGroupId, normalized)
    if (normalized && renamingProjectId) onRenameProject(renamingProjectId, normalized)
    if (normalized && renamingGroupSessionId) {
      onRenameGroupSession(renamingGroupSessionId, normalized)
    }
    setRenamingConversationId(null)
    setRenamingGroupId(null)
    setRenamingGroupSessionId(null)
    setRenamingProjectId(null)
  }

  const renderConversation = (
    conversation: Conversation,
    options: { nested?: boolean; showProject?: boolean } = {}
  ): React.JSX.Element => {
    const isConversationBusy = busyConversationIds.has(conversation.id)
    const hasUnreadCompletion = unreadConversationIds.has(conversation.id)
    const actionsMenuKey = `conversation:${conversation.id}`
    return (
      <div
        key={conversation.id}
        className={`conversation-item ${options.nested ? 'nested' : ''} ${
          currentConversationId === conversation.id ? 'active' : ''
        } ${draggingConversationId === conversation.id ? 'dragging' : ''} ${
          dropTarget?.anchorConversationId === conversation.id
            ? dropTarget.allowed
              ? `drop-${dropTarget.placement}`
              : 'drop-invalid'
            : ''
        }`}
        draggable={!isConversationBusy && renamingConversationId !== conversation.id}
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
          if (!draggingConversationId || draggingConversationId === conversation.id) return
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
              title={`${conversation.title} — double-click to rename`}
            >
              <span className="conversation-title">{conversation.title}</span>
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
          {(isConversationBusy || hasUnreadCompletion) && (
            <span
              className={`conversation-run-indicator ${isConversationBusy ? 'working' : 'unread'}`}
              title={
                isConversationBusy ? 'Agent working in background' : 'Completed response unread'
              }
              aria-label={
                isConversationBusy ? 'Agent working in background' : 'Completed response unread'
              }
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
                <div className="sidebar-overflow-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenActionsMenu(null)
                      beginConversationRename(conversation)
                    }}
                  >
                    <Pencil size={13} /> Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenActionsMenu(null)
                      onToggleConversationPin(conversation.id, !conversation.is_pinned)
                    }}
                  >
                    {conversation.is_pinned ? <PinOff size={13} /> : <Pin size={13} />}
                    {conversation.is_pinned ? 'Unpin chat' : 'Pin chat'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isConversationBusy}
                    onClick={() => {
                      setOpenActionsMenu(null)
                      setMovingConversationId(conversation.id)
                    }}
                  >
                    <FolderInput size={13} /> Move to
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isConversationBusy}
                    onClick={() => {
                      setOpenActionsMenu(null)
                      onForkConversation(conversation.id)
                    }}
                  >
                    <GitBranch size={13} strokeWidth={1.8} /> Fork chat
                  </button>
                </div>
              )}
            </span>
          </span>
          {movingConversationId === conversation.id && (
            <div
              className="conversation-move-menu"
              onMouseLeave={() => setMovingConversationId(null)}
            >
              <span className="conversation-move-heading">Move to</span>
              <button
                type="button"
                className={!conversation.project_id ? 'selected' : ''}
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
              >
                Standalone chat
              </button>
              {projects
                .filter((project) => canMoveToProject(conversation, project.id))
                .map((project) => (
                  <button
                    type="button"
                    className={conversation.project_id === project.id ? 'selected' : ''}
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
                  >
                    {project.name}
                  </button>
                ))}
            </div>
          )}
        </>
      </div>
    )
  }

  return (
    <>
      <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <button
            className="sidebar-icon-btn sidebar-toggle-btn"
            onClick={onToggleCollapsed}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <PanelLeft size={16} />
          </button>
          {!isCollapsed && <span className="sidebar-heading">SideKick</span>}
          <div className="sidebar-header-actions">
            <div className="sidebar-new-menu-wrap" ref={newMenuRef}>
              <button
                className={`sidebar-icon-btn sidebar-new-btn ${isNewMenuOpen ? 'active' : ''}`}
                onClick={() => setIsNewMenuOpen((current) => !current)}
                title="Create new"
                aria-label="Create new"
                aria-haspopup="menu"
                aria-expanded={isNewMenuOpen}
              >
                <SquarePen size={16} />
              </button>
              {isNewMenuOpen && (
                <div className="sidebar-new-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsNewMenuOpen(false)
                      onNewConversation(null)
                    }}
                  >
                    <SquarePen size={15} />
                    <span>New chat</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsNewMenuOpen(false)
                      onNewGroup()
                    }}
                  >
                    <Users size={15} />
                    <span>New group chat</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsNewMenuOpen(false)
                      onOpenProject()
                    }}
                  >
                    <FolderPlus size={15} />
                    <span>Open project</span>
                  </button>
                  {conversations.length > 0 && !isCollapsed && (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      disabled={busyConversationIds.size > 0}
                      title={
                        busyConversationIds.size > 0
                          ? 'Stop active conversations before clearing chat history'
                          : 'Delete all conversation history'
                      }
                      onClick={() => {
                        setIsNewMenuOpen(false)
                        setDeleteAllConfirm(true)
                      }}
                    >
                      <Trash2 size={15} />
                      <span>Clear all chats</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {!isCollapsed && (conversations.length > 0 || projects.length > 0 || groups.length > 0) && (
          <label className="sidebar-search">
            <Search size={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              aria-label="Search conversations"
            />
          </label>
        )}

        <div className="conversation-list">
          {isCollapsed ? (
            <nav className="collapsed-sidebar-nav" aria-label="Sidebar destinations">
              {activeGroups.length > 0 && (
                <button
                  type="button"
                  className={compactDestination === 'groups' ? 'active' : ''}
                  onClick={onToggleCollapsed}
                  title={`Groups (${activeGroups.length})`}
                  aria-label={`Expand groups, ${activeGroups.length} total`}
                >
                  <Users size={16} />
                  <span>{activeGroups.length}</span>
                </button>
              )}
              {projects.length > 0 && (
                <button
                  type="button"
                  className={compactDestination === 'projects' ? 'active' : ''}
                  onClick={onToggleCollapsed}
                  title={`Projects (${projects.length})`}
                  aria-label={`Expand projects, ${projects.length} total`}
                >
                  <FolderOpen size={16} />
                  <span>{projects.length}</span>
                </button>
              )}
              {standaloneConversations.length > 0 && (
                <button
                  type="button"
                  className={compactDestination === 'chats' ? 'active' : ''}
                  onClick={onToggleCollapsed}
                  title={`Standalone chats (${standaloneConversations.length})`}
                  aria-label={`Expand standalone chats, ${standaloneConversations.length} total`}
                >
                  <MessageSquare size={16} />
                  <span>{standaloneConversations.length}</span>
                </button>
              )}
            </nav>
          ) : query.trim() ? (
            <section className="sidebar-section">
              <div className="sidebar-section-label">Search results</div>
              {searchResults.length > 0 ? (
                searchResults.map((conversation) =>
                  renderConversation(conversation, { showProject: true })
                )
              ) : (
                <div className="empty-conversations">No matching chats</div>
              )}
            </section>
          ) : (
            <>
              <section className="sidebar-section groups-section">
                <div className="sidebar-section-label">Groups</div>
                {activeGroups.length ? (
                  activeGroups.map((group) => (
                    <div key={group.id} className="group-sidebar-item">
                      <div
                        className={`group-sidebar-row ${currentGroupId === group.id && !currentGroupSessionId ? 'active' : ''}`}
                      >
                        {renamingGroupId === group.id ? (
                          <div className="group-sidebar-select">
                            <span className="group-sidebar-icon">
                              <Users size={14} />
                            </span>
                            <input
                              className="group-rename-input"
                              value={renameValue}
                              autoFocus
                              onChange={(event) => setRenameValue(event.target.value)}
                              onBlur={finishRename}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur()
                                if (event.key === 'Escape') setRenamingGroupId(null)
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="group-sidebar-select"
                            onClick={() => onSelectGroup(group.id)}
                            onDoubleClick={() => beginGroupRename(group)}
                            title={`${group.title} — double-click to rename`}
                          >
                            <span className="group-sidebar-icon">
                              <Users size={14} />
                            </span>
                            <span className="group-sidebar-copy">
                              <strong>{group.title}</strong>
                              <small>
                                {(group.activeMissionId || group.unreadCompletionAt) && (
                                  <span
                                    className={`group-live-dot ${
                                      group.activeMissionId
                                        ? group.activeMissionStatus === 'paused'
                                          ? 'paused'
                                          : 'working'
                                        : 'unread'
                                    }`}
                                    title={
                                      group.activeMissionId
                                        ? group.activeMissionStatus === 'paused'
                                          ? 'Agents paused'
                                          : 'Agents working'
                                        : 'Completed group response unread'
                                    }
                                  />
                                )}
                                {group.activeMissionStatus === 'paused'
                                  ? 'Paused'
                                  : group.activeMissionId
                                    ? 'Working'
                                    : `${group.participantCount} agents`}
                              </small>
                            </span>
                          </button>
                        )}
                        <span className="group-sidebar-actions sidebar-overflow-wrap">
                          <button
                            type="button"
                            className="group-sidebar-action"
                            onClick={() =>
                              setOpenActionsMenu((current) =>
                                current === `group:${group.id}` ? null : `group:${group.id}`
                              )
                            }
                            title="Group actions"
                            aria-label={`Actions for ${group.title}`}
                            aria-haspopup="menu"
                            aria-expanded={openActionsMenu === `group:${group.id}`}
                          >
                            <MoreHorizontal size={15} />
                          </button>
                          {openActionsMenu === `group:${group.id}` && (
                            <div className="sidebar-overflow-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setOpenActionsMenu(null)
                                  beginGroupRename(group)
                                }}
                              >
                                <Pencil size={13} /> Rename
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                onClick={() => {
                                  setOpenActionsMenu(null)
                                  setDeleteGroupConfirm(group.id)
                                }}
                              >
                                <Trash2 size={13} /> Archive
                              </button>
                            </div>
                          )}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <button type="button" className="project-empty-action" onClick={onNewGroup}>
                    <Users size={15} />
                    <span>Start a group chat</span>
                  </button>
                )}
              </section>

              <section className="sidebar-section project-section">
                <div className="sidebar-section-label">Projects</div>
                {projects.length === 0 ? (
                  <button type="button" className="project-empty-action" onClick={onOpenProject}>
                    <FolderPlus size={15} />
                    <span>Open a folder as a project</span>
                  </button>
                ) : (
                  projects.map((project) => {
                    const projectConversations = conversationsByProject.get(project.id) || []
                    const projectAgentSessions = agentSessionsByProject.get(project.id) || []
                    const isProjectCollapsed = collapsedProjectIds.has(project.id)
                    const hasActiveConversation =
                      projectConversations.some(
                        (conversation) => conversation.id === currentConversationId
                      ) ||
                      projectAgentSessions.some(
                        ({ session }) => session.id === currentGroupSessionId
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
                              title={`${project.folder_path} — double-click to rename`}
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
                                <div className="sidebar-overflow-menu" role="menu">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setOpenActionsMenu(null)
                                      beginProjectRename(project)
                                    }}
                                  >
                                    <Pencil size={13} /> Rename
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setOpenActionsMenu(null)
                                      onToggleProjectPin(project.id, !project.is_pinned)
                                    }}
                                  >
                                    {project.is_pinned ? <PinOff size={13} /> : <Pin size={13} />}
                                    {project.is_pinned ? 'Unpin' : 'Pin'}
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="danger"
                                    onClick={() => {
                                      setOpenActionsMenu(null)
                                      setRemoveProjectConfirm(project.id)
                                    }}
                                    disabled={(conversationsByProject.get(project.id) || []).some(
                                      (conversation) => busyConversationIds.has(conversation.id)
                                    )}
                                  >
                                    <Trash2 size={13} /> Remove project
                                  </button>
                                </div>
                              )}
                            </span>
                          </span>
                        </div>
                        {!isProjectCollapsed && (
                          <div className="project-conversations">
                            {projectConversations.map((conversation) =>
                              renderConversation(conversation, { nested: true })
                            )}
                            {projectAgentSessions.map(({ group, session }) => {
                              const isBusy = ['queued', 'working'].includes(
                                session.activeRunStatus || ''
                              )
                              const hasUnreadCompletion = Boolean(session.unreadCompletionAt)
                              return (
                                <div
                                  key={session.id}
                                  className={`conversation-item nested ${
                                    currentGroupSessionId === session.id ? 'active' : ''
                                  }`}
                                >
                                  {renamingGroupSessionId === session.id ? (
                                    <div className="conversation-content">
                                      <input
                                        className="conversation-rename-input"
                                        value={renameValue}
                                        autoFocus
                                        onChange={(event) => setRenameValue(event.target.value)}
                                        onBlur={finishRename}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter') event.currentTarget.blur()
                                          if (event.key === 'Escape') {
                                            setRenamingGroupSessionId(null)
                                          }
                                        }}
                                      />
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      className="conversation-select-button conversation-content"
                                      onClick={() => onSelectGroupSession(group.id, session.id)}
                                      onDoubleClick={() => beginGroupSessionRename(session)}
                                      title={`${session.title} — double-click to rename`}
                                    >
                                      <span className="conversation-title">{session.title}</span>
                                    </button>
                                  )}
                                  {(isBusy || hasUnreadCompletion) && (
                                    <span
                                      className={`conversation-run-indicator ${isBusy ? 'working' : 'unread'}`}
                                      title={
                                        isBusy
                                          ? 'Agent working in background'
                                          : 'Completed response unread'
                                      }
                                      aria-label={
                                        isBusy
                                          ? 'Agent working in background'
                                          : 'Completed response unread'
                                      }
                                    />
                                  )}
                                  <span className="conversation-actions sidebar-overflow-wrap">
                                    <button
                                      type="button"
                                      className="conversation-action-button"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        setOpenActionsMenu((current) =>
                                          current === `session:${session.id}`
                                            ? null
                                            : `session:${session.id}`
                                        )
                                      }}
                                      title="Chat actions"
                                      aria-label={`Actions for ${session.title}`}
                                      aria-haspopup="menu"
                                      aria-expanded={openActionsMenu === `session:${session.id}`}
                                    >
                                      <MoreHorizontal size={15} />
                                    </button>
                                    {openActionsMenu === `session:${session.id}` && (
                                      <div className="sidebar-overflow-menu" role="menu">
                                        <button
                                          type="button"
                                          role="menuitem"
                                          onClick={() => {
                                            setOpenActionsMenu(null)
                                            beginGroupSessionRename(session)
                                          }}
                                        >
                                          <Pencil size={13} /> Rename
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          onClick={() => {
                                            setOpenActionsMenu(null)
                                            onSelectGroup(group.id)
                                          }}
                                        >
                                          <Users size={13} /> Open group
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          className="danger"
                                          onClick={() => {
                                            setOpenActionsMenu(null)
                                            setDeleteGroupConfirm(group.id)
                                          }}
                                        >
                                          <Trash2 size={13} /> Archive group
                                        </button>
                                      </div>
                                    )}
                                  </span>
                                </div>
                              )
                            })}
                            {projectConversations.length === 0 &&
                            projectAgentSessions.length === 0 ? (
                              <button
                                type="button"
                                className="project-new-chat-empty"
                                onClick={() => onNewConversation(project.id)}
                              >
                                <SquarePen size={12} /> New chat
                              </button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </section>

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
                <div className="sidebar-section-label sidebar-section-label-with-action">
                  <span>Chats</span>
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
                {standaloneConversations.length > 0 ? (
                  standaloneConversations.map((conversation) => renderConversation(conversation))
                ) : (
                  <div className="empty-conversations compact">
                    <Folder size={15} />
                    <span>Standalone chats appear here</span>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </aside>

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
        isOpen={deleteGroupConfirm !== null}
        title="Archive group chat?"
        message="This hides the group and stops its active mission while preserving the shared timeline. Project folders are not changed."
        confirmText="Archive"
        cancelText="Cancel"
        variant="danger"
        onConfirm={() => {
          if (deleteGroupConfirm) onDeleteGroup(deleteGroupConfirm)
          setDeleteGroupConfirm(null)
        }}
        onCancel={() => setDeleteGroupConfirm(null)}
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
