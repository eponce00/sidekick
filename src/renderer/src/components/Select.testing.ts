import { act } from 'react'

/** Test helpers for `Select`: its options live in a list that opens on click, outside the form. */

async function openOptions(trigger: HTMLElement): Promise<HTMLElement[]> {
  if (trigger.getAttribute('aria-expanded') !== 'true') await act(async () => trigger.click())
  const list = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
  return list ? [...list.querySelectorAll<HTMLElement>('[role="option"]')] : []
}

async function closeOptions(trigger: HTMLElement): Promise<void> {
  if (trigger.getAttribute('aria-expanded') !== 'true') return
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** Each option's value and visible label, as a native select's `options` would give. */
export async function selectOptions(
  trigger: HTMLElement
): Promise<Array<{ value: string; label: string }>> {
  const options = (await openOptions(trigger)).map((option) => ({
    value: option.dataset.value ?? '',
    label: option.textContent ?? ''
  }))
  await closeOptions(trigger)
  return options
}

/** Chooses the option with this value, as a user clicking it would. */
export async function chooseSelectOption(trigger: HTMLElement, value: string): Promise<void> {
  const option = (await openOptions(trigger)).find((candidate) => candidate.dataset.value === value)
  if (!option) throw new Error(`No option with value ${value}`)
  await act(async () => option.click())
}
