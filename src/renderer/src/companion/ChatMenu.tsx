import { useCallback, useState } from 'react'
import {
  Archive,
  Folder,
  FolderMinus,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2
} from 'lucide-react'
import type { CompanionChat, CompanionProject } from '../../../shared/companion'
import type { CompanionConnection } from './chatState'
import { phoneNotice } from './phoneApi'
import { Popover, PopoverItem } from './Popover'
import { Sheet } from './Sheet'

type View = 'menu' | 'projects' | 'delete'

/**
 * The chat's menu from the top bar's ⋮, as the ChatGPT app has one: the chat's name, then pin,
 * rename, its project, find in chat, archive and delete. Each goes through the computer, as the
 * desktop sidebar's menu does.
 */
export function ChatMenu({
  chat,
  projects,
  connection,
  anchor,
  onFind,
  onChanged,
  onGone,
  onClose
}: {
  chat: CompanionChat
  projects: readonly CompanionProject[]
  connection: CompanionConnection
  anchor: HTMLElement | null
  onFind: () => void
  /** The chat changed and should load again. */
  onChanged: () => void
  /** The chat was archived or deleted. */
  onGone: () => void
  onClose: () => void
}) {
  const [view, setView] = useState<View>('menu')
  const [renaming, setRenaming] = useState(false)

  const run = useCallback(async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
    try {
      await work()
      if (done) phoneNotice(done)
      return true
    } catch (error) {
      phoneNotice(error instanceof Error ? error.message : 'The computer did not answer.')
      return false
    }
  }, [])
  const conversationId = chat.id

  if (renaming)
    return (
      <RenameSheet
        title={chat.title}
        onClose={onClose}
        onSave={async (title) => {
          if (await run(() => connection.call('chat.rename', { conversationId, title }))) {
            onChanged()
            onClose()
          }
        }}
      />
    )

  if (view === 'projects')
    return (
      <Popover
        label="Add to project"
        anchor={anchor}
        placement="below-end"
        title="Add to project"
        onBack={() => setView('menu')}
        onClose={onClose}
      >
        {projects.length ? (
          projects.map((project) => (
            <PopoverItem
              key={project.id}
              icon={<Folder size={20} />}
              label={project.name}
              onClick={() => {
                onClose()
                void run(
                  () => connection.call('chat.move', { conversationId, projectId: project.id }),
                  `Moved to ${project.name}`
                ).then((moved) => moved && onChanged())
              }}
            />
          ))
        ) : (
          <p className="cp-popover-note">There are no projects on the computer yet.</p>
        )}
      </Popover>
    )

  if (view === 'delete')
    return (
      <Popover
        label="Delete chat"
        anchor={anchor}
        placement="below-end"
        title="Delete this chat?"
        onBack={() => setView('menu')}
        onClose={onClose}
      >
        <p className="cp-popover-note">
          Its messages are deleted on the computer too. This cannot be undone.
        </p>
        <PopoverItem
          icon={<Trash2 size={20} />}
          label="Delete"
          tone="danger"
          onClick={() => {
            onClose()
            void run(() => connection.call('chat.delete', { conversationId }), 'Chat deleted').then(
              (deleted) => deleted && onGone()
            )
          }}
        />
      </Popover>
    )

  return (
    <Popover
      label="Chat options"
      anchor={anchor}
      placement="below-end"
      title={chat.title || 'Untitled chat'}
      onClose={onClose}
    >
      <PopoverItem
        icon={chat.pinned ? <PinOff size={20} /> : <Pin size={20} />}
        label={chat.pinned ? 'Unpin' : 'Pin'}
        onClick={() => {
          onClose()
          void run(() =>
            connection.call('chat.pin', { conversationId, pinned: !chat.pinned })
          ).then((pinned) => pinned && onChanged())
        }}
      />
      <PopoverItem icon={<Pencil size={20} />} label="Rename" onClick={() => setRenaming(true)} />
      {chat.projectId ? (
        <PopoverItem
          icon={<FolderMinus size={20} />}
          label="Remove from project"
          onClick={() => {
            onClose()
            void run(
              () => connection.call('chat.move', { conversationId, projectId: null }),
              'Removed from the project'
            ).then((moved) => moved && onChanged())
          }}
        />
      ) : (
        <PopoverItem
          icon={<FolderPlus size={20} />}
          label="Add to project"
          submenu
          onClick={() => setView('projects')}
        />
      )}
      <PopoverItem
        icon={<Search size={20} />}
        label="Find in chat"
        onClick={() => {
          onClose()
          onFind()
        }}
      />
      <PopoverItem
        icon={<Archive size={20} />}
        label="Archive"
        onClick={() => {
          onClose()
          void run(() => connection.call('chat.archive', { conversationId }), 'Chat archived').then(
            (archived) => archived && onGone()
          )
        }}
      />
      <PopoverItem
        icon={<Trash2 size={20} />}
        label="Delete"
        tone="danger"
        onClick={() => setView('delete')}
      />
    </Popover>
  )
}

function RenameSheet({
  title,
  onSave,
  onClose
}: {
  title: string
  onSave: (title: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(title)
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    if (!value.trim() || saving) return
    setSaving(true)
    await onSave(value.trim())
    setSaving(false)
  }
  return (
    <Sheet label="Rename chat" onClose={onClose}>
      <form
        className="cp-rename"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="cp-rename-label" htmlFor="cp-rename-input">
          Chat name
        </label>
        <input
          id="cp-rename-input"
          className="cp-rename-input"
          value={value}
          maxLength={200}
          autoFocus
          enterKeyHint="done"
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="submit" className="cp-rename-save" disabled={!value.trim() || saving}>
          Save
        </button>
      </form>
    </Sheet>
  )
}
