import { describe, expect, it } from 'vitest'
import {
  EDITABLE_SETTINGS,
  isKnownStoredSettingKey,
  renderSettingsReference,
  validateSettingValue
} from './settingsSchema'

describe('editable settings schema', () => {
  it('has unique keys whose defaults pass their own validation', () => {
    expect(new Set(EDITABLE_SETTINGS.map((setting) => setting.key)).size).toBe(
      EDITABLE_SETTINGS.length
    )
    for (const setting of EDITABLE_SETTINGS) {
      expect(validateSettingValue(setting, setting.default, [])).toEqual({
        ok: true,
        value: setting.default
      })
      expect(isKnownStoredSettingKey(setting.key)).toBe(true)
    }
  })

  it('never offers a credential or an executable path', () => {
    for (const setting of EDITABLE_SETTINGS) {
      expect(setting.key).not.toMatch(/key|secret|token|password|interpreter|hook|instance|mcp/i)
    }
  })

  it('treats inherited object properties as unknown stored keys', () => {
    expect(isKnownStoredSettingKey('constructor')).toBe(false)
    expect(isKnownStoredSettingKey('__proto__')).toBe(false)
    expect(isKnownStoredSettingKey('__encryptedProviderSecrets')).toBe(true)
  })

  it('renders a reference that lists every setting', () => {
    const reference = renderSettingsReference()
    for (const setting of EDITABLE_SETTINGS) expect(reference).toContain(`\`${setting.key}\``)
  })
})
