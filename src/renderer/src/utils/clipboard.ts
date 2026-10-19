/**
 * Copies text through SideKick's main process. The window refuses web permissions, the browser's
 * clipboard write among them, so `navigator.clipboard.writeText` always fails there.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    return (await window.api.clipboard.writeText(text))?.success === true
  } catch {
    return false
  }
}
