import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import type { LookupFunction } from 'node:net'
import {
  browserNetworkOrigin,
  loopbackHost,
  networkAddressKind,
  privateNetworkHost,
  type NetworkAddressKind
} from '../../shared/browserNetwork'
import type { BrowserNetworkPolicy } from './browserNetworkApprovals'

/**
 * SideKick's own requests for addresses the agent names follow the browser's rules for the local
 * network, so neither can reach what the other may not, and both answer to one approval:
 *
 * - a plain-HTTP local-network origin needs the user's approval;
 * - an HTTPS local-network origin opens as in the browser, its certificate vouching for it;
 * - this computer is never fetched (the browser, which the user can watch, opens it instead);
 * - nothing on the internet leads into the local network, by a redirect or by a public name
 *   that resolves there.
 *
 * Addresses are checked when a connection resolves its name, so the address checked is the
 * address connected to: a name that resolves, or rebinds, to a private address is caught too.
 */

/** A request the network policy refused. Retrying, or rendering the page, would not help. */
export class WebNetworkRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebNetworkRefusal'
  }
}

/** The refusal behind an error, including one raised while a connection resolved its name. */
export function webNetworkRefusal(error: unknown): WebNetworkRefusal | undefined {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (current instanceof WebNetworkRefusal) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** Where a response came from, as far as the next redirect is concerned. */
export type WebReach = Exclude<NetworkAddressKind, 'loopback'>

export interface WebNetworkOptions {
  /** Approvals shared with the browser. Without them, plain HTTP to the local network is refused. */
  policy?: BrowserNetworkPolicy
  /** Withdraws an approval question, and the request, when the call waiting on them stops. */
  signal?: AbortSignal
  /** False refuses the local network altogether, for addresses nobody chose, such as images. */
  localNetwork?: boolean
  /** Resolves a name to all of its addresses. Tests replace it. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>
  /** Classifies an address. Tests replace it to stand a local server in for a public one. */
  addressKind?: (address: string) => NetworkAddressKind | undefined
}

export interface WebAdmission {
  /** Whether this request's connection may reach a local-network address. */
  allowLocal: boolean
  /** Known before any lookup when the host is written as an address. */
  reach?: WebReach
}

const MAX_REDIRECTS = 5

/** Named for every web tool: http_request reported it as web_fetch, and said to stop. */
function onThisComputer(origin: string): string {
  return (
    `${origin} is on this computer, which SideKick's web tools do not reach. To check a server ` +
    'you started, request it from the shell (curl.exe on Windows), or open it in the browser.'
  )
}

function intoLocalNetwork(target: string): string {
  return (
    `A page on the internet led to ${target}, on the local network. SideKick does not follow ` +
    `the internet into the local network; fetch the device by its local address to ask the user.`
  )
}

/**
 * Decides whether a request may go to `url` before anything is sent, asking the user about a
 * plain-HTTP local-network origin. `from` is where the previous response of a redirect chain came
 * from: a redirect never asks, and never leads from the internet into the local network.
 */
export async function admitWebUrl(
  url: URL,
  options: WebNetworkOptions & { from?: WebReach } = {}
): Promise<WebAdmission> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebNetworkRefusal('Only HTTP and HTTPS pages can be read')
  }
  if (url.username || url.password) {
    throw new WebNetworkRefusal('Page addresses cannot carry a user name or password')
  }
  const origin = browserNetworkOrigin(url)
  if (loopbackHost(url.hostname)) throw new WebNetworkRefusal(onThisComputer(origin))
  const literal = networkAddressKind(url.hostname)
  if (!privateNetworkHost(url.hostname)) {
    // A name on the internet stays there: what it resolves to is checked when it connects.
    return { allowLocal: false, ...(literal === 'public' ? { reach: 'public' } : {}) }
  }
  if (options.from === 'public') throw new WebNetworkRefusal(intoLocalNetwork(origin))
  if (options.localNetwork === false) {
    throw new WebNetworkRefusal(
      `${origin} is on the local network, which this request may not reach`
    )
  }
  const local: WebAdmission = { allowLocal: true, ...(literal ? { reach: 'local' } : {}) }
  if (url.protocol === 'https:' || options.policy?.approved(origin)) return local
  if (options.from) {
    throw new WebNetworkRefusal(
      `A redirect led to ${origin}, which the user has not allowed. Fetch it directly to ask them.`
    )
  }
  if (!options.policy) {
    throw new WebNetworkRefusal(`${origin} is on the local network and has not been allowed`)
  }
  if (await options.policy.approve(origin, options.signal)) return local
  throw new WebNetworkRefusal(
    `The user did not allow SideKick to open ${origin}. Ask them before trying it again.`
  )
}

const resolveAll = (hostname: string): Promise<LookupAddress[]> => lookup(hostname, { all: true })

/**
 * Resolves a name and refuses it when any of its addresses is one the request may not reach:
 * a connection may use any of them. Returns them with where they lead.
 */
export async function resolveAdmitted(
  hostname: string,
  admission: Pick<WebAdmission, 'allowLocal'>,
  options: Pick<WebNetworkOptions, 'resolve' | 'addressKind'> = {}
): Promise<{ addresses: LookupAddress[]; reach: WebReach }> {
  const addresses = await (options.resolve ?? resolveAll)(hostname)
  if (!addresses.length) throw new Error(`${hostname} has no address`)
  const kindOf = options.addressKind ?? networkAddressKind
  let local = 0
  for (const { address } of addresses) {
    const kind = kindOf(address) ?? 'loopback'
    if (kind === 'loopback') {
      throw new WebNetworkRefusal(
        `${hostname} resolves to ${address}, on this computer, which SideKick's web tools do not reach`
      )
    }
    if (kind === 'local') {
      if (!admission.allowLocal) {
        throw new WebNetworkRefusal(
          `${hostname} resolves to ${address}, on the local network, and SideKick does not let ` +
            `a name on the internet lead into the local network. Fetch the device by its local ` +
            `address to ask the user.`
        )
      }
      local++
    }
  }
  return { addresses, reach: local === addresses.length ? 'local' : 'public' }
}

