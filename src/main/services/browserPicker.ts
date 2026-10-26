/**
 * @license
 * Portions adapted from Pomerado (https://github.com/Pomerado/pomerado, commit 1bebf64), also
 * used by browserSettle.ts and browserDates.ts, under the MIT License:
 *
 * Copyright (c) 2026 Pomerado AI, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

// Choosing a value in any picker a page builds: an ARIA combobox, a typeahead whose suggestions
// come from the server, a menu of plain elements, chips of a multi-select, a dialog with a search
// box and a results table. Adapted from Pomerado (https://github.com/Pomerado/pomerado, MIT,
// typescript/src/browser/picker.ts and picker-rank.ts): the service opens the picker and types
// with real input, this page code finds the popup and its options, and `rankChoices` names the one
// option a value means, refusing to guess between two.

/** One option a picker lists, as `rankChoices` reads it. */
export interface PickerChoice {
  /** Every name the option shows or carries: its first line, text, accessible name, title, cells. */
  names: string[]
  /** The value it carries in an attribute such as `data-value`, or "". */
  value: string
  disabled: boolean
  /** One option seen twice has one key; different options have different keys. */
  key: string
}

export type PickerRank = 'exact' | 'normalized' | 'folded' | 'words'

export type PickerRanking =
  | { status: 'picked'; index: number; rank: PickerRank }
  | { status: 'disabled'; index: number; rank: PickerRank }
  | { status: 'ambiguous'; indexes: number[]; rank: PickerRank }
  | { status: 'missing' }

/** Lowercase letters and digits with accents and punctuation dropped, words one space apart. */
export function foldChoiceText(text: string): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * The one option `wanted`, a list of spellings of one choice, names: a name or the value as
 * written, then ignoring case and spacing, then also accents and punctuation, then a name holding
 * a spelling as whole words (New York for York). A name beats the value at each rank. The first
 * rank that matches decides, and a weaker one never overrules it: one option is picked, or
 * reported disabled when every copy of it is; two or more are ambiguous and never guessed.
 */
export function rankChoices(choices: PickerChoice[], wanted: string[]): PickerRanking {
  const squash = (text: string): string =>
    String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const lower = (text: string): string => squash(text).toLowerCase()
  const phrase = (text: string): string => ` ${foldChoiceText(text)} `
  const spellings = wanted.map(squash).filter(Boolean)
  const formed = (form: (text: string) => string): Set<string> =>
    new Set(spellings.map(form).filter(Boolean))
  const byName =
    (form: (text: string) => string) =>
    (choice: PickerChoice): boolean => {
      const forms = formed(form)
      return choice.names.some((name) => forms.has(form(name)))
    }
  const byValue =
    (form: (text: string) => string) =>
    (choice: PickerChoice): boolean =>
      choice.value !== '' && formed(form).has(form(choice.value))
  const tests: Array<[PickerRank, (choice: PickerChoice) => boolean]> = [
    ['exact', byName(squash)],
    ['exact', byValue(squash)],
    ['normalized', byName(lower)],
    ['normalized', byValue(lower)],
    ['folded', byName(foldChoiceText)],
    ['folded', byValue(foldChoiceText)],
    [
      'words',
      (choice) => {
        const parts = spellings.map(phrase).filter((part) => part.trim() !== '')
        return choice.names.some((name) => parts.some((part) => phrase(name).includes(part)))
      }
    ]
  ]
  for (const [rank, test] of tests) {
    const matched = choices.flatMap((choice, index) => (test(choice) ? [index] : []))
    if (!matched.length) continue
    const keys = [...new Set(matched.map((index) => choices[index].key))]
    if (keys.length > 1) {
      const indexes = keys.map((key) => matched.find((index) => choices[index].key === key)!)
      return { status: 'ambiguous', indexes, rank }
    }
    const enabled = matched.find((index) => !choices[index].disabled)
    return enabled === undefined
      ? { status: 'disabled', index: matched[0], rank }
      : { status: 'picked', index: enabled, rank }
  }
  return { status: 'missing' }
}

