/**
 * Chromium's side effect check only trusts the built-ins it has marked, and ordinary reads such as
 * `closest`, `getElementById` and `new URL` aren't. In an isolated world they can be written with reads
 * it does trust. The page can't see these, and a script using them is still under the same check, so
 * anything that really changes something is still stopped.
 */
export const LOOK_HELPERS_SCRIPT = String.raw`(() => {
  const rootOf = (node) => {
    while (node.parentNode) node = node.parentNode
    return node
  }
  Node.prototype.getRootNode = function () {
    return rootOf(this)
  }
  Element.prototype.matches = function (selector) {
    return [...rootOf(this).querySelectorAll(selector)].includes(this)
  }
  Element.prototype.closest = function (selector) {
    const all = [...rootOf(this).querySelectorAll(selector)]
    for (let node = this; node && node.nodeType === 1; node = node.parentNode) {
      if (all.includes(node)) return node
    }
    return null
  }
  Element.prototype.getClientRects = function () {
    const box = this.getBoundingClientRect()
    return box.width || box.height ? [box] : []
  }
  Element.prototype.checkVisibility = function () {
    return this.isConnected && getComputedStyle(this).display !== 'none' && this.getClientRects().length > 0
  }
  const byId = function (id) {
    return this.querySelector('[id="' + String(id).replace(/["\\]/g, '\\$&') + '"]')
  }
  Document.prototype.getElementById = byId
  DocumentFragment.prototype.getElementById = byId
  CSSStyleDeclaration.prototype.getPropertyValue = function (name) {
    return this[name] ?? ''
  }
  Document.prototype.createTreeWalker = function (root, show = 0xffffffff, filter) {
    const nodes = []
    const accepts = (node) =>
      !filter ? 1 : typeof filter === 'function' ? filter(node) : filter.acceptNode(node)
    const visit = (parent) => {
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        const verdict = show & (1 << (node.nodeType - 1)) ? accepts(node) : 3
        if (verdict === 1) nodes.push(node)
        if (verdict !== 2) visit(node)
      }
    }
    visit(root)
    let at = -1
    return {
      root,
      currentNode: root,
      nextNode() {
        if (at + 1 >= nodes.length) return null
        return (this.currentNode = nodes[++at])
      },
      previousNode() {
        if (at <= 0) return null
        return (this.currentNode = nodes[--at])
      }
    }
  }
  String.prototype.matchAll = function (pattern) {
    const text = String(this)
    const found = []
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      found.push(match)
      if (!match[0]) pattern.lastIndex++
    }
    return found[Symbol.iterator]()
  }
  Object.fromEntries = (entries) => {
    const made = {}
    for (const [key, value] of entries) made[key] = value
    return made
  }
  Object.assign = (target, ...sources) => {
    for (const source of sources) {
      for (const key of Object.keys(source ?? {})) target[key] = source[key]
    }
    return target
  }
  structuredClone = (value) => JSON.parse(JSON.stringify(value))
  CSS.escape = (value) =>
    String(value)
      .replace(/[^\w-]/g, (mark) => '\\' + mark)
      .replace(/^\d/, (digit) => '\\3' + digit + ' ')
  URLSearchParams = class {
    constructor(query = '') {
      this.pairs = String(query)
        .replace(/^\?/, '')
        .split('&')
        .filter(Boolean)
        .map((pair) => {
          const [key, ...value] = pair.split('=')
          const plain = (words) => decodeURIComponent(words.replace(/\+/g, ' '))
          return [plain(key), plain(value.join('='))]
        })
    }
    get(key) {
      return this.pairs.find((pair) => pair[0] === key)?.[1] ?? null
    }
    getAll(key) {
      return this.pairs.filter((pair) => pair[0] === key).map((pair) => pair[1])
    }
    has(key) {
      return this.pairs.some((pair) => pair[0] === key)
    }
    get size() {
      return this.pairs.length
    }
    keys() {
      return this.pairs.map((pair) => pair[0])[Symbol.iterator]()
    }
    values() {
      return this.pairs.map((pair) => pair[1])[Symbol.iterator]()
    }
    entries() {
      return this.pairs[Symbol.iterator]()
    }
    [Symbol.iterator]() {
      return this.pairs[Symbol.iterator]()
    }
    forEach(each) {
      this.pairs.forEach((pair) => each(pair[1], pair[0], this))
    }
    toString() {
      return this.pairs.map((pair) => pair.map(encodeURIComponent).join('=')).join('&')
    }
  }
  const NativeURL = URL
  URL = class {
    constructor(address, base) {
      let text = String(address).trim()
      if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
        if (base === undefined) throw new TypeError('Invalid URL: ' + text)
        const from = new URL(base)
        if (text.startsWith('//')) text = from.protocol + text
        else if (text.startsWith('/')) text = from.origin + text
        else if (text.startsWith('?')) text = from.origin + from.pathname + text
        else if (text.startsWith('#')) text = from.origin + from.pathname + from.search + text
        else text = from.origin + from.pathname.replace(/[^/]*$/, '') + text
      }
      const parts =
        /^([a-z][a-z0-9+.-]*:)(?:\/\/(?:[^/?#@]*@)?([^/?#:]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(text)
      if (!parts) throw new TypeError('Invalid URL: ' + text)
      this.protocol = parts[1].toLowerCase()
      this.hostname = (parts[2] ?? '').toLowerCase()
      this.port = parts[3] ?? ''
      const steps = []
      for (const step of (parts[4] ?? '').split('/')) {
        if (step === '..') steps.length > 1 && steps.pop()
        else if (step !== '.') steps.push(step)
      }
      this.pathname = steps.join('/') || (this.hostname ? '/' : '')
      this.search = parts[5] && parts[5] !== '?' ? parts[5] : ''
      this.hash = parts[6] && parts[6] !== '#' ? parts[6] : ''
    }
    get host() {
      return this.hostname + (this.port ? ':' + this.port : '')
    }
    get origin() {
      return this.protocol + '//' + this.host
    }
    get href() {
      return this.origin + this.pathname + this.search + this.hash
    }
    get searchParams() {
      return new URLSearchParams(this.search)
    }
    toString() {
      return this.href
    }
    toJSON() {
      return this.href
    }
    static canParse(address, base) {
      try {
        new URL(address, base)
        return true
      } catch {
        return false
      }
    }
    static [Symbol.hasInstance](value) {
      return value?.constructor === URL || value instanceof NativeURL
    }
  }
})()`
