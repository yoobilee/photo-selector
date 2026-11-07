import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  addNoise,
  gaussianBlur,
  motionBlur,
  renderGradient,
  renderHorizon,
  renderScene,
  renderStripes,
  renderUniform,
} from '../src/test/syntheticImages.ts'
import { encodeGrayPng } from './support/grayPng.ts'

// 실제 브라우저의 디코딩·축소와 Web Worker로 흐림 판정을 확인한다. 합성 이미지는 매번 같은 바이트로 만든다.
// 판정이 브라우저마다 갈리는 경계 사례(약한 흔들림 등)는 넣지 않고 단위 테스트와 README에 한계로 기록한다.
const png = (name: string, image: Parameters<typeof encodeGrayPng>[0]) => ({
  name,
  mimeType: 'image/png',
  buffer: encodeGrayPng(image),
})
// 분석 크기(1024×768)와 같은 사진은 축소 없이 분석하므로 브라우저마다 같은 화소로 판정한다.
const lensScene = (seed: number) => gaussianBlur(renderScene(1024, 768, seed), 0.8)

const sharpScene = png('sharp-scene.png', gaussianBlur(renderScene(1600, 1200, 11), 0.8))
// 2048보다 커서 두 배 크기로 그린 뒤 평균으로 줄이는 경로를 탄다.
const largeSharpScene = png('large-sharp-scene.png', gaussianBlur(renderScene(2400, 1800, 11), 1))
const smallSharpScene = png('small-sharp-scene.png', gaussianBlur(renderScene(320, 240, 11), 0.8))
const blurredScene = png('blurred-scene.png', gaussianBlur(renderScene(1600, 1200, 11), 3))
const largeBlurredScene = png('large-blurred-scene.png', gaussianBlur(renderScene(2400, 1800, 12), 6))
const shakenScene = png('shaken-scene.png', motionBlur(gaussianBlur(renderScene(1600, 1200, 13), 0.8), 24))
// 길게 끌린 흔들림. 방향별 점수만으로는 끌린 방향이 판정에서 빠져 분석 불가였다.
const longShakenScene = png('long-shaken-scene.png', addNoise(motionBlur(lensScene(13), 25), 0.3, 5))
// 초점이 흐린 데다 흔들려 두 방향이 모두 흐리다. 원인을 하나로 단정하지 않는다.
const softShakenScene = png('soft-shaken-scene.png', addNoise(motionBlur(gaussianBlur(lensScene(2), 2), 21), 0.3, 2))
// 방향성이 강한 선명한 사진(블라인드, 수평선)은 흔들림으로 오판하지 않는다.
const blinds = png('blinds.png', addNoise(gaussianBlur(renderStripes(1024, 768, 8), 0.8), 0.3, 1))
const horizon = png('horizon.png', addNoise(gaussianBlur(renderHorizon(1024, 768), 0.8), 0.3, 1))
const plainWall = png('plain-wall.png', renderUniform(800, 600, 150))
const clearSky = png('clear-sky.png', renderGradient(800, 600))
// 매끈한 그라데이션 위에 선명한 원 하나가 있는 작은 사진(160×120)
const sunrise = {
  name: 'sunrise.jpg',
  mimeType: 'image/jpeg',
  buffer: readFileSync(fileURLToPath(new URL('./fixtures/sunrise.jpg', import.meta.url))),
}

const fileInput = (page: Page) => page.getByTestId('photo-file-input')
const photo = (page: Page, name: string) => page.getByRole('img', { name, exact: true })
const photoCard = (page: Page, name: string) => page.getByRole('listitem').filter({ has: photo(page, name) })
// 사진 위에 겹친 시각 표시와 사진 칸 아래의 판정 사유. 같은 내용의 낭독용 설명은 accessible description으로 따로 확인한다.
const badge = (page: Page, name: string) => photoCard(page, name).getByTestId('sharpness-badge')
const reason = (page: Page, name: string) => photoCard(page, name).getByTestId('sharpness-reason')
const sharpnessSummary = (page: Page) => page.getByTestId('sharpness-summary')

test.describe.configure({ timeout: 60_000 })