export type PickerKind = 'select' | 'datalist' | 'typeahead' | 'dropdown' | 'dialog'

export interface PickerOption {
  label: string
  names: string[]
  value: string
  disabled: boolean
  key: string
}

export interface PickerScan {
  popup: boolean
  dialog: boolean
  loading: boolean
  search: boolean
  confirm: boolean
  options: PickerOption[]
  signature: string
}

/**
 * Page code, called on the picker's control with `{ token, phase, ... }`. It keeps what it found
 * in a map on the window under the call's token, never in the page's own attributes, so the
 * service can ask for an option's point and click it with real input.
 *
 * - `detect`: the picker's kind.
 * - `datalist`: an input's datalist options.
 * - `snapshot`: remembers the lists, dialogs and loading signs already showing, and the focus.
 * - `scan`: the popup (the list the control owns through ARIA, else a list, menu, table or dialog
 *   that showed since the snapshot), its options, its search box, its confirm button, and whether
 *   it is still loading.
 * - `point`: scrolls an option, the search box or the confirm button into view and returns its
 *   center, or null when it is gone.
 * - `search-node`: the search box itself, for typing into it.
 * - `after`: whether a clicked option is gone, its popup closed, or it became selected.
 * - `readback`: what the control shows: its own value or text, and the text around it.
 * - `cleanup`: forgets the token.
 */
