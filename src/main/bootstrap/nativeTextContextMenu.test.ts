import type { ContextMenuParams } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { nativeTextMenuTemplate } from './nativeTextContextMenu'

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 0,
    y: 0,
    linkURL: '',
    linkText: '',
    pageURL: '',
    frameURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: true,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: '',
    formControlType: 'input-text',
    spellcheckEnabled: true,
    menuSourceType: 'mouse',
    mediaFlags: {},
    editFlags: {
      canUndo: true,
      canRedo: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: false
    },
    ...overrides
  } as ContextMenuParams
}

describe('nativeTextMenuTemplate', () => {
  it('provides native editing, spelling, and substitution actions on macOS', () => {
    const replace = vi.fn()
    const add = vi.fn()
    const template = nativeTextMenuTemplate(
      params({ misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help'] }),
      replace,
      add,
      'darwin'
    )

    expect(template.map(({ label, role }) => label || role)).toEqual(
      expect.arrayContaining([
        'hello',
        'Learn Spelling',
        'cut',
        'copy',
        'paste',
        'selectAll',
        'Spelling',
        'Substitutions',
        'services'
      ])
    )
    ;(template.find(({ label }) => label === 'hello')?.click as () => void)()
    ;(template.find(({ label }) => label === 'Learn Spelling')?.click as () => void)()
    expect(replace).toHaveBeenCalledWith('hello')
    expect(add).toHaveBeenCalledWith('helo')
  })

  it('keeps selected non-editable text copyable without showing mutation actions', () => {
    const template = nativeTextMenuTemplate(
      params({ isEditable: false, selectionText: 'selected text' }),
      vi.fn(),
      vi.fn(),
      'win32'
    )

    expect(template.map(({ role }) => role)).toEqual(['copy', 'selectAll'])
  })

  it('does not expose spelling or system services for password fields', () => {
    const template = nativeTextMenuTemplate(
      params({
        formControlType: 'input-password',
        misspelledWord: 'secret',
        dictionarySuggestions: ['secrets'],
        selectionText: 'secret'
      }),
      vi.fn(),
      vi.fn(),
      'darwin',
      { lookUpSelection: vi.fn() }
    )

    expect(template.map(({ label, role }) => label || role)).not.toEqual(
      expect.arrayContaining(['secrets', 'Learn Spelling', 'Spelling', 'services'])
    )
    expect(template.map(({ role }) => role)).toEqual(
      expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll'])
    )
  })

  it('adds relevant link, image, lookup, speech, and services actions', () => {
    const openLink = vi.fn()
    const copyImage = vi.fn()
    const lookUpSelection = vi.fn()
    const template = nativeTextMenuTemplate(
      params({
        isEditable: false,
        selectionText: 'SideKick desktop experience',
        linkURL: 'https://example.com/docs',
        srcURL: 'https://example.com/image.png',
        hasImageContents: true,
        mediaType: 'image'
      }),
      vi.fn(),
      vi.fn(),
      'darwin',
      { openLink, copyImage, lookUpSelection }
    )

    expect(template.map(({ label, role }) => label || role)).toEqual(
      expect.arrayContaining([
        'Open Link in Browser',
        'Copy Link',
        'Copy Image',
        'Copy Image Address',
        'Look Up “SideKick desktop experience”',
        'Speech',
        'services'
      ])
    )
    ;(template.find(({ label }) => label === 'Open Link in Browser')?.click as () => void)()
    ;(template.find(({ label }) => label === 'Copy Image')?.click as () => void)()
    ;(
      template.find(({ label }) => label === 'Look Up “SideKick desktop experience”')
        ?.click as () => void
    )()
    expect(openLink).toHaveBeenCalledWith('https://example.com/docs')
    expect(copyImage).toHaveBeenCalledWith(0, 0)
    expect(lookUpSelection).toHaveBeenCalledOnce()
  })
})
