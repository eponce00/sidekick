/** More than this many matches are not worth stepping through one by one. */
const MAX_MATCHES = 500

/** Every place the words show in the chat's text, ignoring case. */
export function findRanges(root: Node, query: string): Range[] {
  const wanted = query.trim().toLocaleLowerCase()
  if (!wanted) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (
    let node = walker.nextNode();
    node && ranges.length < MAX_MATCHES;
    node = walker.nextNode()
  ) {
    const text = (node.textContent ?? '').toLocaleLowerCase()
    for (let at = text.indexOf(wanted); at >= 0 && ranges.length < MAX_MATCHES; ) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + wanted.length)
      ranges.push(range)
      at = text.indexOf(wanted, at + wanted.length)
    }
  }
  return ranges
}
