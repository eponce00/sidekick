/** Where the address bar searches what is not a page. */
export const BROWSER_SEARCH_URL = 'https://duckduckgo.com/?q='

// Schemes the address bar opens as typed.
const OPEN_AS_TYPED = /^(?:https?|file|about|data|view-source):/i
// This computer or a network address, which a browser opens over plain HTTP: localhost:5173,
// 192.168.1.20:8080, [::1]:3000.
const LOCAL_HOST = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])(?::\d{1,5})?(?:[/?#].*)?$/i
// A host name with a dot and a top-level domain of letters, as example.com or docs.github.io/x.
const WEB_HOST = /^[^\s/?#:@]+\.[a-z]{2,63}\.?(?::\d{1,5})?(?:[/?#].*)?$/i

/**
 * What the address bar opens for what the user typed: an address as given, a host name as a web
 * page, and anything else, such as a few words, as a search.
 */
export function browserAddress(typed: string): string {
  const text = typed.trim()
  if (!text) return ''
  if (OPEN_AS_TYPED.test(text)) return text
  if (/\s/.test(text)) return `${BROWSER_SEARCH_URL}${encodeURIComponent(text)}`
  if (LOCAL_HOST.test(text)) return `http://${text}`
  if (WEB_HOST.test(text)) return `https://${text}`
  return `${BROWSER_SEARCH_URL}${encodeURIComponent(text)}`
}