test('labels shake, defocus and unclear blur with a visible reason, marks undecidable photos and leaves sharp ones unbadged', async ({
  page,
}) => {
  await page.goto('/')
  await fileInput(page).setInputFiles([
    sharpScene,
    largeSharpScene,
    smallSharpScene,
    blurredScene,
    largeBlurredScene,
    shakenScene,
    longShakenScene,
    softShakenScene,
    blinds,
    horizon,
    plainWall,
    clearSky,
    sunrise,
  ])

  await expect(sharpnessSummary(page)).toHaveText('흔들림 의심 2장 · 초점 불량 의심 2장 · 흐림 의심 1장 · 분석 불가 2장', {
    timeout: 45_000,
  })

  const expectations = [
    { names: ['shaken-scene.png', 'long-shaken-scene.png'], label: '흔들림 의심', reasonText: '한 방향으로 번진 윤곽' },
    { names: ['blurred-scene.png', 'large-blurred-scene.png'], label: '초점 불량 의심', reasonText: '전체가 고르게 흐림' },
    { names: ['soft-shaken-scene.png'], label: '흐림 의심', reasonText: '원인 구분 어려움' },
    // 균일한 벽·맑은 하늘은 흐림으로 단정하지 않는다.
    { names: ['plain-wall.png', 'clear-sky.png'], label: '분석 불가', reasonText: '윤곽 부족 또는 잡음' },
  ]
  for (const { names, label, reasonText } of expectations) {
    for (const name of names) {
      await expect(photo(page, name)).toHaveAccessibleDescription(
        label === '분석 불가' ? /^흐림 분석 불가: 윤곽이 적거나/ : new RegExp(`^${label}: `),
      )
      await expect(badge(page, name)).toHaveText(label)
      // 사유는 마우스를 올리지 않아도(터치 화면에서도) 사진 칸 안에 보인다.
      await expect(reason(page, name)).toBeVisible()
      await expect(reason(page, name)).toHaveText(reasonText)
      const card = await photoCard(page, name).boundingBox()
      const reasonBox = await reason(page, name).boundingBox()
      expect(reasonBox!.x).toBeGreaterThanOrEqual(card!.x - 0.5)
      expect(reasonBox!.x + reasonBox!.width).toBeLessThanOrEqual(card!.x + card!.width + 0.5)
    }
  }
  for (const name of [
    'sharp-scene.png',
    'large-sharp-scene.png',
    'small-sharp-scene.png',
    'blinds.png',
    'horizon.png',
    'sunrise.jpg',
  ]) {
    await expect(photo(page, name)).toHaveAccessibleDescription('흐림 의심 없음')
    await expect(badge(page, name)).toHaveCount(0)
    await expect(reason(page, name)).toHaveCount(0)
  }
  // 좁은 화면에서도 가장 긴 표시 문구가 사진 칸을 넘지 않는다.
  const softCard = await photo(page, 'blurred-scene.png').boundingBox()
  const softBadge = await badge(page, 'blurred-scene.png').boundingBox()
  expect(softBadge!.x + softBadge!.width).toBeLessThanOrEqual(softCard!.x + softCard!.width + 0.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})

test('ignores the analysis of a photo removed while it is being analyzed', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await fileInput(page).setInputFiles([sharpScene, largeSharpScene, blurredScene, largeBlurredScene, shakenScene])
  await expect(page.getByRole('heading', { level: 2, name: '선택한 사진 5장' })).toBeVisible()

  // 동시 분석 상한(2장) 뒤에서 기다리는 사진과 이미 결과가 있을 수 있는 사진을 모두 지운다.
  await page.getByRole('button', { name: 'shaken-scene.png 목록에서 제거', exact: true }).click()
  await page.getByRole('button', { name: 'sharp-scene.png 목록에서 제거', exact: true }).click()

  await expect(page.getByRole('heading', { level: 2, name: '선택한 사진 3장' })).toBeVisible()
  await expect(sharpnessSummary(page)).toHaveText('초점 불량 의심 2장', { timeout: 30_000 })
  await expect(photo(page, 'large-sharp-scene.png')).toHaveAccessibleDescription('흐림 의심 없음')
  expect(pageErrors).toEqual([])
})

test('analyzes photos on the device without sending them anywhere', async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL ?? '').origin
  const unexpectedRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const isLocalResource = url.protocol === 'blob:' || url.protocol === 'data:'
    // 분석 Worker 스크립트도 앱과 같은 도메인의 정적 파일이다.
    const isAppAsset = url.origin === appOrigin && request.method() === 'GET' && !request.postData()
    if (!isLocalResource && !isAppAsset) unexpectedRequests.push(`${request.method()} ${request.url()}`)
  })

  await page.goto('/')
  await fileInput(page).setInputFiles([sharpScene, blurredScene])
  await expect(sharpnessSummary(page)).toHaveText('초점 불량 의심 1장', { timeout: 30_000 })

  expect(unexpectedRequests).toEqual([])
})
