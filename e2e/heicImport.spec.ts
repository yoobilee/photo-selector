import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFixture = (name: string, mimeType: string) => ({
  name,
  mimeType,
  buffer: readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))),
})

// 실제 HEIC 파일: Windows HEIF 이미지 확장(HEVC 인코더)으로 저장소의 sunrise.jpg를 인코딩했다. 아이폰이 만든 파일은 아니다.
const heic = { ...readFixture('sunrise.heic', 'image/heic'), name: 'IMG_0001.HEIC' }
const sunrise = readFixture('sunrise.jpg', 'image/jpeg')
const forest = readFixture('forest.png', 'image/png')
const ocean = readFixture('ocean.webp', 'image/webp')

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

// 이 브라우저가 HEIC를 직접 디코딩하는지 같은 파일로 확인한다. 앱 판정과 별개로 테스트 기대값을 정하는 데만 쓴다.
async function canDecodeHeic(page: Page): Promise<boolean> {
  return page.evaluate(async (bytes) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/heic' }))
    const image = new Image()
    image.src = url
    try {
      await image.decode()
      return image.naturalWidth > 0
    } catch {
      return false
    } finally {
      URL.revokeObjectURL(url)
    }
  }, [...heic.buffer])
}

const fileInput = (page: Page) => page.getByTestId('photo-file-input')
const galleryHeading = (page: Page, count: number) =>
  page.getByRole('heading', { level: 2, name: `선택한 사진 ${count}장` })

test('offers HEIC in the file picker and explains the browser limit before choosing', async ({ page }) => {
  await page.goto('/')

  const accept = (await fileInput(page).getAttribute('accept'))?.split(',') ?? []
  expect(accept).toEqual(expect.arrayContaining(['image/heic', 'image/heif', '.heic', '.heif', 'image/jpeg']))
  await expect(page.getByText('JPEG, PNG, WebP, HEIC 형식을 지원합니다.', { exact: false })).toBeVisible()
  await expect(page.getByText(/HEIC는 사진을 직접 열 수 있는 브라우저/)).toBeVisible()
  await expect(page.getByText(/선택 화면이 닫히기까지 시간이 걸릴 수 있습니다/)).toBeVisible()

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(hasHorizontalOverflow).toBe(false)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('imports a real HEIC file together with other formats according to browser support', async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL ?? '').origin
  const unexpectedRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const isLocalResource = url.protocol === 'blob:' || url.protocol === 'data:'
    const isAppAsset = url.origin === appOrigin && request.method() === 'GET' && !request.postData()
    if (!isLocalResource && !isAppAsset) unexpectedRequests.push(`${request.method()} ${request.url()}`)
  })
  await trackObjectUrls(page)
  await page.goto('/')
  const decodable = await canDecodeHeic(page)

  await fileInput(page).setInputFiles([sunrise, heic, forest, ocean])

  if (decodable) {
    // Safari 17 이상처럼 HEIC를 직접 여는 브라우저(현재 자동 테스트 대상 브라우저에는 없음)
    await expect(galleryHeading(page, 4)).toBeVisible()
    await expect(page.getByRole('img', { name: 'IMG_0001.HEIC' })).toBeVisible()
  } else {
    await expect(galleryHeading(page, 3)).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('사진 3장을 추가했습니다. 1개 파일은 추가하지 않았습니다.')
    const notice = page.getByRole('region', { name: '추가하지 않은 파일 1개' })
    await expect(notice).toContainText('이 브라우저에서 열 수 없는 HEIC 사진 1개')
    await expect(notice).toContainText('IMG_0001.HEIC')
    await expect(notice).toContainText('JPEG로 저장한 사본을 선택하세요')
    await expect(notice).not.toContainText('지원하지 않는 형식')
    // 나머지 형식은 그대로 열리고 분석된다.
    await expect(page.getByRole('img', { name: 'sunrise.jpg' })).toBeVisible()
    await expect(page.getByRole('img', { name: 'ocean.webp' })).toBeVisible()
    // 실패한 HEIC의 디코딩용 임시 URL은 남지 않고 갤러리 미리보기 URL만 남는다.
    expect(await page.evaluate(() => window.liveObjectUrls.size)).toBe(3)

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(hasHorizontalOverflow).toBe(false)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  }
  expect(unexpectedRequests).toEqual([])
})

test('handles many HEIC files in one selection without leaking resources', async ({ page }) => {
  await trackObjectUrls(page)
  await page.goto('/')
  test.skip(await canDecodeHeic(page), 'HEIC를 직접 여는 브라우저에서는 실패 안내를 확인할 수 없다')

  // 바이트가 서로 다른 HEIC 열 장. 끝에 붙인 1바이트는 ftyp 판별에 영향이 없다.
  const many = Array.from({ length: 10 }, (_, index) => ({
    ...heic,
    name: `IMG_${String(index + 1).padStart(4, '0')}.HEIC`,
    buffer: Buffer.concat([heic.buffer, Buffer.from([index])]),
  }))
  await fileInput(page).setInputFiles([...many, sunrise, forest])

  await expect(galleryHeading(page, 2)).toBeVisible()
  const notice = page.getByRole('region', { name: '추가하지 않은 파일 10개' })
  await expect(notice).toContainText('이 브라우저에서 열 수 없는 HEIC 사진 10개')
  await expect(notice).toContainText('외 5개')
  expect(await page.evaluate(() => window.liveObjectUrls.size)).toBe(2)
})
