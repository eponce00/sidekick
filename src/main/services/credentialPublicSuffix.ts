import { getDomain } from 'tldts'
import type { CredentialScope } from '../../shared/credentials'

/**
 * A wildcard over a public suffix, such as `*.co.uk` or `*.github.io`, covers sites anyone can
 * register. The shared check cannot carry the suffix list into the renderer, so the main process
 * refuses these when an entry is saved.
 */
export function publicSuffixWildcardRefusal(scope: CredentialScope): string | null {
  const web = scope.web
  if (!web) return null
  for (const pattern of [...web.hosts, ...web.tokenHosts]) {
    if (!pattern.startsWith('*.')) continue
    const host = pattern.slice(2).replace(/:\d+$/, '')
    if (!getDomain(host, { allowPrivateDomains: true })) {
      return `${pattern} would cover sites anyone can register under ${host}. Name your own domain, such as *.example.${host}.`
    }
  }
  return null
}
