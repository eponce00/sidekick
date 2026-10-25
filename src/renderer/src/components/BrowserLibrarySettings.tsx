import { useCallback, useEffect, useState } from 'react'
import { Import, Library, Trash2 } from 'lucide-react'
import type { BrowserLibrarySource } from '../../../shared/browserLibrary'
import { BrowserImportDialog } from './BrowserLibrary'
import { SettingsEmptyState, SettingsRow, SettingsSection } from './SettingsLayout'

function describe(source: BrowserLibrarySource): string {
  const parts = [
    source.bookmarks ? `${source.bookmarks.toLocaleString()} bookmarks` : '',
    source.history ? `${source.history.toLocaleString()} pages of history` : ''
  ].filter(Boolean)
  return `${parts.join(', ')} · imported ${new Date(source.importedAt).toLocaleDateString()}`
}

/** Bookmarks and history imported from other browsers, each import removable. */
export function BrowserLibrarySettings(): React.JSX.Element {
  const [sources, setSources] = useState<BrowserLibrarySource[] | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(() => {
    void window.api.browserLibrary
      .sources()
      .then(setSources)
      .catch(() => setSources([]))
  }, [])

  useEffect(load, [load])

  return (
    <SettingsSection
      icon={Library}
      title="Imported browser data"
      description="Bookmarks and history from your other browsers, for the Browser panel's bookmarks and address suggestions. They stay on this computer and the agent never sees them. Passwords, cookies, and sign-ins are not imported."
      actions={
        <button
          type="button"
          className="settings-secondary-action"
          onClick={() => setImportOpen(true)}
        >
          <Import size={14} aria-hidden="true" />
          Import…
        </button>
      }
    >
      {sources && sources.length > 0 ? (
        sources.map((source) => (
          <SettingsRow
            key={source.id}
            label={source.label}
            description={describe(source)}
            control={
              <button
                type="button"
                className="settings-ghost-action is-small is-icon settings-remove-action"
                aria-label={`Remove ${source.label}`}
                title="Remove"
                onClick={() =>
                  void window.api.browserLibrary
                    .remove(source.id)
                    .then(setSources)
                    .catch(() => undefined)
                }
              >
                <Trash2 size={14} />
              </button>
            }
          />
        ))
      ) : (
        <SettingsEmptyState compact icon={Library} title={sources ? 'None yet.' : 'Loading…'} />
      )}
      <BrowserImportDialog
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={load}
      />
    </SettingsSection>
  )
}
