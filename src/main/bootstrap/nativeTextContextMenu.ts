import {
  clipboard,
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions
} from 'electron'

export interface NativeTextMenuActions {
  openLink?: (url: string) => void
  copyImage?: (x: number, y: number) => void
  lookUpSelection?: () => void
}

function selectionLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  const preview = normalized.length > 36 ? `${normalized.slice(0, 35)}…` : normalized
  return `Look Up “${preview}”`
}

function trimSeparators(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const compact = template.filter(
    (item, index, items) =>
      item.type !== 'separator' ||
      (index > 0 && index < items.length - 1 && items[index - 1].type !== 'separator')
  )
  while (compact.at(-1)?.type === 'separator') compact.pop()
  return compact
}

export function nativeTextMenuTemplate(
  params: ContextMenuParams,
  replaceMisspelling: (replacement: string) => void,
  addWordToDictionary: (word: string) => void,
  platform: NodeJS.Platform = process.platform,
  actions: NativeTextMenuActions = {}
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  const isSensitiveInput = params.formControlType === 'input-password'

  if (params.linkURL) {
    if (actions.openLink) {
      template.push({
        label: 'Open Link in Browser',
        click: () => actions.openLink?.(params.linkURL)
      })
    }
    template.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) })
    template.push({ type: 'separator' })
  }

  if (params.hasImageContents && actions.copyImage) {
    template.push({ label: 'Copy Image', click: () => actions.copyImage?.(params.x, params.y) })
    if (params.srcURL) {
      template.push({
        label: 'Copy Image Address',
        click: () => clipboard.writeText(params.srcURL)
      })
    }
    template.push({ type: 'separator' })
  }

  if (params.isEditable && params.misspelledWord && !isSensitiveInput) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
      template.push({ label: suggestion, click: () => replaceMisspelling(suggestion) })
    }
    if (!params.dictionarySuggestions.length) {
      template.push({ label: 'No spelling suggestions', enabled: false })
    }
    template.push({
      label: platform === 'darwin' ? 'Learn Spelling' : 'Add to Dictionary',
      click: () => addWordToDictionary(params.misspelledWord)
    })
    template.push({ type: 'separator' })
  }

  if (params.isEditable) {
    template.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
      { role: 'delete', enabled: params.editFlags.canDelete },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )
    if (platform === 'darwin' && !isSensitiveInput) {
      template.push(
        { type: 'separator' },
        {
          label: 'Spelling',
          submenu: [{ role: 'toggleSpellChecker' }]
        },
        {
          label: 'Substitutions',
          submenu: [
            { role: 'toggleSmartQuotes' },
            { role: 'toggleSmartDashes' },
            { role: 'toggleTextReplacement' }
          ]
        },
        ...(params.selectionText && actions.lookUpSelection
          ? [
              { type: 'separator' as const },
              {
                label: selectionLabel(params.selectionText),
                click: actions.lookUpSelection
              },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }]
              }
            ]
          : []),
        { role: 'services' }
      )
    }
  } else if (params.selectionText) {
    template.push(
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )
    if (platform === 'darwin') {
      if (actions.lookUpSelection) {
        template.push(
          { type: 'separator' },
          {
            label: selectionLabel(params.selectionText),
            click: actions.lookUpSelection
          }
        )
      }
      template.push(
        {
          label: 'Speech',
          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
        },
        { role: 'services' }
      )
    }
  }

  return trimSeparators(template)
}

export function installNativeTextContextMenu(
  window: BrowserWindow,
  actions: Pick<NativeTextMenuActions, 'openLink'> = {}
): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (
      !params.isEditable &&
      !params.selectionText &&
      !params.linkURL &&
      !params.hasImageContents
    ) {
      return
    }
    const template = nativeTextMenuTemplate(
      params,
      (replacement) => window.webContents.replaceMisspelling(replacement),
      (word) => window.webContents.session.addWordToSpellCheckerDictionary(word),
      process.platform,
      {
        ...actions,
        copyImage: (x, y) => window.webContents.copyImageAt(x, y),
        lookUpSelection:
          process.platform === 'darwin'
            ? () => window.webContents.showDefinitionForSelection()
            : undefined
      }
    )
    if (!template.length) return
    Menu.buildFromTemplate(template).popup({ window, frame: params.frame ?? undefined })
  })
}
