import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { adjustTone, cropImage, matchTone } from '../src/test/photoVariants.ts'
import { gaussianBlur, renderScene, renderUniform } from '../src/test/syntheticImages.ts'
import { encodeGrayPng } from './support/grayPng.ts'

// 실제 브라우저의 디코딩·축소·JPEG 압축과 Web Worker로 비슷한 사진 묶음을 확인한다. 합성 장면이며 실제 사진 검증을 대신하지 않는다.
const png = (name: string, image: Parameters<typeof encodeGrayPng>[0]) => ({
  name,
  mimeType: 'image/png',
  buffer: encodeGrayPng(image),
})
const lens = (image: Parameters<typeof gaussianBlur>[0]) => gaussianBlur(image, 0.8)

const portraitImage = lens(renderScene(1024, 768, 21))
const portrait = png('portrait.png', portraitImage)
const portraitBright = png('portrait-bright.png', adjustTone(portraitImage, { gain: 0.8, offset: 40 }))
const burstScene = lens(renderScene(1100, 825, 22))
const burstFirst = png('burst-1.png', cropImage(burstScene, 0, 0, 1024, 768))
const burstSecond = png('burst-2.png', cropImage(burstScene, 32, 16, 1024, 768))
const other = png('other.png', lens(renderScene(1024, 768, 40)))
// 밝기·대비 분포를 portrait와 맞춘 다른 장면
const lookalike = png('lookalike.png', matchTone(lens(renderScene(1024, 768, 41)), portraitImage))
const plainWall = png('plain-wall.png', renderUniform(800, 600, 150))

// 브라우저의 JPEG 인코더로 크기와 압축률이 다른 사본을 만든다.
async function smallerJpegOf(page: Page, source: Buffer, width: number, height: number, quality: number) {
  const base64 = await page.evaluate(
    async ({ sourceBase64, width, height, quality }) => {
      const bytes = Uint8Array.from(atob(sourceBase64), (character) => character.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', quality))
      const jpeg = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < jpeg.length; offset += 0x8000) {
        binary += String.fromCharCode(...jpeg.subarray(offset, offset + 0x8000))
      }
      return btoa(binary)
    },
    { sourceBase64: source.toString('base64'), width, height, quality },
  )
  return Buffer.from(base64, 'base64')
}

const fileInput = (page: Page) => page.getByTestId('photo-file-input')
const photo = (page: Page, name: string) => page.getByRole('img', { name, exact: true })
const photoCard = (page: Page, name: string) => page.getByRole('listitem').filter({ has: photo(page, name) })
const groupBadge = (page: Page, name: string) => photoCard(page, name).getByTestId('similar-group-badge')
const similarSummary = (page: Page) => page.getByTestId('similar-summary')
const galleryNames = (page: Page) => page.getByRole('list').first().getByRole('img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')))

test.describe.configure({ timeout: 90_000 })

test('groups almost identical and similar photos on the device and lets the user compare and remove them', async ({
  page,
  baseURL,
}) => {
  const appOrigin = new URL(baseURL ?? '').origin
  const unexpectedRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const isLocalResource = url.protocol === 'blob:' || url.protocol === 'data:'
    const isAppAsset = url.origin === appOrigin && request.method() === 'GET' && !request.postData()
    if (!isLocalResource && !isAppAsset) unexpectedRequests.push(`${request.method()} ${request.url()}`)
  })
  await page.goto('/')
  const portraitJpeg = { name: 'portrait-small.jpg', mimeType: 'image/jpeg', buffer: await smallerJpegOf(page, portrait.buffer, 640, 480, 0.5) }
  const names = [
    'portrait.png',
    'other.png',
    'portrait-small.jpg',
    'burst-1.png',
    'lookalike.png',
    'portrait-bright.png',
    'plain-wall.png',
    'burst-2.png',
  ]

  await fileInput(page).setInputFiles([portrait, other, portraitJpeg, burstFirst, lookalike, portraitBright, plainWall, burstSecond])

  await expect(similarSummary(page)).toHaveText('비슷한 사진 묶음 2개(5장) · 비교하지 못한 사진 1장', { timeout: 60_000 })
  // 기본 보기는 가져온 순서를 유지하고 묶인 사진에만 표시를 붙인다.
  expect(await galleryNames(page)).toEqual(names)
  for (const name of ['portrait.png', 'portrait-small.jpg', 'portrait-bright.png']) {
    await expect(groupBadge(page, name)).toContainText('묶음 1')
  }
  for (const name of ['burst-1.png', 'burst-2.png']) await expect(groupBadge(page, name)).toContainText('묶음 2')
  for (const name of ['other.png', 'lookalike.png', 'plain-wall.png']) await expect(groupBadge(page, name)).toHaveCount(0)

  await page.getByRole('button', { name: '비슷한 사진끼리 보기' }).click()
  const same = page.getByRole('region', { name: '묶음 1 · 거의 같은 사진 3장' })
  const similar = page.getByRole('region', { name: '묶음 2 · 비슷한 사진 2장' })
  await expect(same.getByRole('img')).toHaveCount(3)
  await expect(similar.getByRole('img')).toHaveCount(2)
  // 좁은 화면에서도 묶음 안의 사진은 두 장씩 나란히 크게 보인다.
  const [first, second] = await Promise.all([
    similar.getByRole('img').nth(0).boundingBox(),
    similar.getByRole('img').nth(1).boundingBox(),
  ])
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(1)
  expect(first!.width).toBeGreaterThan(120)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])

  // 묶음에서 한 장을 제거하면 혼자 남은 사진은 묶음에서 빠진다. 원본 파일은 기기에서 지워지지 않는다.
  await similar.getByRole('button', { name: 'burst-1.png 목록에서 제거', exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name: '선택한 사진 7장' })).toBeVisible()
  await expect(similar).toHaveCount(0)
  await expect(similarSummary(page)).toHaveText('비슷한 사진 묶음 1개(3장) · 비교하지 못한 사진 1장')

  await page.getByRole('button', { name: '모든 사진' }).click()
  expect(await galleryNames(page)).toEqual(names.filter((name) => name !== 'burst-1.png'))
  await expect(groupBadge(page, 'burst-2.png')).toHaveCount(0)
  expect(unexpectedRequests).toEqual([])
})
