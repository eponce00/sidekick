/**
 * Opens a chat by its title in the sidebar, as a person would. On a small screen, such as the
 * 1024x768 of a CI Mac, the sidebar folds to its rail to make room for the open side panel, and
 * the chat's row is only there once it is expanded.
 */
async function openChatFromSidebar(page, title) {
  const row = page.getByText(title, { exact: true }).first()
  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  await row.or(expand).first().waitFor()
  if (await expand.isVisible()) await expand.click()
  await row.click()
}

module.exports = { openChatFromSidebar }