export const PICKER_PAGE_FUNCTION = String.raw`function(args) {
  const element = this;
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const store = (win[Symbol.for('io.sidekick.browser.picker')] ??= new Map());
  if (args.phase === 'cleanup') { store.delete(args.token); return null; }
  const clean = (text) => String(text ?? '').replace(/[\u200B\u2060\uFEFF\u00AD]/g, '').replace(/\s+/g, ' ').trim();
  const holds = (outer, node) => Boolean(outer && node && (outer === node || outer.contains(node)));
  const shown = (node) => {
    if (!node || !node.isConnected || !(node instanceof win.Element)) return false;
    const box = node.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) return false;
    return !node.checkVisibility || node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const editable = (node) =>
    node instanceof win.HTMLTextAreaElement ? !node.readOnly && !node.disabled
      : node instanceof win.HTMLInputElement ? /^(|text|search|email|url|tel|number)$/i.test(node.getAttribute('type') ?? '') && !node.readOnly && !node.disabled
      : node instanceof win.HTMLElement && node.isContentEditable;
  const focused = () => {
    let active = doc.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  if (args.phase === 'detect') {
    if (element instanceof win.HTMLSelectElement) return 'select';
    if (element instanceof win.HTMLInputElement && element.list instanceof win.HTMLDataListElement) return 'datalist';
    if (element.getAttribute('aria-haspopup') === 'dialog') return 'dialog';
    if (editable(element)) return 'typeahead';
    return 'dropdown';
  }
  if (args.phase === 'datalist') {
    return Array.from(element.list.options).map((option, index) => ({
      label: clean(option.label || option.value), names: [clean(option.label), clean(option.textContent), clean(option.value)].filter(Boolean),
      value: option.value, disabled: option.disabled, key: String(index)
    }));
  }

  let state = store.get(args.token);
  if (!state) {
    state = { before: new WeakSet(), signs: new WeakSet(), focused: null, popup: null, options: [], search: null, confirm: null };
    store.set(args.token, state);
    if (store.size > 20) store.delete(store.keys().next().value);
  }
  // The smallest wrapper around the control that holds no other field: it shows the committed
  // choice (a chip, a label beside the field), and never a neighbour's value.
  const otherField = 'input:not([type=hidden]):not([readonly]):not([disabled]), textarea:not([readonly]), select, [contenteditable="true"], [role=combobox], [role=textbox], [role=searchbox]';
  const wrapper = () => {
    let best = element;
    for (let at = element.parentElement, depth = 0; at && depth < 3 && at !== doc.body; at = at.parentElement, depth++) {
      if (Array.from(at.querySelectorAll(otherField)).some((found) => !holds(element, found) && shown(found))) break;
      best = at;
    }
    return best;
  };
  const popupRoles = '[role=listbox], [role=menu], [role=option], [role=menuitem], [role=tree], [role=grid], [role=dialog], dialog';
  const visibleText = (root) => {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === 3) { parts.push(node.textContent); return; }
      if (!(node instanceof win.Element)) return;
      if (node !== root && (node.matches(popupRoles) || node === state.popup)) return;
      if (node instanceof win.HTMLInputElement || node instanceof win.HTMLTextAreaElement) {
        if (node.type !== 'hidden' && node.type !== 'password') parts.push(' ' + node.value + ' ');
        return;
      }
      if (node instanceof win.HTMLSelectElement) { parts.push(' ' + (node.selectedOptions[0]?.textContent ?? '') + ' '); return; }
      if (/^(script|style|template)$/i.test(node.tagName)) return;
      if (node !== root && node.checkVisibility && !node.checkVisibility({ checkVisibilityCSS: true })) return;
      parts.push(' ');
      for (const child of node.childNodes) visit(child);
      parts.push(' ');
    };
    visit(root);
    return clean(parts.join(''));
  };
  const fieldText = (node) =>
    node instanceof win.HTMLInputElement || node instanceof win.HTMLTextAreaElement ? node.value
      : node instanceof win.HTMLSelectElement ? (node.selectedOptions[0]?.textContent ?? '')
      : (node.innerText ?? node.textContent ?? '');
  if (args.phase === 'readback') {
    const around = wrapper();
    return { own: clean(fieldText(element)), around: around === element ? '' : visibleText(around) };
  }

  const containers = '[role=listbox], [role=menu], [role=grid], [role=tree], [role=dialog], [role=alertdialog], dialog, [aria-modal="true"], ul, ol, table, [class*="menu" i], [class*="dropdown" i], [class*="popup" i], [class*="popover" i], [class*="popper" i], [class*="suggest" i], [class*="autocomplete" i], [class*="results" i], [class*="options" i], [class*="listbox" i], [class*="picker" i]';
  const dialogs = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"]';
  const loadingSigns = '[aria-busy="true"], [role=progressbar]:not([aria-valuenow]):not([aria-valuetext]), [class*="loading" i], [class*="spinner" i], [class*="searching" i], [class*="skeleton" i]';
  // Whole status lines, so an option such as "Loading Dock B" stays an option.
  const statusText = /^(no (results?|matches|options|items|suggestions)( found)?|nothing (found|matches)|loading( results| options)?|searching|please (enter|type) .{0,40}|(enter|type) (at least )?\d+ (or more )?(characters?|letters?)|type to search|start typing.{0,40}|\d+ results? (are |is )?available)[.!\u2026]*$/i;
  const loadingText = /^(loading|searching)( results| options)?[.!\u2026]*$/i;
  const excluded = /(^|[\s_-])(group|header|heading|separator|divider|no-?results?|no-?options|empty|loading|searching|placeholder|footer|message)([\s_-]|$)/i;
  const tiers = [
    '[role=option]',
    '[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=treeitem]',
    '[role=row], tr',
    'li',
    '[data-value], [data-option], [data-id], [data-key], [data-code], [class*="option" i], [class*="item" i], [class*="result" i], [class*="suggestion" i]',
    // A list of plain elements, one per option.
    ':scope > *'
  ];
  const optionsOf = (popup, statuses) => {
    for (const selector of tiers) {
      let found = Array.from(popup.querySelectorAll(selector)).filter((node) => node !== popup && shown(node));
      found = found.filter((node) => {
        if (node.matches('[role=presentation], [role=none], [role=separator], [role=group], [role=heading], [role=status], [role=alert], input, textarea, button, h1, h2, h3, h4, h5, h6')) return false;
        if (node.matches('tr, [role=row]') && node.querySelector('th, [role=columnheader]')) return false;
        if (node.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea')) return false;
        const text = clean(node.innerText);
        const hasValue = node.hasAttribute('data-value') || node.hasAttribute('data-id') || node.hasAttribute('data-key');
        if ((typeof node.className === 'string' && excluded.test(node.className)) || (!hasValue && statusText.test(text))) {
          statuses.push(text);
          return false;
        }
        return text !== '' || node.hasAttribute('aria-label') || node.hasAttribute('title');
      });
      // Rows and list items: the innermost. By class: the outermost that is not a list of several.
      if (selector === tiers[2] || selector === tiers[3]) found = found.filter((node) => !found.some((other) => other !== node && holds(node, other)));
      if (selector === tiers[4]) {
        found = found.filter((node) => found.filter((other) => other !== node && holds(node, other)).length < 2);
        found = found.filter((node) => !found.some((other) => other !== node && holds(other, node)));
      }
      if (found.length) return found;
    }
    return [];
  };
  const signsShown = () => Array.from(doc.querySelectorAll(loadingSigns)).filter((node) => shown(node) && !(node instanceof win.HTMLInputElement && node !== element));
  if (args.phase === 'snapshot') {
    for (const node of doc.querySelectorAll(containers)) if (shown(node) && optionsOf(node, []).length) state.before.add(node);
    for (const node of doc.querySelectorAll(dialogs)) if (shown(node)) state.before.add(node);
    for (const node of signsShown()) state.signs.add(node);
    state.focused = focused();
    return null;
  }
  if (args.phase === 'point') {
    const node = args.which === 'option' ? state.options[args.index] : state[args.which];
    if (!shown(node)) return null;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  if (args.phase === 'search-node') return state.search;
  if (args.phase === 'after') {
    const option = state.options[args.index];
    return {
      gone: !shown(option),
      closed: !shown(state.popup),
      selected: Boolean(option && (option.getAttribute('aria-selected') === 'true' || option.getAttribute('aria-checked') === 'true'))
    };
  }

  // A scan: the popup, its options, its search box and its confirm button.
  const kindOf = (popup) => popup.matches(dialogs + ', dialog') ? 'dialog' : popup.matches('[role=listbox]') ? 'listbox' : popup.matches('[role=menu]') ? 'menu' : popup.matches('table, [role=grid]') ? 'table' : 'list';
  const order = { listbox: 0, menu: 1, dialog: 2, table: 3, list: 4 };
  const owners = [element, element.closest('[role=combobox]'), state.search, focused()].filter((node, index, list) => node instanceof win.Element && list.indexOf(node) === index);
  const byId = (id) => doc.getElementById(id);
  const findPopup = () => {
    for (const owner of owners) {
      const owned = ['aria-controls', 'aria-owns'].flatMap((name) => (owner.getAttribute(name) ?? '').split(/\s+/).filter(Boolean)).map(byId);
      const active = owner.getAttribute('aria-activedescendant');
      if (active) owned.push(byId(active)?.closest('[role=listbox], [role=menu], [role=grid], [role=tree]') ?? null);
      for (const target of owned) {
        if (!shown(target)) continue;
        const inner = target.matches('[role=listbox], [role=menu], [role=grid], [role=tree]') ? target : Array.from(target.querySelectorAll('[role=listbox], [role=menu], [role=grid], [role=tree]')).find(shown);
        if (inner) return inner;
        if (optionsOf(target, []).length) return target;
      }
    }
    if (state.popup && shown(state.popup) && optionsOf(state.popup, []).length) return state.popup;
    const fresh = Array.from(doc.querySelectorAll(containers)).filter((node) => !state.before.has(node) && !holds(node, element) && shown(node) && optionsOf(node, []).length);
    // A dialog that opened holds the picker's search box and results, even while they are empty.
    const opened = Array.from(doc.querySelectorAll(dialogs)).filter((node) => !state.before.has(node) && !holds(node, element) && shown(node));
    const pool = fresh.length ? fresh : opened;
    if (!pool.length) return state.popup && shown(state.popup) ? state.popup : null;
    pool.sort((a, b) => order[kindOf(a)] - order[kindOf(b)] || optionsOf(b, []).length - optionsOf(a, []).length || (holds(a, b) ? 1 : holds(b, a) ? -1 : 0));
    // A dialog's options often sit in a list or table inside it: the dialog is still the popup.
    const dialog = pool.find((node) => kindOf(node) === 'dialog');
    if (dialog && pool.every((node) => holds(dialog, node))) return dialog;
    return pool[0];
  };
  const popup = findPopup();
  state.popup = popup;
  const statuses = [];
  const optionNodes = popup ? optionsOf(popup, statuses) : [];
  state.options = optionNodes;
  // The search box a popup brings: the one it holds, or the field that took focus as it opened.
  const active = focused();
  const candidates = [
    ...(active && active !== element && active !== state.focused && editable(active) && shown(active) ? [active] : []),
    ...(popup ? Array.from(popup.querySelectorAll('input, textarea, [contenteditable=true]')).filter((node) => editable(node) && shown(node)) : [])
  ];
  state.search = candidates.find((node) => node !== element && !holds(node, element)) ?? (state.search && shown(state.search) ? state.search : null);
  state.confirm = popup && kindOf(popup) === 'dialog'
    ? Array.from(popup.querySelectorAll('button, [role=button], input[type=button], input[type=submit]')).find((node) =>
        shown(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true' &&
        /^(select|choose|ok|okay|done|confirm|apply|use)( (selected|this|item|it))?$/i.test(clean(node.innerText || node.value))) ?? null
    : null;
  const counts = new Map();
  const options = optionNodes.map((node) => {
    const lines = String(node.innerText ?? node.textContent ?? '').split('\n').map(clean).filter(Boolean);
    const text = clean(lines.join(' '));
    const cells = node.matches('tr, [role=row]') ? Array.from(node.querySelectorAll('td, [role=gridcell], [role=cell]')).map((cell) => clean(cell.innerText)).filter(Boolean) : [];
    const names = [...new Set([lines[0] ?? '', text, clean(node.getAttribute('aria-label')), clean(node.getAttribute('title')), ...cells].filter(Boolean))];
    const value = ['data-value', 'value', 'data-id', 'data-key', 'data-code'].map((name) => node.getAttribute(name)).find((found) => found !== null && found.trim() !== '') ?? '';
    const disabled = node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('disabled') || node.getAttribute('data-disabled') === 'true' ||
      (typeof node.className === 'string' && /(^|[\s_-])(is-)?disabled([\s_-]|$)/i.test(node.className));
    const base = names.join('\u0001') + '\u0000' + value;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return { label: lines[0] || clean(node.getAttribute('aria-label')) || value, names, value, disabled, key: base + '\u0000' + seen };
  });
  // Still loading: a loading sign new since the snapshot, a Loading or Searching row, a busy popup.
  const loading = signsShown().some((node) => !state.signs.has(node) && (!popup || holds(popup, node) || !holds(node, popup))) ||
    statuses.some((text) => loadingText.test(text)) || Boolean(popup && popup.getAttribute('aria-busy') === 'true');
  return {
    popup: Boolean(popup),
    dialog: Boolean(popup && kindOf(popup) === 'dialog'),
    loading,
    search: Boolean(state.search),
    confirm: Boolean(state.confirm),
    options,
    signature: JSON.stringify([Boolean(popup), Boolean(state.search), loading, statuses.length, options.map((option) => [option.names[0], option.value, option.disabled])])
  };
}`

/** Whether the control's readback shows one of an option's names as whole words. */
export function showsChoice(readback: { own: string; around: string }, names: string[]): boolean {
  const shown = [readback.own, readback.around].map((text) => ` ${foldChoiceText(text)} `)
  return names
    .map(foldChoiceText)
    .some((name) => name !== '' && shown.some((text) => text.includes(` ${name} `)))
}
