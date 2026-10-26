import { useEffect, useState } from 'react'
import {
  Copy,
  FolderTree,
  Minus,
  MonitorUp,
  PictureInPicture,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import smallIconUrl from '../../../build/icon-small.svg?url'
import type { PanelWindowEntry } from '../../shared/panelWindows'
import { applyAccentPalette } from './components/SettingsModal'
import { AppMenuHost } from './components/AppMenuHost'
import BrowserActivityPanel from './components/BrowserActivityPanel'
import { TerminalPanel } from './components/TerminalPanel'
import { FilesPanel } from './components/FilesPanel'
import { useChatFolder } from './hooks/useChatFolder'
import './styles/App.css'
import './components/ActivityPanel.css'
import './PanelWindow.css'

const APPS = {
  browser: { label: 'Browser', icon: <MonitorUp size={15} /> },
  terminal: { label: 'Terminal', icon: <SquareTerminal size={15} /> },
  files: { label: 'Files', icon: <FolderTree size={15} /> }
} as const

function savedTheme(): 'dark' | 'light' {
  return window.localStorage.getItem('theme') === 'light' ? 'light' : 'dark'
}

/**
 * A side panel app in a window of its own, for one chat: its title bar says which, and puts it
 * back in the main window's panel. It follows the main window's theme as it changes.
 */
export function PanelWindow({ entry }: { entry: PanelWindowEntry }): React.JSX.Element {
  const platform = window.api.app.platform
  const [theme, setTheme] = useState(savedTheme)
  const [accentPalette, setAccentPalette] = useState<string | undefined>()
  const [title, setTitle] = useState('')
  const [workspaceFolder, setWorkspaceFolder] = useState<string | null>(null)
  const chatFolder = useChatFolder(entry.conversationId, workspaceFolder)
  const [maximized, setMaximized] = useState(false)
  const app = APPS[entry.app]

  // The main window keeps the theme in storage both windows share; a change there reaches here.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === 'theme') setTheme(savedTheme())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  useEffect(() => {
    const load = (): void =>
      void window.api.settings.load().then((settings) => setAccentPalette(settings?.accentPalette))
    load()
    return window.api.settings.onChanged(load)
  }, [])
  useEffect(() => {
    document.body.dataset.theme = theme
    if (accentPalette) applyAccentPalette(accentPalette, theme)
  }, [theme, accentPalette])

  // The chat's title, and for Files the folder it works in.
  useEffect(() => {
    const load = async (): Promise<void> => {
      const [conversations, projects, worktrees] = await Promise.all([
        window.api.conversations.list(),
        window.api.projects.list(),
        window.api.worktrees.list().catch(() => [])
      ])
      const conversation = conversations.find((item) => item.id === entry.conversationId)
      setTitle(conversation?.title ?? '')
      document.title = `${app.label}${conversation?.title ? ` · ${conversation.title}` : ''} — SideKick`
      setWorkspaceFolder(
        conversation?.worktree_folder ??
          (conversation?.worktree_id
            ? worktrees.find((worktree) => worktree.id === conversation.worktree_id)?.folderPath
            : null) ??
          projects.find((project) => project.id === conversation?.project_id)?.folder_path ??
          null
      )
    }
    void load()
    return window.api.conversations.onListChanged((change) => {
      if (change.conversationId === entry.conversationId) void load()
    })
  }, [entry.conversationId, app.label])

  useEffect(() => {
    if (platform === 'macos') return
    void window.api.window.isMaximized().then(setMaximized)
    return window.api.window.onMaximizedChange(setMaximized)
  }, [platform])

  return (
    <div className={`app panel-window platform-${platform}`}>
      <div className="title-bar">
        <div className="title-bar-left">
          <img src={smallIconUrl} alt="SideKick" className="title-bar-icon" />
          <span className="panel-window-app">
            {app.icon}
            {app.label}
          </span>
          {title && (
            <>
              <span className="title-bar-divider">/</span>
              <span className="title-bar-context">{title}</span>
            </>
          )}
        </div>
        <div className="title-bar-right">
          <div className="title-bar-actions">
            <button
              type="button"
              className="panel-window-dock"
              onClick={() => window.api.panelWindows.dock()}
              title="Put back in the side panel"
              aria-label="Put back in the side panel"
            >
              <PictureInPicture size={16} aria-hidden="true" />
            </button>
          </div>
          {platform !== 'macos' && (
            <div className="window-controls">
              <button
                className="window-control minimize"
                onClick={() => window.api.window.minimize()}
                title="Minimize"
                aria-label="Minimize"
              >
                <Minus size={13} />
              </button>
              <button
                className="window-control maximize"
                onClick={() => window.api.window.maximize()}
                title={maximized ? 'Restore down' : 'Maximize'}
                aria-label={maximized ? 'Restore down' : 'Maximize'}
              >
                {maximized ? <Copy size={11} /> : <Square size={11} />}
              </button>
              <button
                className="window-control close"
                onClick={() => window.api.window.close()}
                title="Close"
                aria-label="Close"
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
      <main className="panel-window-body">
        {entry.app === 'browser' ? (
          <BrowserActivityPanel conversationId={entry.conversationId} />
        ) : entry.app === 'terminal' ? (
          <TerminalPanel conversationId={entry.conversationId} requestedSessionId={null} />
        ) : (
          <FilesPanel
            workspaceFolder={workspaceFolder ?? chatFolder}
            chatFolder={Boolean(chatFolder)}
          />
        )}
      </main>
      <AppMenuHost />
    </div>
  )
}
