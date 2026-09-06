/** Self-contained: serialized into the target node's renderer execution context. */
export function browserTextTargetOwnsFocus(target: HTMLElement): boolean {
  let root = target.getRootNode() as Document | ShadowRoot
  const active = root.activeElement
  if (
    active !== target &&
    !(target.isContentEditable === true && active && target.contains(active))
  )
    return false
  // Verify every host, including closed/nested roots reached from the known node.
  while ('host' in root) {
    const host = root.host
    root = host.getRootNode() as Document | ShadowRoot
    if (root.activeElement !== host) return false
  }
  return true
}