/** A name lookup for one connection that admits only the addresses its request may reach. */
export function admittedLookup(
  admission: WebAdmission,
  options: WebNetworkOptions,
  onReach: (reach: WebReach) => void = () => undefined
): LookupFunction {
  return (hostname: string, lookupOptions: LookupOptions, callback) => {
    resolveAdmitted(hostname, admission, options).then(
      ({ addresses, reach }) => {
        onReach(reach)
        if (lookupOptions.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0)
    )
  }
}

export interface AdmittedResponse<T> {
  /** The address the response came from, after any redirects. */
  url: URL
  response: AxiosResponse<T>
}

/** What `getAdmitted` reads of one response when its caller sets no limit. */
export const MAX_RESPONSE_BYTES = 10_000_000

/** A response that outgrew its request: more bytes than it reads, or past its deadline. */
export class WebResponseLimit extends Error {
  constructor(
    readonly limit: 'size' | 'time',
    message: string
  ) {
    super(message)
    this.name = 'WebResponseLimit'
  }
}

/** The call's own signal, ended also by a deadline for the whole exchange when there is one. */
function withDeadline(timeout: number | undefined, signal: AbortSignal | undefined) {
  const deadline = timeout ? AbortSignal.timeout(timeout) : undefined
  return {
    deadline,
    signal: deadline && signal ? AbortSignal.any([signal, deadline]) : (deadline ?? signal)
  }
}

/**
 * GETs `url` under the network policy, checking every redirect before following it. The first
 * hop's admission may be passed in when the caller decided it already. Once it is admitted,
 * `config.timeout` bounds the whole exchange, redirects and body included, and at most
 * `config.maxContentLength` bytes are read, `MAX_RESPONSE_BYTES` when it sets none: the HTTP
 * client's own timeout ends only a quiet connection, so a server that kept sending held the call
 * open and filled memory.
 */
export async function getAdmitted<T>(
  start: URL,
  config: AxiosRequestConfig,
  options: WebNetworkOptions = {},
  admitted?: WebAdmission
): Promise<AdmittedResponse<T>> {
  const maxBytes =
    config.maxContentLength && config.maxContentLength > 0
      ? config.maxContentLength
      : MAX_RESPONSE_BYTES
  // The first admission may wait on the user, which is not the server being slow.
  let admission = admitted ?? (await admitWebUrl(start, options))
  const { deadline, signal } = withDeadline(config.timeout, options.signal)
  let url = start
  let from: WebReach | undefined
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (hop > 0) admission = await admitWebUrl(url, { ...options, from })
      let reach = admission.reach
      const lookup = admittedLookup(admission, options, (resolved) => (reach = resolved))
      const response = await axios.get<T>(url.href, {
        ...config,
        maxContentLength: maxBytes,
        // A fresh connection for each request, so its name is looked up, and checked, every time.
        httpAgent: new HttpAgent({ keepAlive: false, lookup }),
        httpsAgent: new HttpsAgent({ keepAlive: false, lookup }),
        // A proxy would connect on SideKick's behalf, to addresses it never sees.
        proxy: false,
        maxRedirects: 0,
        signal,
        validateStatus: (status) => status < 400
      })
      const location = response.headers.location
      if (response.status < 300 || typeof location !== 'string' || !location) {
        return { url, response }
      }
      // A response whose address went unseen counts as from the internet.
      from = reach ?? 'public'
      try {
        url = new URL(location, url)
      } catch {
        throw new Error('The page redirected to an invalid address')
      }
    }
  } catch (error) {
    if (webNetworkRefusal(error)) throw error
    if (deadline?.aborted && !options.signal?.aborted) {
      throw new WebResponseLimit(
        'time',
        `${url.origin} did not finish answering within ${(config.timeout ?? 0) / 1_000} seconds`
      )
    }
    if (axios.isAxiosError(error) && /^maxContentLength size/.test(error.message)) {
      const size =
        maxBytes >= 1_000_000 ? `${maxBytes / 1_000_000} MB` : `${Math.ceil(maxBytes / 1_000)} KB`
      throw new WebResponseLimit(
        'size',
        `The response from ${url.origin} is larger than ${size}, more than SideKick reads at once`
      )
    }
    throw error
  }
  throw new Error(`The page redirected more than ${MAX_REDIRECTS} times`)
}

/**
 * Sends one request of any method under the network policy. It never follows a redirect: the
 * caller gets the redirect response, so a request carrying a credential cannot be led elsewhere.
 * `config.timeout` bounds the whole exchange once admitted, not only a quiet connection.
 */
export async function requestAdmitted<T>(
  url: URL,
  config: AxiosRequestConfig,
  options: WebNetworkOptions = {}
): Promise<AxiosResponse<T>> {
  const admission = await admitWebUrl(url, options)
  const lookup = admittedLookup(admission, options)
  const { signal } = withDeadline(config.timeout, options.signal)
  return axios.request<T>({
    ...config,
    url: url.href,
    // A fresh connection for each request, so its name is looked up, and checked, every time.
    httpAgent: new HttpAgent({ keepAlive: false, lookup }),
    httpsAgent: new HttpsAgent({ keepAlive: false, lookup }),
    proxy: false,
    maxRedirects: 0,
    signal,
    validateStatus: () => true
  })
}
