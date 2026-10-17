/**
 * Menus the main process asks the window to draw in SideKick's own style. The main process decides
 * what a menu holds and performs each choice; the window only reports which item was chosen.
 */
export interface AppMenuItem {
  /** Identifies the item when it is chosen. Separators have one too, unused. */
  id: string
  type: 'normal' | 'separator' | 'checkbox' | 'submenu' | 'heading'
  label?: string
  /** An icon as a data URL, such as an app's own icon. */
  icon?: string
  /** A shortcut shown beside the label; the menu itself does not bind it. */
  shortcut?: string
  checked?: boolean
  enabled?: boolean
  submenu?: AppMenuItem[]
}

export interface AppMenuRequest {
  /** One-time token for this menu; choosing an item or closing the menu ends it. */
  token: string
  items: AppMenuItem[]
  /** Where to open, in the window's CSS pixels. */
  x: number
  y: number
}

export interface AppMenusAPI {
  onShow: (callback: (request: AppMenuRequest) => void) => () => void
  /** Performs the chosen item in the main process. */
  choose: (token: string, itemId: string) => Promise<void>
  /** The menu closed without a choice. */
  dismiss: (token: string) => Promise<void>
}
