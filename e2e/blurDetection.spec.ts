import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  gaussianBlur,
  motionBlur,
  renderGradient,
  renderScene,
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

const sharpScene = png('sharp-scene.png', gaussianBlur(renderScene(1600, 1200, 11), 0.8))
// 2048보다 커서 두 배 크기로 그린 뒤 평균으로 줄이는 경로를 탄다.
const largeSharpScene = png('large-sharp-scene.png', gaussianBlur(renderScene(2400, 1800, 11), 1))
const smallSharpScene = png('small-sharp-scene.png', gaussianBlur(renderScene(320, 240, 11), 0.8))
const blurredScene = png('blurred-scene.png', gaussianBlur(renderScene(1600, 1200, 11), 3))
const largeBlurredScene = png('large-blurred-scene.png', gaussianBlur(renderScene(2400, 1800, 12), 6))
const shakenScene = png('shaken-scene.png', motionBlur(gaussianBlur(renderScene(1600, 1200, 13), 0.8), 24))
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
// 사진 위에 겹친 시각 표시. 같은 내용의 낭독용 설명은 accessible description으로 따로 확인한다.
const badge = (page: Page, name: string) => photoCard(page, name).getByTestId('sharpness-badge')
const sharpnessSummary = (page: Page) => page.locator('[aria-live="polite"]')

test.describe.configure({ timeout: 60_000 })

test('flags blurred photos, marks undecidable ones and leaves sharp photos unbadged', async ({ page }) => {
  await page.goto('/')
  await fileInput(page).setInputFiles([
    sharpScene,
    largeSharpScene,
    smallSharpScene,
    blurredScene,
    largeBlurredScene,
    shakenScene,
    plainWall,
    clearSky,
    sunrise,
  ])

  await expect(sharpnessSummary(page)).toHaveText('흐림 의심 3장 · 분석 불가 2장', { timeout: 30_000 })

  for (const name of ['blurred-scene.png', 'large-blurred-scene.png', 'shaken-scene.png']) {
    await expect(photo(page, name)).toHaveAccessibleDescription('흐림 의심')
    await expect(badge(page, name)).toHaveText('흐림 의심')
  }
  for (const name of ['sharp-scene.png', 'large-sharp-scene.png', 'small-sharp-scene.png', 'sunrise.jpg']) {
    await expect(photo(page, name)).toHaveAccessibleDescription('흐림 의심 없음')
    await expect(badge(page, name)).toHaveCount(0)
  }
  // 균일한 벽·맑은 하늘은 흐림으로 단정하지 않는다.
  for (const name of ['plain-wall.png', 'clear-sky.png']) {
    await expect(photo(page, name)).toHaveAccessibleDescription(/^흐림 분석 불가: 윤곽이 적거나/)
    await expect(badge(page, name)).toHaveText('분석 불가')
  }

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
  await expect(sharpnessSummary(page)).toHaveText('흐림 의심 2장', { timeout: 30_000 })
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
  await expect(sharpnessSummary(page)).toHaveText('흐림 의심 1장', { timeout: 30_000 })

  expect(unexpectedRequests).toEqual([])
})
