import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Bell, Bot, Boxes, Palette, Search, Server, Settings2 } from 'lucide-react'
import type { ProviderSettings } from '../types/app.types'
import {
  DEFAULT_TOOL_CALL_LIMIT,
  MAX_TOOL_CALL_LIMIT,
  MIN_TOOL_CALL_LIMIT,
  TOOL_CALL_LIMIT_POLICY_VERSION
} from '../types/app.types'
import {
  pinnedModelsFromProviderInstances,
  syncLegacyProviderSettings
} from '../../../shared/providerInstances'
import { normalizeToolCallLimit } from '../../../shared/agentLimits'
import { validateMcpServerConfig } from '../../../shared/mcp'
import { ACCENT_PALETTES, applyAccentPalette } from '../constants/accentPalettes'
import { McpServerSettings } from './McpServerSettings'
import { PermissionAuditPanel } from './PermissionAuditPanel'
import { ProviderSettingsPanel } from './ProviderSettingsPanel'
import { AppUpdateSettings } from './AppUpdateControls'
import { useModalDialog } from '../hooks/useModalDialog'
import { settingsSectionContributions, type SettingsSectionId } from '../services/uiContributions'
import './SettingsModal.css'

export type { AccentPalette } from '../constants/accentPalettes'
export { applyAccentPalette } from '../constants/accentPalettes'
export type { ProviderSettings } from '../types/app.types'

export type SettingsSection = SettingsSectionId

interface SettingsModalProps {
  settings: ProviderSettings
  onSave: (settings: ProviderSettings) => Promise<{ success: boolean; error?: string }>
  onClose: () => void
  initialSection?: SettingsSection
}

const SETTINGS_ICONS = {
  server: Server,
  settings: Settings2,
  bot: Bot,
  palette: Palette,
  boxes: Boxes
}

const NAV_ITEMS = settingsSectionContributions.list().map(({ value }) => ({
  ...value,
  icon: SETTINGS_ICONS[value.icon]
}))

function SettingCard({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="settings-card">
      <div className="settings-card-heading">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-card-content">{children}</div>
    </section>
  )
}

