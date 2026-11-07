import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { adjustTone, cropImage } from '../src/test/photoVariants.ts'
import { gaussianBlur, renderScene } from '../src/test/syntheticImages.ts'
import { encodeGrayPng } from './support/grayPng.ts'

// 남길 사진 고르기와 비슷한 사진 크게 비교를 실제 브라우저에서 확인한다. 합성 장면이며 실제 사진 검증을 대신하지 않는다.
const png = (name: string, image: Parameters<typeof encodeGrayPng>[0]) => ({
  name,
  mimeType: 'image/png',
  buffer: encodeGrayPng(image),
})
const lens = (image: Parameters<typeof gaussianBlur>[0]) => gaussianBlur(image, 0.8)

const portraitImage = lens(renderScene(1024, 768, 21))
const burstScene = lens(renderScene(1100, 825, 22))
const files = [
  png('portrait.png', portraitImage),
  png('other.png', lens(renderScene(1024, 768, 40))),
  png('portrait-bright.png', adjustTone(portraitImage, { gain: 0.8, offset: 40 })),
  png('burst-1.png', cropImage(burstScene, 0, 0, 1024, 768)),
  png('burst-2.png', cropImage(burstScene, 32, 16, 1024, 768)),
]

const keepButton = (scope: Page | ReturnType<Page['getByRole']>, name: string) =>
  scope.getByRole('button', { name: `${name} 남기기`, exact: true })
const keptSummary = (page: Page) => page.getByTestId('kept-summary')
const hasNoHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('photo-file-input').setInputFiles(files)
  await expect(page.getByTestId('similar-summary')).toHaveText('비슷한 사진 묶음 2개(4장)', { timeout: 60_000 })
})

test('keeps photos chosen by the user across views without hiding or removing the others', async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL ?? '').origin
  const unexpectedRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const isLocalResource = url.protocol === 'blob:' || url.protocol === 'data:'
    const isAppAsset = url.origin === appOrigin && request.method() === 'GET' && !request.postData()
    if (!isLocalResource && !isAppAsset) unexpectedRequests.push(`${request.method()} ${request.url()}`)
  })

  await keepButton(page, 'portrait.png').click()
  await keepButton(page, 'other.png').click()
  await expect(keptSummary(page)).toHaveText('남길 사진 2장')
  await expect(keepButton(page, 'portrait.png')).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '비슷한 사진끼리 보기' }).click()
  const same = page.getByRole('region', { name: '묶음 1 · 거의 같은 사진 2장' })
  await expect(keepButton(same, 'portrait.png')).toHaveAttribute('aria-pressed', 'true')
  await keepButton(same, 'portrait-bright.png').click()
  // 남기기 버튼은 손가락으로 누르기 충분한 크기다.
  const box = await keepButton(same, 'portrait-bright.png').boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(await hasNoHorizontalOverflow(page)).toBe(true)

  await page.getByRole('button', { name: '남길 사진만 보기' }).click()
  await expect(page.getByRole('list').getByRole('img')).toHaveCount(3)
  await expect(page.getByText('남기지 않은 사진 2장도 지워지지 않으며 ‘모든 사진’에서 볼 수 있습니다.')).toBeVisible()
  expect(await hasNoHorizontalOverflow(page)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])

  // 남긴 사진을 목록에서 제거하면 남길 사진에서도 빠진다.
  await page.getByRole('button', { name: 'other.png 목록에서 제거', exact: true }).click()
  await expect(keptSummary(page)).toHaveText('남길 사진 2장')
  await page.getByRole('button', { name: '모든 사진' }).click()
  await expect(page.getByRole('list').getByRole('img')).toHaveCount(4)
  expect(unexpectedRequests).toEqual([])
})

test('compares a group with the original images and returns to the same place in the gallery', async ({ page }) => {
  const isWide = (page.viewportSize()?.width ?? 0) >= 768
  await page.getByRole('button', { name: '비슷한 사진끼리 보기' }).click()
  const openButton = page.getByRole('button', { name: '묶음 2 크게 비교' })
  await openButton.scrollIntoViewIfNeeded()
  const scrollBefore = await page.evaluate(() => window.scrollY)
  await openButton.click()

  const dialog = page.getByRole('dialog', { name: '묶음 2 · 비슷한 사진 크게 비교' })
  await expect(dialog).toBeVisible()
  const panes = dialog.getByTestId('compare-pane')
  // 넓은 화면은 두 장을 나란히, 좁은 화면은 한 장을 크게 보여 준다.
  await expect(panes).toHaveCount(isWide ? 2 : 1)
  // 512px 미리보기가 아니라 원본 해상도로 보여 준다. 보이는 사진만 읽는다.
  const originals = dialog.getByTestId('original-image')
  await expect(originals).toHaveCount(isWide ? 2 : 1)
  await expect.poll(() => originals.first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1024)
  if (isWide) {
    const [left, right] = await Promise.all([panes.nth(0).boundingBox(), panes.nth(1).boundingBox()])
    expect(Math.abs(left!.y - right!.y)).toBeLessThan(1)
    expect(left!.width).toBeGreaterThan(300)
  } else {
    const pane = await panes.first().boundingBox()
    expect(pane!.width).toBeGreaterThan(page.viewportSize()!.width * 0.85)
    expect(pane!.height).toBeGreaterThan(250)
  }
  await expect(dialog.getByText('흐림 의심 없음').first()).toBeVisible()
  expect(await hasNoHorizontalOverflow(page)).toBe(true)
  expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([])

  if (!isWide) {
    // 좁은 화면에서는 밀어서 다음 사진으로 넘긴다.
    await expect(dialog.getByTestId('compare-position')).toHaveText('1 / 2')
    const area = dialog.getByTestId('compare-panes')
    await area.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 300, clientY: 300, bubbles: true })
    await area.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 120, clientY: 310, bubbles: true })
    await expect(dialog.getByTestId('compare-position')).toHaveText('2 / 2')
    await expect(dialog.getByRole('img', { name: 'burst-2.png', exact: true })).toBeVisible()
    await expect(originals).toHaveCount(1)
  }

  // 비교 중 남기기를 바꾸면 갤러리에도 반영된다.
  await keepButton(dialog, 'burst-2.png').click()
  await expect(keepButton(dialog, 'burst-2.png')).toHaveAttribute('aria-pressed', 'true')
  await expect(keptSummary(page)).toHaveText('남길 사진 1장')

  // Esc로 닫으면 원본 이미지를 정리하고, 비교를 연 버튼과 원래 스크롤 위치로 돌아온다.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('original-image')).toHaveCount(0)
  await expect(openButton).toBeFocused()
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore)).toBeLessThan(2)
  await expect(keepButton(page.getByRole('region', { name: '묶음 2 · 비슷한 사진 2장' }), 'burst-2.png')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('navigates the comparison with the keyboard and keeps focus inside it', async ({ page }) => {
  await page.getByRole('button', { name: '비슷한 사진끼리 보기' }).click()
  await page.getByRole('button', { name: '묶음 1 크게 비교' }).focus()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog')
  await expect(page.getByRole('button', { name: '비교 닫기' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByTestId('compare-position')).toHaveText((page.viewportSize()?.width ?? 0) >= 768 ? '1–2 / 2' : '2 / 2')
  // 탭 이동은 비교 화면 안에서만 돈다.
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null || document.activeElement === document.body)).toBe(true)
  }
  await dialog.getByRole('button', { name: '비교 닫기' }).click()
  await expect(page.getByRole('button', { name: '묶음 1 크게 비교' })).toBeFocused()
})
