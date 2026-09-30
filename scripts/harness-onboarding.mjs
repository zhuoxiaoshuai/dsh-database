/** Dismiss only documented first-run dialogs in the disposable acceptance profile. */
export async function dismissHarnessOnboarding(page) {
  const declaration = page.getByText(/^(内测声明|预览版说明)$/)
  if (await declaration.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await declaration.waitFor({ state: 'hidden' })
  }
  const later = page.getByRole('button', { name: '稍后配置', exact: true })
  if (await later.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    await later.click()
    await later.waitFor({ state: 'hidden' })
  }
}
