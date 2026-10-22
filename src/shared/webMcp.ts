/** A tool the page in a browser tab offers the agent through WebMCP, as the Browser panel shows it. */
export interface BrowserPageTool {
  name: string
  /** The site's own description, cut to a few lines. */
  description: string
  /** The site's claim that the tool changes nothing. */
  readOnly: boolean
  /** A declarative `<form toolname>` rather than a script's tool. */
  form: boolean
}

/** The site an origin names, as people read it: its host, or the origin itself. */
export function webMcpSite(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin || 'the page'
  }
}
