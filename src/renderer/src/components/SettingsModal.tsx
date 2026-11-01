import { useEffect, useId, useMemo, useState } from 'react'
import {
  AppWindow,
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
  KeyRound,
  LifeBuoy,
  MapPin,
  MousePointerClick,
  Palette,
  RefreshCw,
  Repeat,
  Route,
  Server,
  Settings2,
  ShieldCheck,
  Layers,
  Type,
  Minus,
  Plus,
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
import { ACCENT_PALETTES, DEFAULT_ACCENT_PALETTE } from '../../../shared/accentPalettes'
import { DEFAULT_TEXT_SCALE, nearestTextScale, steppedTextScale } from '../../../shared/textScale'
import { applyAccentPalette } from '../constants/accentPalettes'
import { CommandLineToolSettings } from './CommandLineToolSettings'
import { ComputerUseAllowedApps } from './ComputerUseAllowedApps'
import { CredentialSettings } from './CredentialSettings'
import { McpServerSettings } from './McpServerSettings'
import { ProviderSettingsPanel } from './ProviderSettingsPanel'
import { BrowserNetworkSettings } from './BrowserNetworkSettings'
import { BrowserLibrarySettings } from './BrowserLibrarySettings'
import { AppUpdateSettings, AppVersionButton } from './AppUpdateControls'
import { VoiceSettings } from './VoiceSettings'
import { SettingsPageHeader, SettingsRow, SettingsSection, ToggleField } from './SettingsLayout'
import { useModalDialog } from '../hooks/useModalDialog'
import { settingsSectionContributions, type SettingsSectionId } from '../services/uiContributions'
import './SettingsModal.css'
import { Select } from './Select'
import { SearchField } from './SearchField'
import { globalRunSlots, MAX_GLOBAL_RUN_SLOTS } from '../../../shared/runSlots'
import { PERMISSION_MODE_LABELS } from '../../../shared/permissions'

export type { AccentPalette } from '../../../shared/accentPalettes'
export { applyAccentPalette } from '../constants/accentPalettes'
export type { ProviderSettings } from '../types/app.types'

export type SettingsSection = SettingsSectionId

interface SettingsModalProps {
  settings: ProviderSettings
  /** `openedWith` is what Settings showed when it opened, so the save can name only its changes. */
  onSave: (
    settings: ProviderSettings,
    openedWith: ProviderSettings
  ) => Promise<{ success: boolean; error?: string }>
  /** Saves a text size at once; the window resizes as soon as it is stored. */
  onTextScaleChange: (textScale: number) => void
  onClose: () => void
  initialSection?: SettingsSection
  /** Shows a provider's key field, when SideKick's agent asked the user for a key. */
  providerKeyRequest?: { id: string; at: number } | null
  /** Opens the credential editor, when SideKick's agent asked the user for a credential. */
  credentialRequest?: {
    value: import('../../../shared/credentials').CredentialRequest
    at: number
  } | null
}

const SETTINGS_ICONS = {
  server: Server,
  settings: Settings2,
  bot: Bot,
  palette: Palette,
  boxes: Boxes,
  key: KeyRound
}

const NAV_ITEMS = settingsSectionContributions.list().map(({ value }) => ({
  ...value,
  icon: SETTINGS_ICONS[value.icon]
}))

function SettingsModal({
  settings: initialSettings,
  onSave,
  onTextScaleChange,
  onClose,
  initialSection = 'providers',
  providerKeyRequest = null,
  credentialRequest = null
}: SettingsModalProps): React.JSX.Element {
  const [settings, setSettings] = useState<ProviderSettings>(initialSettings)
  const [openedWith] = useState<ProviderSettings>(initialSettings)
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)
  const [navigationQuery, setNavigationQuery] = useState('')
  // Set by the version button; the Updates card only exists once General renders.
  const [revealUpdates, setRevealUpdates] = useState(false)
  const [mcpValidationError, setMcpValidationError] = useState<string | null>(null)
  // Text size is saved as it changes, here or by the zoom shortcuts, so the draft follows it.
  useEffect(() => {
    setSettings((current) => ({ ...current, textScale: initialSettings.textScale }))
  }, [initialSettings.textScale])
  useEffect(() => {
    if (providerKeyRequest) setActiveSection('providers')
  }, [providerKeyRequest])
  useEffect(() => {
    if (credentialRequest) setActiveSection('credentials')
  }, [credentialRequest])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  // The title bar's theme and settings buttons stay usable beside Settings, so Tab reaches them.
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose, '.title-bar-actions')
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
      const prepared = (value: ProviderSettings): ProviderSettings =>
        syncLegacyProviderSettings({
          ...value,
          mcpServers: value.mcpServers ?? [],
          toolCallLimit: normalizeToolCallLimit(value.toolCallLimit),
          toolCallLimitVersion: TOOL_CALL_LIMIT_POLICY_VERSION
        })
      const result = await onSave(prepared(settings), prepared(openedWith))
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
          keyRequest={providerKeyRequest}
        />
      )
    }

    if (activeSection === 'general') {
      return (
        <div className="settings-page">
          <SettingsPageHeader
            title="General"
            description="Notifications, running in the background, voice, web search, and updates."
          />
          <SettingsSection
            icon={Bell}
            title="Notifications"
            description="Only while SideKick is in the background."
          >
            <ToggleField
              label="Completion notifications"
              hint="A desktop notification when a reply finishes."
              checked={settings.notificationsEnabled ?? true}
              onChange={(notificationsEnabled) =>
                setSettings({ ...settings, notificationsEnabled })
              }
            />
            <ToggleField
              label="Notification sound"
              hint="Play the system notification sound with it."
              checked={settings.notificationSoundEnabled ?? false}
              disabled={!(settings.notificationsEnabled ?? true)}
              onChange={(notificationSoundEnabled) =>
                setSettings({ ...settings, notificationSoundEnabled })
              }
            />
          </SettingsSection>
          {window.api.app.platform !== 'macos' && (
            <SettingsSection
              icon={AppWindow}
              title="Background"
              description="Let agents finish after you close the window."
            >
              <ToggleField
                label={
                  window.api.app.platform === 'windows'
                    ? 'Close to the notification area'
                    : 'Close to the system tray'
                }
                hint="Closing the window keeps SideKick running from its tray icon; quit from the icon's menu. Off, closing the window quits."
                checked={settings.closeToTray ?? true}
                onChange={(closeToTray) => setSettings({ ...settings, closeToTray })}
              />
            </SettingsSection>
          )}
          <VoiceSettings
            enabled={settings.voiceEnabled ?? true}
            onEnabledChange={(voiceEnabled) => setSettings({ ...settings, voiceEnabled })}
          />
          <SettingsSection
            icon={Globe}
            title="Web search"
            description="Searches public search engines, with no account or API key."
          >
            <ToggleField
              label="Let the agent search the web"
              hint="Uses DuckDuckGo, Brave Search, and Bing, and reads the pages it finds. Off, the agent can still open pages in the Browser tab."
              checked={settings.webSearchEnabled ?? true}
              onChange={(webSearchEnabled) => setSettings({ ...settings, webSearchEnabled })}
            />
          </SettingsSection>
          {window.api.app.platform === 'windows' && (
            <SettingsSection
              icon={MousePointerClick}
              title="Computer use"
              description="Lets the agent operate other apps on this computer. Each app needs your approval, for a chat or for good."
            >
              <ToggleField
                label="Let the agent ask to use apps"
                hint="Password managers, Windows security prompts and SideKick itself are never available. Press Esc to stop it. What an app shows goes to your selected model."
                checked={settings.computerUseEnabled ?? false}
                onChange={(computerUseEnabled) => setSettings({ ...settings, computerUseEnabled })}
              />
              <ComputerUseAllowedApps />
            </SettingsSection>
          )}
          <SettingsSection
            icon={MapPin}
            title="Location"
            description="Lets the agent answer local questions, such as the weather."
          >
            <SettingsRow
              label="City or region"
              description="Leave empty and the agent knows only your time zone."
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
            description="SideKick checks GitHub for new versions and installs one only when you choose."
          >
            <ToggleField
              label="Check automatically"
              hint="After startup and every six hours. Off, check from here with Check now."
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
            description="A troubleshooting report with no personal content."
          >
            <SettingsRow
              label="Diagnostic report"
              description="Leaves out conversations, prompts, files, paths, addresses, model names, logs, and keys."
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
            description="How the agent works on long tasks and what it may do without asking."
          />
          <SettingsSection
            icon={Workflow}
            title="Long tasks"
            description="How the agent keeps track of long work."
          >
            <ToggleField
              label="Task list"
              hint="Keep a visible checklist for work with several steps."
              checked={settings.focusChainEnabled ?? true}
              onChange={(focusChainEnabled) => setSettings({ ...settings, focusChainEnabled })}
            />
            <ToggleField
              label="Summarize older messages"
              hint="When a chat nears the model's limit, summarize its oldest part so the work can go on."
              checked={settings.autoCompactEnabled ?? true}
              onChange={(autoCompactEnabled) => setSettings({ ...settings, autoCompactEnabled })}
            />
            {settings.autoCompactEnabled !== false && (
              <SettingsRow
                label="Summarize at"
                description="How full the model's context gets first."
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
            description="Plan mode can write the plan with its own model; the chat model then does the work."
          >
            <SettingsRow
              label="Planning model"
              description="You can change it in the composer whenever Plan mode is on."
              controlId={`${controlId}-planning`}
              control={
                <Select
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
                </Select>
              }
            />
          </SettingsSection>
          <SettingsSection
            icon={ShieldCheck}
            title="Permissions"
            description="What the agent may do without asking you. It applies to commands, files, connectors, the browser, and stored credentials, and you can also change it beside the model in the composer."
          >
            <SettingsRow
              icon={Hand}
              label="Approvals"
              description="With full access the agent works without asking; destructive actions still follow SideKick's safety rules."
              controlId={`${controlId}-approval`}
              control={
                <Select
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
                  {Object.entries(PERMISSION_MODE_LABELS).map(([mode, label]) => (
                    <option key={mode} value={mode}>
                      {label}
                    </option>
                  ))}
                </Select>
              }
            />
            <SettingsRow
              icon={Repeat}
              label="Steps before checking in"
              description={`After this many steps in one reply, the agent pauses to ask whether to go on. Default ${DEFAULT_TOOL_CALL_LIMIT}.`}
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
              label="Where commands run"
              description="A Docker container sees only the project and has no network. It needs Docker running; other tools still run on this computer."
              controlId={`${controlId}-shell`}
              control={
                <Select
                  id={`${controlId}-shell`}
                  value={settings.shellIsolation ?? 'host'}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      shellIsolation: event.target.value as 'host' | 'docker'
                    })
                  }
                >
                  <option value="host">On this computer</option>
                  <option value="docker">In a Docker container</option>
                </Select>
              }
            />
            <SettingsRow
              icon={Layers}
              label="Chats working at once"
              description="Chats, scheduled runs, and helper agents that may run together; the rest wait their turn."
              controlId={`${controlId}-run-slots`}
              control={
                <input
                  id={`${controlId}-run-slots`}
                  type="number"
                  min={1}
                  max={MAX_GLOBAL_RUN_SLOTS}
                  value={globalRunSlots(settings)}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      maxConcurrentRuns: globalRunSlots({
                        maxConcurrentRuns: Number(event.target.value)
                      })
                    })
                  }
                />
              }
            />
            <SettingsRow
              icon={FileCode2}
              label="Python for checking Office files"
              description="Optional. After the agent makes a Word, Excel, or PowerPoint file, SideKick can open it with this Python to make sure it isn't broken. Pick a Python that already has lxml; SideKick installs nothing. Not used when commands run in Docker."
              stacked
              control={
                <span className="settings-inline-field">
                  <input
                    className="settings-path-input"
                    aria-label="Office Python interpreter"
                    readOnly
                    value={settings.officeHelperInterpreter ?? ''}
                    placeholder="Not set"
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
          </SettingsSection>
          <BrowserNetworkSettings />
          <BrowserLibrarySettings />
        </div>
      )
    }

    if (activeSection === 'appearance') {
      const textScale = nearestTextScale(settings.textScale)
      const chooseTextScale = (next: number): void => {
        setSettings({ ...settings, textScale: next })
        onTextScaleChange(next)
      }
      const activePalette = settings.accentPalette || DEFAULT_ACCENT_PALETTE
      return (
        <div className="settings-page">
          <SettingsPageHeader title="Appearance" description="Accent color and text size." />
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
            title="Text size"
            description="Sizes everything in the window together. The zoom shortcuts, Ctrl + and Ctrl −, step through the same sizes."
          >
            <SettingsRow
              label="Size"
              control={
                <div className="settings-stepper" role="group" aria-label="Text size">
                  <button
                    type="button"
                    aria-label="Smaller text"
                    disabled={steppedTextScale(textScale, 'out') === textScale}
                    onClick={() => chooseTextScale(steppedTextScale(textScale, 'out'))}
                  >
                    <Minus size={14} aria-hidden="true" />
                  </button>
                  <output aria-live="polite">{textScale}%</output>
                  <button
                    type="button"
                    aria-label="Larger text"
                    disabled={steppedTextScale(textScale, 'in') === textScale}
                    onClick={() => chooseTextScale(steppedTextScale(textScale, 'in'))}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                  {textScale !== DEFAULT_TEXT_SCALE && (
                    <button
                      type="button"
                      className="settings-stepper-reset"
                      onClick={() => chooseTextScale(DEFAULT_TEXT_SCALE)}
                    >
                      Reset
                    </button>
                  )}
                </div>
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
            description="Tools from other apps and services, and the sidekick command."
          />
          <McpServerSettings
            servers={settings.mcpServers || []}
            onChange={(mcpServers) => setSettings({ ...settings, mcpServers })}
            validationError={mcpValidationError}
          />
          <CommandLineToolSettings />
        </div>
      )
    }

    if (activeSection === 'credentials') {
      return (
        <div className="settings-page">
          <SettingsPageHeader
            title="Credentials"
            description="Sign-ins and keys the agent uses without ever seeing them."
          />
          <CredentialSettings request={credentialRequest} />
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
        {/* The title bar says Settings on screen; this names the dialog and heads its outline. */}
        <h1 id="settings-modal-title" className="settings-modal-title">
          Settings
        </h1>
        <aside className="settings-sidebar">
          <button type="button" className="settings-back-button" onClick={onClose}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back to app</span>
          </button>
          <SearchField
            className="settings-search"
            value={navigationQuery}
            onChange={setNavigationQuery}
            placeholder="Search settings"
            aria-label="Find settings sections"
          />
          {/* One group needs no heading: the title bar already says Settings. */}
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
                  {/* The sidebar tree's icon size, in its icon column. */}
                  <Icon size={14} aria-hidden="true" />
                  <strong>{item.label}</strong>
                </button>
              )
            })}
            {!visibleNavigationItems.length && (
              <div className="settings-search-empty">No matching section</div>
            )}
          </nav>
        </aside>
        <div className="settings-main">
          <main
            className="settings-content"
            aria-label={`${NAV_ITEMS.find((item) => item.id === activeSection)?.label} settings`}
            tabIndex={0}
          >
            {renderSection()}
          </main>
        </div>
        <footer className="settings-footer">
          <div className="settings-footer-version">
            <AppVersionButton
              onSelect={() => {
                setNavigationQuery('')
                setActiveSection('general')
                setRevealUpdates(true)
              }}
            />
          </div>
          <div className="settings-footer-page">
            <div className="settings-footer-inner">
              {saveError ? (
                <span className="settings-footer-status error" role="alert">
                  <CircleAlert size={14} aria-hidden="true" />
                  {saveError}
                </span>
              ) : (
                // Said only while there is something to save; the empty line keeps its place.
                <span
                  className={`settings-footer-status${unsaved ? ' dirty' : ''}`}
                  aria-live="polite"
                >
                  {unsaved ? 'Unsaved changes' : ''}
                </span>
              )}
              <button type="button" className="settings-ghost-action" onClick={onClose}>
                Cancel
              </button>
              {/* The view's one accent fill appears only when there is something to save. */}
              <button
                className={
                  unsaved || saving ? 'settings-primary-action' : 'settings-secondary-action'
                }
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default SettingsModal
