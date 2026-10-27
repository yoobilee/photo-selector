import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Playwright는 파일 경로와 버퍼를 함께 전달할 수 없어 모든 파일을 버퍼로 전달한다.
const readFixture = (name: string, mimeType: string) => ({
  name,
  mimeType,
  buffer: readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))),
})

const sunrise = readFixture('sunrise.jpg', 'image/jpeg')
const forest = readFixture('forest.png', 'image/png')
const ocean = readFixture('ocean.webp', 'image/webp')

const corruptedJpeg = {
  name: 'broken.jpg',
  mimeType: 'image/jpeg',
  buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('this is not really a jpeg')]),
}
const gifImage = {
  name: 'anim.gif',
  mimeType: 'image/gif',
  buffer: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'),
}
const textDisguisedAsJpeg = {
  name: 'notes.jpg',
  mimeType: 'image/jpeg',
  buffer: Buffer.from('plain text, not a photo'),
}

declare global {
  interface Window {
    liveObjectUrls: Set<string>
  }
}

// 해제되지 않은 Object URL을 추적하기 위해 앱보다 먼저 URL API를 감싼다.
async function trackObjectUrls(page: Page) {
  await page.addInitScript(() => {
    const liveObjectUrls = new Set<string>()
    const createObjectURL = URL.createObjectURL.bind(URL)
    const revokeObjectURL = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (object) => {
      const url = createObjectURL(object)
      liveObjectUrls.add(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      liveObjectUrls.delete(url)
      revokeObjectURL(url)
    }
    window.liveObjectUrls = liveObjectUrls
  })
}

const liveObjectUrlCount = (page: Page) => page.evaluate(() => window.liveObjectUrls.size)

const fileInput = (page: Page) => page.getByTestId('photo-file-input')

const galleryHeading = (page: Page, count: number) =>
  page.getByRole('heading', { level: 2, name: `선택한 사진 ${count}장` })

const galleryImages = (page: Page) => page.getByRole('list').getByRole('img')

test('imports photos with the keyboard and shows decoded thumbnails', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 2, name: '정리할 사진을 선택하세요' })).toBeVisible()

  await page.keyboard.press('Tab')
  const pickerButton = page.getByRole('button', { name: '사진 선택' })
  await expect(pickerButton).toBeFocused()

  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  const fileChooser = await fileChooserPromise
  expect(fileChooser.isMultiple()).toBe(true)
  await fileChooser.setFiles([sunrise, forest, ocean])

  await expect(galleryHeading(page, 3)).toBeFocused()
  await expect(page.getByRole('status')).toHaveText('사진 3장을 추가했습니다.')
  await expect(galleryImages(page)).toHaveCount(3)
  await expect
    .poll(() =>
      galleryImages(page).evaluateAll((images) =>
        images.map((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toEqual([true, true, true])
})

test('skips unsupported and corrupted files with an explanation', async ({ page }) => {
  await page.goto('/')

  await fileInput(page).setInputFiles([sunrise, gifImage, textDisguisedAsJpeg, corruptedJpeg])

  await expect(galleryHeading(page, 1)).toBeVisible()
  await expect(page.getByRole('status')).toHaveText(
    '사진 1장을 추가했습니다. 3개 파일은 추가하지 않았습니다.',
  )
  const notice = page.getByRole('region', { name: '추가하지 않은 파일 3개' })
  await expect(notice).toContainText('지원하지 않는 형식 2개')
  await expect(notice).toContainText('anim.gif')
  await expect(notice).toContainText('notes.jpg')
  await expect(notice).toContainText('열 수 없는 파일 1개')
  await expect(notice).toContainText('broken.jpg')

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('keeps photos on cancel, appends new ones and skips duplicates', async ({ page }) => {
  await page.goto('/')
  await fileInput(page).setInputFiles([sunrise])
  await expect(galleryHeading(page, 1)).toBeVisible()

  // 파일 선택 취소는 빈 선택으로 전달된다.
  await fileInput(page).setInputFiles([])
  await expect(galleryHeading(page, 1)).toBeVisible()

  const sunriseCopy = { ...sunrise, name: 'sunrise-copy.jpg' }
  await fileInput(page).setInputFiles([sunriseCopy, forest])

  await expect(galleryHeading(page, 2)).toBeVisible()
  await expect(galleryImages(page)).toHaveCount(2)
  await expect(page.getByRole('img', { name: 'forest.png' })).toBeVisible()
  const notice = page.getByRole('region', { name: '추가하지 않은 파일 1개' })
  await expect(notice).toContainText('이미 추가된 사진 1개')
  await expect(notice).toContainText('sunrise-copy.jpg')
})

test('removes photos from the list and releases their previews', async ({ page }) => {
  await trackObjectUrls(page)
  await page.goto('/')
  await fileInput(page).setInputFiles([sunrise, forest, ocean])
  await expect(galleryHeading(page, 3)).toBeVisible()
  // 디코딩용 임시 URL은 해제되고 갤러리 미리보기 URL만 남는다.
  expect(await liveObjectUrlCount(page)).toBe(3)

  await page.getByRole('button', { name: 'forest.png 목록에서 제거' }).click()
  await expect(galleryHeading(page, 2)).toBeVisible()
  await expect(page.getByRole('img', { name: 'forest.png' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ocean.webp 목록에서 제거' })).toBeFocused()
  expect(await liveObjectUrlCount(page)).toBe(2)

  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'sunrise.jpg 목록에서 제거' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('button', { name: '사진 선택' })).toBeFocused()
  expect(await liveObjectUrlCount(page)).toBe(0)
})

test('keeps photo data on the device', async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL ?? '').origin
  const unexpectedRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const isLocalResource = url.protocol === 'blob:' || url.protocol === 'data:'
    const isAppAsset = url.origin === appOrigin && request.method() === 'GET' && !request.postData()
    if (!isLocalResource && !isAppAsset) {
      unexpectedRequests.push(`${request.method()} ${request.url()}`)
    }
  })

  await page.goto('/')
  await fileInput(page).setInputFiles([sunrise, forest, ocean, corruptedJpeg])
  await expect(galleryHeading(page, 3)).toBeVisible()
  await page.getByRole('button', { name: 'sunrise.jpg 목록에서 제거' }).click()
  await expect(galleryHeading(page, 2)).toBeVisible()

  expect(unexpectedRequests).toEqual([])
})

test('lays out the gallery without horizontal overflow', async ({ page }) => {
  await page.goto('/')
  const longName = { ...sunrise, name: `${'very-long-photo-name-'.repeat(8)}.jpg` }
  await fileInput(page).setInputFiles([longName, forest, ocean, gifImage])
  await expect(galleryHeading(page, 3)).toBeVisible()

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(hasHorizontalOverflow).toBe(false)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})
