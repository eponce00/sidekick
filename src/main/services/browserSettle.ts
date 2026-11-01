// When a page has settled after an action. Adapted from the progress-based waits in Pomerado
// (https://github.com/Pomerado/pomerado, typescript/src/browser/wait.ts; Copyright (c) 2026
// Pomerado AI, Inc., MIT License, notice in browserPicker.ts): a page is still working while
// something the action caused is still happening, and the page's own background activity, such
// as a carousel, a clock, polling or analytics, never holds the wait open.

/** Resource types whose requests are the page's own work; images, fonts, beacons and the rest are not. */
const COUNTED_RESOURCE_TYPES = new Set(['Document', 'XHR', 'Fetch', 'Script', 'Other', ''])

/** A request already open when the action began counts only this long: long-polls never end. */
export const PRIOR_REQUEST_WINDOW_MS = 2_000

/** How far back the page's own repeated changes are looked for, and how many make an element noise. */
const NOISE_WINDOW_MS = 4_000
const NOISE_CHANGES = 3

export interface SettleRequest {
  resourceType?: string
  ignoredForIdle?: boolean
  startedAt: number
}

/**
 * How many requests still hold the page busy at `now`: the page's own requests the action started
 * (from `since`), until they end, and earlier ones only while they are young, since a request
 * that was already open is usually a long-poll or a stream.
 */
export function busyRequests(
  requests: Iterable<SettleRequest>,
  since: number,
  now: number
): number {
  let busy = 0
  for (const request of requests) {
    if (request.ignoredForIdle || !COUNTED_RESOURCE_TYPES.has(request.resourceType ?? '')) continue
    if (request.startedAt >= since || now - request.startedAt < PRIOR_REQUEST_WINDOW_MS) busy++
  }
  return busy
}

/**
 * Page code: installs the change log once per document and returns its token. Each change is kept
 * with the element it happened in, for a few seconds, so a wait can tell the page's own repeated
 * changes from the ones an action caused.
 */
export const SETTLE_INSTALL_SCRIPT = `(() => {
  const key = Symbol.for('io.sidekick.browser.settle');
  let state = window[key];
  if (!state) {
    state = { token: Math.random().toString(36).slice(2), log: [], marks: new Map() };
    const element = (node) => node && (node.nodeType === 1 ? node : node.parentElement);
    state.observer = new MutationObserver((records) => {
      const at = performance.now();
      for (const record of records) {
        const changed = element(record.target);
        if (changed) state.log.push({ at, changed });
      }
      if (state.log.length > 4000) state.log.splice(0, state.log.length - 3000);
    });
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window[key] = state;
  }
  return state.token;
})()`

const LOADING_SIGNS = `'[aria-busy="true"], [role="progressbar"]:not([aria-valuenow]), progress:not([value]), [class*="spinner" i], [class*="loader" i], [class*="loading" i], [class*="skeleton" i], [class*="shimmer" i]'`

const SIGN_HELPERS = `
  const shown = (node) => {
    const box = node.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) return false;
    return !node.checkVisibility || node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const signs = () => Array.from(document.querySelectorAll(${LOADING_SIGNS}))
    .filter((node) => !node.matches('input, select, textarea, button') && shown(node));`

/**
 * Page code: marks the start of an action. The loading signs already showing are the page's own
 * decoration, and the elements that kept changing before it are noise for the wait that follows.
 */
export const SETTLE_MARK_SCRIPT = `(() => {
  const token = ${SETTLE_INSTALL_SCRIPT};
  const state = window[Symbol.for('io.sidekick.browser.settle')];
  ${SIGN_HELPERS}
  const at = performance.now();
  const counts = new Map();
  for (const entry of state.log) {
    if (entry.at < at - ${NOISE_WINDOW_MS}) continue;
    counts.set(entry.changed, (counts.get(entry.changed) || 0) + 1);
  }
  // Never the whole page: a page that re-renders everything would hide every change.
  const noise = [...counts].filter(([node, count]) => count >= ${NOISE_CHANGES} &&
    node !== document.documentElement && node !== document.body &&
    node.getElementsByTagName('*').length <= 400).map(([node]) => node);
  const id = Math.random().toString(36).slice(2);
  state.marks.set(id, { at, noise, signs: new Set(signs()) });
  if (state.marks.size > 20) state.marks.delete(state.marks.keys().next().value);
  return { token, id };
})()`

/**
 * Page code: what the action has changed since its mark. Changes inside elements that were
 * already changing on their own do not count; loading signs count only when they appeared since.
 * On a document the mark was not taken in, as after a navigation, every change counts.
 */
export function settleProbeScript(mark: { token: string; id: string } | undefined): string {
  return `(() => {
    const token = ${SETTLE_INSTALL_SCRIPT};
    const state = window[Symbol.for('io.sidekick.browser.settle')];
    ${SIGN_HELPERS}
    const mark = token === ${JSON.stringify(mark?.token ?? '')} ? state.marks.get(${JSON.stringify(mark?.id ?? '')}) : undefined;
    const since = mark ? mark.at : -Infinity;
    const noise = mark ? mark.noise : [];
    let changes = 0;
    for (const entry of state.log) {
      if (entry.at <= since) continue;
      if (noise.some((node) => node === entry.changed || node.contains(entry.changed))) continue;
      changes++;
    }
    const before = mark ? mark.signs : new Set();
    const loading = signs().filter((node) => !before.has(node)).length;
    return { changes, loading };
  })()`
}
