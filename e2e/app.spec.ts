import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('shows the service title on the built app', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('Photo Selector')
  await expect(page.getByRole('heading', { level: 1, name: 'Photo Selector' })).toBeVisible()
})

test('has no horizontal overflow at the current viewport', async ({ page }) => {
  await page.goto('/')

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(hasHorizontalOverflow).toBe(false)
})

// 자동 접근성 검사는 보조 수단이며 수동 확인을 대체하지 않는다.
test('has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('/')

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})
