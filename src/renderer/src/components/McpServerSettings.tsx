import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import {
  createCatalogMcpConfig,
  MCP_CONNECTOR_CATALOG
} from '../../../shared/connectorCatalog'
import { validateMcpServerConfig } from '../../../shared/mcp'
import type { McpServerConfig, McpServerStatus } from '../../../shared/types'
import './McpServerSettings.css'

interface McpServerSettingsProps {
  servers: McpServerConfig[]
  onChange: (servers: McpServerConfig[]) => void
}

function newServer(index: number): McpServerConfig {
  return {
    id: `server-${index + 1}`,
    name: `MCP Server ${index + 1}`,
    transport: 'stdio',
    command: '',
    args: [],
    approvalMode: 'prompt',
    enabled: false
  }
}

export function McpServerSettings({
  servers,
  onChange
}: McpServerSettingsProps): React.JSX.Element {
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [checking, setChecking] = useState(false)
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const refreshStatuses = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const result = await window.api.mcp.listTools()
      setStatuses(result.statuses)
    } finally {
      setChecking(false)
    }
  }, [])

  const runAuthAction = async (serverId: string, action: 'connect' | 'disconnect'): Promise<void> => {
    setActingOn(serverId)
    setActionError(null)
    try {
      const result =
        action === 'connect'
          ? await window.api.mcp.authenticate(serverId)
          : await window.api.mcp.disconnect(serverId)
      setStatuses(result.statuses)
      if (!result.ok) setActionError(result.error ?? `Could not ${action} this connector.`)
    } finally {
      setActingOn(null)
    }
  }

  useEffect(() => {
    void refreshStatuses()
  }, [refreshStatuses])

  const update = (
    index: number,
    updater: (server: McpServerConfig) => McpServerConfig
  ): void => {
    onChange(
      servers.map((server, itemIndex) => (itemIndex === index ? updater(server) : server))
    )
  }

  return (
    <div className="mcp-server-settings">
      <div className="mcp-catalog">
        <span className="mcp-catalog-label">Quick add</span>
        <div className="mcp-catalog-options">
          {MCP_CONNECTOR_CATALOG.map((connector) => (
            <button
              type="button"
              key={connector.id}
              onClick={() => onChange([...servers, createCatalogMcpConfig(connector.id, servers)])}
            >
              <Plus size={12} /> {connector.name}
            </button>
          ))}
        </div>
      </div>
      {servers.length === 0 && (
        <div className="mcp-empty">
          No MCP servers configured. SideKick works normally without them.
        </div>
      )}
      {servers.map((server, index) => {
        const validId = /^[a-zA-Z0-9_-]+$/.test(server.id)
        const validationError = server.enabled === false ? null : validateMcpServerConfig(server)
        const status = statuses.find((item) => item.serverId === server.id)
        const oauth = server.transport === 'streamable-http' && server.authentication === 'oauth'
        return (
          <div className="mcp-server-card" key={`${server.id}-${index}`}>
            <div className="mcp-server-header">
              <label className="mcp-enabled">
                <input
                  type="checkbox"
                  checked={server.enabled !== false}
                  onChange={(event) =>
                    update(index, (current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                Enabled
              </label>
              {server.transport === 'streamable-http' && server.catalogId && (
                <span className="mcp-official-badge">Official</span>
              )}
              {status && (
                <span className={`mcp-status mcp-status-${status.status}`} title={status.error}>
                  {status.status === 'connected'
                    ? `Connected · ${status.toolCount} tools`
                    : status.status === 'needs_auth'
                      ? 'Sign-in required'
                      : status.status === 'disabled'
                        ? 'Disabled'
                        : 'Connection error'}
                </span>
              )}
              {oauth && status?.status === 'needs_auth' && server.enabled && (
                <button
                  type="button"
                  className="mcp-auth-action"
                  disabled={actingOn === server.id}
                  onClick={() => void runAuthAction(server.id, 'connect')}
                >
                  {actingOn === server.id ? 'Opening…' : 'Connect'}
                </button>
              )}
              {oauth && status?.status === 'connected' && (
                <button
                  type="button"
                  className="mcp-auth-action"
                  disabled={actingOn === server.id}
                  onClick={() => void runAuthAction(server.id, 'disconnect')}
                >
                  Disconnect
                </button>
              )}
              <button
                type="button"
                className="mcp-remove"
                onClick={() => onChange(servers.filter((_, itemIndex) => itemIndex !== index))}
                aria-label={`Remove ${server.name}`}
                title="Remove server"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mcp-server-grid">
              <label>
                Display name
                <input
                  value={server.name}
                  onChange={(event) =>
                    update(index, (current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Filesystem tools"
                />
              </label>
              <label>
                Server ID
                <input
                  value={server.id}
                  className={validId ? '' : 'input-error'}
                  onChange={(event) =>
                    update(index, (current) => ({ ...current, id: event.target.value }))
                  }
                  placeholder="filesystem"
                />
              </label>
              <label>
                Connection
                <select
                  value={server.transport}
                  onChange={(event) => {
                    const nextTransport = event.target.value
                    update(index, (current) => {
                      const base = {
                        id: current.id,
                        name: current.name,
                        approvalMode: current.approvalMode,
                        enabled: current.enabled
                      }
                      return nextTransport === 'streamable-http'
                        ? {
                            ...base,
                            transport: 'streamable-http',
                            url: '',
                            authentication: 'oauth'
                          }
                        : { ...base, transport: 'stdio', command: '', args: [] }
                    })
                  }}
                >
                  <option value="stdio">Local process</option>
                  <option value="streamable-http">Remote HTTPS</option>
                </select>
              </label>
              <label>
                Approval
                <select
                  value={server.approvalMode}
                  onChange={(event) =>
                    update(index, (current) => ({
                      ...current,
                      approvalMode: event.target.value as McpServerConfig['approvalMode']
                    }))
                  }
                >
                  <option value="prompt">Always ask</option>
                  <option value="reads-auto">Auto-approve safe reads</option>
                </select>
              </label>
              {server.transport === 'stdio' ? (
                <>
                  <label className="mcp-wide">
                    Command
                    <input
                      value={server.command ?? ''}
                      onChange={(event) =>
                        update(index, (current) =>
                          current.transport === 'stdio'
                            ? { ...current, command: event.target.value }
                            : current
                        )
                      }
                      placeholder="npx"
                    />
                  </label>
                  <label className="mcp-wide">
                    Arguments (one per line)
                    <textarea
                      rows={3}
                      value={(server.args ?? []).join('\n')}
                      onChange={(event) =>
                        update(index, (current) =>
                          current.transport === 'stdio'
                            ? {
                                ...current,
                                args: event.target.value
                                  .split('\n')
                                  .filter((arg) => arg.length > 0)
                              }
                            : current
                        )
                      }
                      placeholder={'-y\nsome-mcp-server'}
                    />
                  </label>
                  <label className="mcp-wide">
                    Working directory (optional)
                    <input
                      value={server.cwd ?? ''}
                      onChange={(event) =>
                        update(index, (current) =>
                          current.transport === 'stdio'
                            ? { ...current, cwd: event.target.value || undefined }
                            : current
                        )
                      }
                      placeholder="/path/to/server"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="mcp-wide">
                    MCP endpoint
                    <input
                      value={server.url}
                      disabled={Boolean(server.catalogId)}
                      onChange={(event) =>
                        update(index, (current) =>
                          current.transport === 'streamable-http'
                            ? { ...current, url: event.target.value }
                            : current
                        )
                      }
                      placeholder="https://connect.example.com/mcp"
                    />
                  </label>
                  <label className="mcp-wide">
                    Authentication
                    <select
                      value={server.authentication}
                      disabled={Boolean(server.catalogId)}
                      onChange={(event) =>
                        update(index, (current) =>
                          current.transport === 'streamable-http'
                            ? {
                                ...current,
                                authentication: event.target.value as 'none' | 'oauth'
                              }
                            : current
                        )
                      }
                    >
                      <option value="oauth">OAuth sign-in</option>
                      <option value="none">No authentication</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            {validationError && <span className="field-error">{validationError}</span>}
          </div>
        )
      })}
      <div className="mcp-actions">
        <button
          type="button"
          className="settings-primary-action"
          onClick={() => onChange([...servers, newServer(servers.length)])}
        >
          <Plus size={14} /> Custom connector
        </button>
        <button
          type="button"
          className="settings-secondary-action"
          onClick={() => void refreshStatuses()}
          disabled={checking}
        >
          <RefreshCw size={14} className={checking ? 'icon-spin' : ''} /> Check saved servers
        </button>
      </div>
      {actionError && <span className="field-error">{actionError}</span>}
      <span className="field-hint">
        Remote connectors require HTTPS except on this Mac. Authentication is detected safely; OAuth
        sign-in will use the encrypted connector vault.
      </span>
    </div>
  )
}
