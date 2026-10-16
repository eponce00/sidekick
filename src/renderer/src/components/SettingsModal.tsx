import { useEffect, useId, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  Bot,
  Boxes,
  Check,
  CircleAlert,
  Container,
  Download,
  FileCode2,
  FolderOpen,
  Globe,
  Hand,
  LifeBuoy,
  MapPin,
  Palette,
  RefreshCw,
  Repeat,
  Route,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Type,
  Workflow
} from 'lucide-react'
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
import { ProjectHooksPanel } from './ProjectHooksPanel'
import { BrowserNetworkSettings } from './BrowserNetworkSettings'
import { AppUpdateSettings, AppVersionButton } from './AppUpdateControls'
import { VoiceSettings } from './VoiceSettings'
import { SettingsPageHeader, SettingsRow, SettingsSection, ToggleField } from './SettingsLayout'
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

function SettingsModal({
  settings: initialSettings,
  onSave,
  onClose,
  initialSection = 'providers'
}: SettingsModalProps): React.JSX.Element {
  const [settings, setSettings] = useState<ProviderSettings>(initialSettings)
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)
  const [navigationQuery, setNavigationQuery] = useState('')
  // Set by the version button; the Updates card only exists once General renders.
  const [revealUpdates, setRevealUpdates] = useState(false)
  const [mcpValidationError, setMcpValidationError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose)
  const controlId = useId()
  const unsaved = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(initialSettings),
    [settings, initialSettings]
  )
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
    if (!revealUpdates || activeSection !== 'general') return
    // Instant, after the frame: the section switch is instant too, and the
    // card grows once its release status loads, which cut a smooth scroll short.
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('settings-updates')?.scrollIntoView({ block: 'center' })
      setRevealUpdates(false)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeSection, revealUpdates])

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
          <SettingsPageHeader
            title="General"
            description="Everyday behavior without provider-specific noise."
          />
          <SettingsSection
            icon={Bell}
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
          </SettingsSection>
          <VoiceSettings
            enabled={settings.voiceEnabled ?? true}
            onEnabledChange={(voiceEnabled) => setSettings({ ...settings, voiceEnabled })}
          />
          <SettingsSection
            icon={Globe}
            title="Web search"
            description="Search without an account or API key, through public search engines."
          >
            <ToggleField
              label="Let the agent search the web"
              hint="Sends search text to DuckDuckGo, Brave Search, and Bing, and reads the pages it finds. Off, the agent neither searches nor reads web pages; the browser panel still opens what you or the agent choose."
              checked={settings.webSearchEnabled ?? true}
              onChange={(webSearchEnabled) => setSettings({ ...settings, webSearchEnabled })}
            />
          </SettingsSection>
          <SettingsSection
            icon={MapPin}
            title="Location"
            description="Optional context for weather, travel, and local recommendations."
          >
            <SettingsRow
              label="City or region"
              description="Leave empty to keep your location private."
              controlId={`${controlId}-location`}
              control={
                <input
                  id={`${controlId}-location`}
                  value={settings.manualLocation || ''}
                  onChange={(event) =>
                    setSettings({ ...settings, manualLocation: event.target.value })
                  }
                  placeholder="Reno, NV"
                />
              }
            />
          </SettingsSection>
          <SettingsSection
            id="settings-updates"
            icon={RefreshCw}
            title="Updates"
            description="Check the public project releases. Installation stays under your control."
          >
            <ToggleField
              label="Check automatically"
              hint="Asks GitHub Releases for a newer version after startup and every six hours. Off, SideKick checks only when you choose Check now."
              checked={settings.automaticUpdateChecks ?? true}
              onChange={(automaticUpdateChecks) =>
                setSettings({ ...settings, automaticUpdateChecks })
              }
            />
            <AppUpdateSettings />
          </SettingsSection>
          <SettingsSection
            icon={LifeBuoy}
            title="Support"
            description="Create a metadata-only report for troubleshooting."
          >
            <SettingsRow
              label="Diagnostic report"
              description="Excludes conversations, prompts, files, paths, endpoints, model names, logs, and credentials."
              control={
                <button
                  type="button"
                  className="settings-secondary-action"
                  onClick={() => void handleExportDiagnostics()}
                  disabled={exportingDiagnostics}
                >
                  <Download size={14} aria-hidden="true" />
                  {exportingDiagnostics ? 'Exporting…' : 'Export diagnostics'}
                </button>
              }
            />
            {diagnosticsStatus && (
              <p
                className={`settings-note support-export-status ${diagnosticsStatus.kind}`}
                role="status"
                aria-live="polite"
              >
                {diagnosticsStatus.kind === 'success' ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <CircleAlert size={14} aria-hidden="true" />
                )}
                {diagnosticsStatus.message}
              </p>
            )}
          </SettingsSection>
        </div>
      )
    }

    if (activeSection === 'agent') {
      const compactThreshold = Math.round((settings.autoCompactThreshold ?? 0.8) * 100)
      return (
        <div className="settings-page">
          <SettingsPageHeader
            title="Agent"
            description="Control autonomy, long-running work, and default capabilities."
          />
          <SettingsSection
            icon={Workflow}
            title="Run behavior"
            description="How the agent keeps track of long tasks."
          >
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
              <SettingsRow
                label="Compaction threshold"
                description="How full the context gets before SideKick summarizes it."
                controlId={`${controlId}-compact`}
                control={
                  <>
                    <input
                      id={`${controlId}-compact`}
                      type="range"
                      min="50"
                      max="95"
                      value={compactThreshold}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          autoCompactThreshold: Number(event.target.value) / 100
                        })
                      }
                    />
                    <output className="settings-range-value" htmlFor={`${controlId}-compact`}>
                      {compactThreshold}%
                    </output>
                  </>
                }
              />
            )}
          </SettingsSection>
          <SettingsSection
            icon={Route}
            title="Planning"
            description="Use a dedicated model to design a plan, then return to the selected chat model for execution."
          >
            <SettingsRow
              label="Default planning model"
              description="You can override this from the composer whenever Plan mode is selected."
              controlId={`${controlId}-planning`}
              control={
                <select
                  id={`${controlId}-planning`}
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
              }
            />
          </SettingsSection>
          <SettingsSection
            icon={ShieldCheck}
            title="Permissions"
            description="One policy applies consistently to shell, files, MCP, checkpoints, and browser actions."
          >
            <SettingsRow
              icon={Hand}
              label="Tool approval mode"
              description="Full access runs tools without approval popups. Destructive actions still follow SideKick's safety rules and the scope of your request."
              controlId={`${controlId}-approval`}
              control={
                <select
                  id={`${controlId}-approval`}
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
              }
            />
            <SettingsRow
              icon={Repeat}
              label="Agent rounds before safety pause"
              description={`The agent stops to check in after this many rounds. Default ${DEFAULT_TOOL_CALL_LIMIT}.`}
              controlId={`${controlId}-rounds`}
              control={
                <input
                  id={`${controlId}-rounds`}
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
              }
            />
            <SettingsRow
              icon={Container}
              label="Shell execution environment"
              description="Docker runs commands in a Linux container with only the project mounted and no network. It needs a local Docker daemon, and other tools still run on the host."
              controlId={`${controlId}-shell`}
              control={
                <select
                  id={`${controlId}-shell`}
                  value={settings.shellIsolation ?? 'host'}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      shellIsolation: event.target.value as 'host' | 'docker'
                    })
                  }
                >
                  <option value="host">Host shell (not sandboxed)</option>
                  <option value="docker">Isolated Linux container (no network)</option>
                </select>
              }
            />
            <ToggleField
              icon={SquareTerminal}
              label="Run commands in a terminal"
              hint="Programs behave as they do for you: colours, progress, and prompts you or the agent can answer. Turn off to use plain pipes."
              checked={settings.agentCommandTerminal ?? true}
              onChange={(agentCommandTerminal) =>
                setSettings({ ...settings, agentCommandTerminal })
              }
            />
            <SettingsRow
              icon={FileCode2}
              label="Office helper Python"
              description="Optional. Lets an Office skill check documents with read-only validation. It runs with your normal approvals, never installs packages, and is off in Docker."
              stacked
              control={
                <span className="settings-inline-field">
                  <input
                    className="settings-path-input"
                    aria-label="Office Python interpreter"
                    readOnly
                    value={settings.officeHelperInterpreter ?? ''}
                    placeholder="Not set, direct Office tools are off"
                  />
                  <button
                    type="button"
                    className="settings-secondary-action"
                    aria-label="Choose Office Python"
                    onClick={async () => {
                      const choice = await window.api.settings
                        .selectOfficeInterpreter()
                        .catch(() => ({
                          canceled: false,
                          path: undefined,
                          error: 'Interpreter selection failed'
                        }))
                      if (choice.error) setSaveError(choice.error)
                      if (choice.path) {
                        setSaveError(null)
                        setSettings((current) => ({
                          ...current,
                          officeHelperInterpreter: choice.path
                        }))
                      }
                    }}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                    Choose
                  </button>
                  {settings.officeHelperInterpreter && (
                    <button
                      type="button"
                      className="settings-ghost-action"
                      aria-label="Clear Office Python"
                      onClick={() =>
                        setSettings((current) => ({
                          ...current,
                          officeHelperInterpreter: undefined
                        }))
                      }
                    >
                      Clear
                    </button>
                  )}
                </span>
              }
            />
            <PermissionAuditPanel />
          </SettingsSection>
          <BrowserNetworkSettings />
          <ProjectHooksPanel
            hooks={{
              start: settings.projectStartHooks ?? [],
              completion: settings.projectCompletionHooks ?? [],
              worktree: settings.projectWorktreeHooks ?? []
            }}
            onChange={(stage, hooks) =>
              setSettings({
                ...settings,
                ...(stage === 'start'
                  ? { projectStartHooks: hooks }
                  : stage === 'completion'
                    ? { projectCompletionHooks: hooks }
                    : { projectWorktreeHooks: hooks })
              })
            }
          />
        </div>
      )
    }

    if (activeSection === 'appearance') {
      const textSize = settings.contentFontSize ?? 13
      const activePalette = settings.accentPalette || 'teal'
      return (
        <div className="settings-page">
          <SettingsPageHeader
            title="Appearance"
            description="Keep SideKick calm, readable, and personal."
          />
          <SettingsSection
            icon={Palette}
            title="Accent color"
            description="Highlights the selection, switches, and primary buttons."
          >
            <div className="modern-palette-grid" role="radiogroup" aria-label="Accent color">
              {ACCENT_PALETTES.map((palette) => (
                <button
                  type="button"
                  key={palette.id}
                  role="radio"
                  aria-checked={activePalette === palette.id}
                  className={activePalette === palette.id ? 'active' : ''}
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
                  {activePalette === palette.id && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
          </SettingsSection>
          <SettingsSection
            icon={Type}
            title="Conversation text"
            description="Adjust messages and the composer without changing the whole interface. Use Ctrl + or Ctrl − for window zoom."
          >
            <SettingsRow
              label="Text size"
              controlId={`${controlId}-text-size`}
              control={
                <>
                  <input
                    id={`${controlId}-text-size`}
                    type="range"
                    min={12}
                    max={17}
                    step={1}
                    value={textSize}
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
                  <output className="settings-range-value" htmlFor={`${controlId}-text-size`}>
                    {textSize}px
                  </output>
                </>
              }
            >
              <p className="settings-text-preview">
                SideKick reads, plans, and edits with you. This is how messages will look.
              </p>
            </SettingsRow>
          </SettingsSection>
        </div>
      )
    }

    if (activeSection === 'integrations') {
      return (
        <div className="settings-page">
          <SettingsPageHeader
            title="Integrations"
            description="Connect and manage external MCP tool servers."
          />
          <McpServerSettings
            servers={settings.mcpServers || []}
            onChange={(mcpServers) => setSettings({ ...settings, mcpServers })}
            validationError={mcpValidationError}
          />
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
          <label className="settings-search field-shell">
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
                  <Icon size={16} aria-hidden="true" />
                  <strong>{item.label}</strong>
                </button>
              )
            })}
            {!visibleNavigationItems.length && (
              <div className="settings-search-empty">No matching section</div>
            )}
          </nav>
          <div className="settings-sidebar-footer">
            <AppVersionButton
              onSelect={() => {
                setNavigationQuery('')
                setActiveSection('general')
                setRevealUpdates(true)
              }}
            />
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
            {saveError ? (
              <span className="settings-footer-status error" role="alert">
                <CircleAlert size={14} aria-hidden="true" />
                {saveError}
              </span>
            ) : (
              <span className={`settings-footer-status${unsaved ? ' dirty' : ''}`}>
                {unsaved ? 'Unsaved changes' : 'Changes apply after you save.'}
              </span>
            )}
            <button type="button" className="settings-secondary-action" onClick={onClose}>
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
