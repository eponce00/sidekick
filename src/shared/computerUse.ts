/** An app the user chose to always allow for computer use. */
export interface ComputerRememberedApp {
  path: string
  name: string
  /** The app's own icon, as a PNG data URL, when Windows has one. */
  iconDataUrl?: string
}

/** Whether the user's Chrome is set up for the agent, and with which profile. */
export interface ChromeUseStatus {
  connected: boolean
  installed: boolean
  /** Chrome's own icon, as a PNG data URL. */
  iconDataUrl?: string
  profile?: { name: string; pictureDataUrl?: string; color?: string }
}
