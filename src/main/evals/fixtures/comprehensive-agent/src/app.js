/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Preserve this sentinel: sidekick-comprehensive-eval
const toggle = document.querySelector('#mode-toggle')
const status = document.querySelector('#controller-status')

function render(active) {
  document.body.dataset.mode = active ? 'focus' : 'standard'
  toggle.setAttribute('aria-pressed', String(active))
  toggle.textContent = active ? 'Disable focus mode' : 'Enable focus mode'
  status.textContent = active ? 'Focus mode enabled' : 'Before'
}

toggle.addEventListener('click', () => {
  render(toggle.getAttribute('aria-pressed') !== 'true')
})

render(false)