function ToggleField({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className={`settings-toggle-row ${disabled ? 'disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <span className="modern-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span />
      </span>
    </label>
  )
}

function SettingsModal({
  settings: initialSettings,
  onSave,
  onClose,
  initialSection = 'providers'
}: SettingsModalProps): React.JSX.Element {
  const [settings, setSettings] = useState<ProviderSettings>(initialSettings)
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)
  const [navigationQuery, setNavigationQuery] = useState('')
  const [mcpValidationError, setMcpValidationError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose)
  const planningModels = pinnedModelsFromProviderInstances(settings.providerInstances || []).filter(
    (model) => model.supportsTools !== false
  )
  const visibleNavigationItems = useMemo(
    () =>
      NAV_ITEMS.filter((item) =>
        `${item.label} ${item.description}`
          .toLowerCase()
          .includes(navigationQuery.trim().toLowerCase())
      ),
    [navigationQuery]
  )

  useEffect(() => {
    if (!navigationQuery.trim() || !visibleNavigationItems.length) return
    if (!visibleNavigationItems.some((item) => item.id === activeSection)) {
      setActiveSection(visibleNavigationItems[0].id)
    }
  }, [activeSection, navigationQuery, visibleNavigationItems])

  const handleSave = async (): Promise<void> => {
    const mcpServers = settings.mcpServers ?? []
    if (
      mcpServers.some(
        (server) => server.enabled !== false && validateMcpServerConfig(server) !== null
      )
    ) {
      setActiveSection('integrations')
      setMcpValidationError(
        'Enabled MCP connectors need a valid ID, display name, and secure transport target.'
      )
      return
    }
    setMcpValidationError(null)
    setSaveError(null)
    setSaving(true)
    try {
      const result = await onSave(
        syncLegacyProviderSettings({
          ...settings,
          mcpServers,
          toolCallLimit: normalizeToolCallLimit(settings.toolCallLimit),
          toolCallLimitVersion: TOOL_CALL_LIMIT_POLICY_VERSION
        })
      )
      if (result.success) onClose()
      else setSaveError(result.error || 'Settings could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const handleExportDiagnostics = async (): Promise<void> => {
    setExportingDiagnostics(true)
    setDiagnosticsStatus(null)
    try {
      const result = await window.api.support.export()
      if (result.canceled) return
      setDiagnosticsStatus(
        result.success
          ? { kind: 'success', message: 'Diagnostic report exported.' }
          : {
              kind: 'error',
              message: result.error || 'Diagnostic report could not be exported.'
            }
      )
    } catch {
      setDiagnosticsStatus({
        kind: 'error',
        message: 'Diagnostic report could not be exported.'
      })
    } finally {
      setExportingDiagnostics(false)
    }
  }

  const renderSection = (): React.ReactNode => {
    if (activeSection === 'providers') {
      return (
        <ProviderSettingsPanel
          instances={settings.providerInstances || []}
          onChange={(providerInstances) => setSettings({ ...settings, providerInstances })}
        />
      )
    }

    if (activeSection === 'general') {
      return (
        <div className="settings-page">
          <div className="settings-page-heading">
            <h2>General</h2>
            <p>Everyday behavior without provider-specific noise.</p>
          </div>
          <SettingCard
            title="Notifications"
            description="Only notify when SideKick is not focused."
          >
            <ToggleField
              label="Completion notifications"
              hint="Use Notification Center or Windows notifications when a response finishes."
              checked={settings.notificationsEnabled ?? true}
              onChange={(notificationsEnabled) =>
                setSettings({ ...settings, notificationsEnabled })
              }
            />
            <ToggleField
              label="Notification sound"
              hint="Allow the operating system to play its notification sound."
              checked={settings.notificationSoundEnabled ?? false}
              disabled={!(settings.notificationsEnabled ?? true)}
              onChange={(notificationSoundEnabled) =>
                setSettings({ ...settings, notificationSoundEnabled })
              }
            />
          </SettingCard>
          <SettingCard
            title="Location"
            description="Optional context for weather, travel, and local recommendations."
          >
            <label className="modern-field">
              <span>City or region</span>
              <input
                value={settings.manualLocation || ''}
                onChange={(event) =>
                  setSettings({ ...settings, manualLocation: event.target.value })
                }
                placeholder="Reno, NV"
              />
            </label>
          </SettingCard>
          <SettingCard
            title="Updates"
            description="Check the public project releases. Installation stays under your control."
          >
            <AppUpdateSettings />
          </SettingCard>
          <SettingCard
            title="Support"
            description="Create a metadata-only report for troubleshooting."
          >
            <div className="support-export-row">
              <span>
                <strong>Diagnostic report</strong>
                <small>
                  Excludes conversations, prompts, files, paths, endpoints, model names, logs, and
                  credentials.
                </small>
              </span>
              <button
                type="button"
                className="settings-secondary-action"
                onClick={() => void handleExportDiagnostics()}
                disabled={exportingDiagnostics}
              >
                {exportingDiagnostics ? 'Exporting…' : 'Export diagnostics'}
              </button>
            </div>
            {diagnosticsStatus && (
              <p
                className={`support-export-status ${diagnosticsStatus.kind}`}
                role="status"
                aria-live="polite"
              >
                {diagnosticsStatus.message}
              </p>
            )}
          </SettingCard>
        </div>
      )
    }

    if (activeSection === 'agent') {
      return (
        <div className="settings-page">
          <div className="settings-page-heading">
            <h2>Agent</h2>
            <p>Control autonomy, long-running work, and default capabilities.</p>
          </div>
          <SettingCard title="Run behavior">
            <ToggleField
              label="Focus Chain"
              hint="Track multi-step work with a visible task list."
              checked={settings.focusChainEnabled ?? true}
              onChange={(focusChainEnabled) => setSettings({ ...settings, focusChainEnabled })}
            />
            <ToggleField
              label="Auto compact"
              hint="Summarize long conversations before context is exhausted."
              checked={settings.autoCompactEnabled ?? true}
              onChange={(autoCompactEnabled) => setSettings({ ...settings, autoCompactEnabled })}
            />
            {settings.autoCompactEnabled !== false && (
              <label className="modern-field">
                <span>
                  Compaction threshold · {Math.round((settings.autoCompactThreshold ?? 0.8) * 100)}%
                </span>
                <input
                  type="range"
                  min="50"
                  max="95"
                  value={(settings.autoCompactThreshold ?? 0.8) * 100}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      autoCompactThreshold: Number(event.target.value) / 100
                    })
                  }
                />
              </label>
            )}
          </SettingCard>
          <SettingCard
            title="Planning"
            description="Use a dedicated model to design a plan, then return to the selected chat model for execution."
          >
            <label className="modern-field">
              <span>Default planning model</span>
              <select
                value={settings.planningModelId || ''}
                onChange={(event) =>
                  setSettings({ ...settings, planningModelId: event.target.value || undefined })
                }
              >
                <option value="">Same as the current chat model</option>
                {planningModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              <small>You can override this from the composer whenever Plan mode is selected.</small>
            </label>
          </SettingCard>
          <SettingCard
            title="Permissions"
            description="One policy applies consistently to shell, files, MCP, checkpoints, and browser actions."
          >
            <label className="modern-field">
              <span>Tool approval mode</span>
              <select
                value={settings.commandPermissionMode || 'full-access'}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    commandPermissionMode: event.target
                      .value as ProviderSettings['commandPermissionMode']
                  })
                }
              >
                <option value="full-access">Full access (default)</option>
                <option value="sensitive-only">Ask only for sensitive actions</option>
                <option value="always-ask">Ask for every write or command</option>
              </select>
              <small>
                Full access runs tools without approval popups. Destructive actions still follow
                SideKick&apos;s safety rules and the scope of your request.
              </small>
            </label>
            <label className="modern-field">
              <span>
                Agent rounds before safety pause <em>Default {DEFAULT_TOOL_CALL_LIMIT}</em>
              </span>
              <input
                type="number"
                min={MIN_TOOL_CALL_LIMIT}
                max={MAX_TOOL_CALL_LIMIT}
                value={settings.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    toolCallLimit: normalizeToolCallLimit(event.target.value)
                  })
                }
              />
            </label>
            <PermissionAuditPanel />
          </SettingCard>
        </div>
      )
    }

    if (activeSection === 'appearance') {
      return (
        <div className="settings-page">
          <div className="settings-page-heading">
            <h2>Appearance</h2>
            <p>Keep SideKick calm, readable, and personal.</p>
          </div>
          <SettingCard title="Accent color">
            <div className="modern-palette-grid">
              {ACCENT_PALETTES.map((palette) => (
                <button
                  type="button"
                  key={palette.id}
                  className={(settings.accentPalette || 'teal') === palette.id ? 'active' : ''}
                  onClick={() => {
                    setSettings({ ...settings, accentPalette: palette.id })
                    applyAccentPalette(
                      palette.id,
                      document.body.dataset.theme === 'light' ? 'light' : 'dark'
                    )
                  }}
                >
                  <i style={{ background: palette.swatch }} />
                  <span>{palette.name}</span>
                </button>
              ))}
            </div>
          </SettingCard>
          <SettingCard
            title="Conversation text"
            description="Adjust messages and the composer without changing the whole interface. Use Ctrl + or Ctrl − for window zoom."
          >
            <label className="modern-field">
              <span>
                Text size <em>{settings.contentFontSize ?? 14}px</em>
              </span>
              <input
                type="range"
                min={12}
                max={17}
                step={1}
                value={settings.contentFontSize ?? 14}
                onChange={(event) => {
                  const contentFontSize = Number(event.target.value)
                  setSettings({ ...settings, contentFontSize })
                  document.documentElement.style.setProperty(
                    '--content-text',
                    `${contentFontSize}px`
                  )
                  document.documentElement.style.setProperty(
                    '--content-text-secondary',
                    `${Math.max(11, contentFontSize - (contentFontSize > 14 ? 2 : 1))}px`
                  )
                }}
              />
            </label>
          </SettingCard>
        </div>
      )
    }

    if (activeSection === 'integrations') {
      return (
        <div className="settings-page">
          <div className="settings-page-heading">
            <h2>Integrations</h2>
            <p>Connect and manage external MCP tool servers.</p>
          </div>
          <SettingCard
            title="MCP servers"
            description="External MCP server commands run as local processes."
          >
            <McpServerSettings
              servers={settings.mcpServers || []}
              onChange={(mcpServers) => setSettings({ ...settings, mcpServers })}
            />
            {mcpValidationError && <span className="field-error">{mcpValidationError}</span>}
          </SettingCard>
        </div>
      )
    }

    return null
  }

  return (
    <div className="modal-overlay settings-overlay">
      <div
        ref={dialogRef}
        className="settings-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
      >
        <aside className="settings-sidebar">
          <button type="button" className="settings-back-button" onClick={onClose}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back to app</span>
          </button>
          <label className="settings-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={navigationQuery}
              onChange={(event) => setNavigationQuery(event.target.value)}
              placeholder="Search settings…"
              aria-label="Find settings sections"
            />
          </label>
          <h1 id="settings-modal-title" className="settings-navigation-title">
            Settings
          </h1>
          <nav>
            {visibleNavigationItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  type="button"
                  key={item.id}
                  className={activeSection === item.id ? 'active' : ''}
                  onClick={() => setActiveSection(item.id)}
                  aria-current={activeSection === item.id ? 'page' : undefined}
                  title={`${item.label} — ${item.description}`}
                >
                  <Icon size={17} />
                  <strong>{item.label}</strong>
                </button>
              )
            })}
            {!visibleNavigationItems.length && (
              <div className="settings-search-empty">No matching section</div>
            )}
          </nav>
          <div className="settings-sidebar-note">
            <Bell size={14} />
            <span>Changes apply after you save.</span>
          </div>
        </aside>
        <div className="settings-main">
          <main
            className="settings-content"
            aria-label={`${NAV_ITEMS.find((item) => item.id === activeSection)?.label} settings`}
            tabIndex={0}
          >
            {renderSection()}
          </main>
          <footer className="settings-footer">
            {saveError && <span className="field-error">{saveError}</span>}
            <button type="button" className="settings-cancel-action" onClick={onClose}>
              Cancel
            </button>
            <button
              className="settings-primary-action"
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </footer>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
