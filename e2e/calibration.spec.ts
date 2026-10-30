import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { SHARP_RATIO_THRESHOLD } from '../src/photos/sharpness.ts'
import { gaussianBlur, motionBlur, renderScene, renderUniform } from '../src/test/syntheticImages.ts'
import { calibrationPort } from '../playwright.config.ts'
import { encodeGrayPng } from './support/grayPng.ts'

// 개발용 흐림 판정 평가 도구(평가 전용 빌드)를 실제 브라우저와 Web Worker로 확인한다.
// 실제 카메라 사진이 아니라 재현 가능한 합성 이미지이므로 도구의 동작만 검증하고 판정 정확도를 입증하지 않는다.
const calibrationUrl = `http://localhost:${calibrationPort}/calibration.html`

const png = (name: string, image: Parameters<typeof encodeGrayPng>[0]) => ({
  name,
  mimeType: 'image/png',
  buffer: encodeGrayPng(image),
})

const files = [
  png('alpha-sharp.png', gaussianBlur(renderScene(1600, 1200, 11), 0.8)),
  png('bravo-defocus.png', gaussianBlur(renderScene(1600, 1200, 11), 3)),
  png('charlie-shake.png', motionBlur(gaussianBlur(renderScene(1600, 1200, 13), 0.8), 24)),
  png('delta-wall.png', renderUniform(800, 600, 150)),
]

// 갤러리 낭독용 설명과 평가 도구의 판정 표기의 대응
const galleryToTool: Record<string, string> = {
  '흐림 의심 없음': '선명',
  '흐림 의심': '흐림 의심',
}

const rowOf = (page: Page, fileName: string) => page.getByRole('row').filter({ hasText: fileName })
const verdictCell = (page: Page, fileName: string) => rowOf(page, fileName).getByRole('cell').nth(3)
const scoreCell = (page: Page, fileName: string) => rowOf(page, fileName).getByRole('cell').nth(4)

test.describe.configure({ timeout: 60_000 })

test('shows the same verdicts as the gallery, with scores that match the threshold', async ({ page }) => {
  // 사용자 앱(배포 빌드)의 갤러리 판정
  await page.goto('/')
  await page.getByTestId('photo-file-input').setInputFiles(files)
  await expect(page.locator('[aria-live="polite"]')).not.toHaveText(/확인 중/, { timeout: 30_000 })
  const galleryVerdicts: Record<string, string> = {}
  for (const { name } of files) {
    const description = await page.getByRole('img', { name, exact: true }).evaluate(
      (image) => document.getElementById(image.getAttribute('aria-describedby') ?? '')?.textContent ?? '',
    )
    galleryVerdicts[name] = galleryToTool[description] ?? (description.startsWith('흐림 분석 불가') ? '분석 불가' : description)
  }

  // 같은 파일을 평가 도구로 분석
  await page.goto(calibrationUrl)
  await page.getByTestId('calibration-file-input').setInputFiles(files)
  await expect(page.getByRole('cell', { name: /^분석 중$/ })).toHaveCount(0, { timeout: 30_000 })

  for (const { name } of files) {
    await expect(verdictCell(page, name)).toContainText(galleryVerdicts[name]!)
    const scoreText = (await scoreCell(page, name).textContent())!.trim()
    if (galleryVerdicts[name] === '분석 불가') continue
    const score = Number(scoreText)
    expect(Number.isFinite(score), `${name} score ${scoreText}`).toBe(true)
    expect(score < SHARP_RATIO_THRESHOLD, name).toBe(galleryVerdicts[name] === '흐림 의심')
  }
  expect(galleryVerdicts['alpha-sharp.png']).toBe('선명')
  expect(galleryVerdicts['bravo-defocus.png']).toBe('흐림 의심')
  expect(galleryVerdicts['delta-wall.png']).toBe('분석 불가')
})

test('counts outcomes from labels and exports results without file names or network use', async ({ page }) => {
  const appOrigin = new URL(calibrationUrl).origin
  const unexpectedRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const isLocalResource = url.protocol === 'blob:' || url.protocol === 'data:'
    const isAppAsset = url.origin === appOrigin && request.method() === 'GET' && !request.postData()
    if (!isLocalResource && !isAppAsset) unexpectedRequests.push(`${request.method()} ${request.url()}`)
  })

  await page.goto(calibrationUrl)
  await page.getByTestId('calibration-file-input').setInputFiles(files.slice(0, 2))
  await expect(page.getByRole('cell', { name: /^분석 중$/ })).toHaveCount(0, { timeout: 30_000 })

  // 선명한 장면을 흐림으로, 흐린 장면을 흐림으로 라벨링한다(미탐 1, 정상 1).
  await rowOf(page, 'alpha-sharp.png').getByRole('combobox', { name: / 정답$/ }).selectOption('blurry')
  await rowOf(page, 'bravo-defocus.png').getByRole('combobox', { name: / 정답$/ }).selectOption('blurry')
  await expect(rowOf(page, 'alpha-sharp.png').getByRole('cell').nth(6)).toHaveText('미탐')
  await expect(page.getByText(/정답 있음 2장\(선명 0, 흐림 2\)/)).toBeVisible()
  await expect(page.getByText(/표본이 작습니다/)).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'JSON 내보내기' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^blur-evaluation-\d{8}-\d{6}\.json$/)
  const text = readFileSync((await download.path())!, 'utf8')
  for (const { name } of files) expect(text).not.toContain(name.replace('.png', ''))
  const report = JSON.parse(text)
  expect(report.summary.counts).toMatchObject({ truePositive: 1, falseNegative: 1, falsePositive: 0 })
  expect(report.photos.map((photo: { outcome: string }) => photo.outcome)).toEqual(['false-negative', 'true-positive'])
  expect(report.environment.userAgent).toBeNull()

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  expect(unexpectedRequests).toEqual([])
})

test('is not part of the production build users get', async ({ page }) => {
  // 기본 baseURL은 배포 빌드(dist)다.
  await page.goto('/calibration.html')
  await expect(page.getByRole('heading', { name: /흐림 판정 평가/ })).toHaveCount(0)
  const scripts = await page.locator('script[src]').evaluateAll((elements) => elements.map((element) => element.getAttribute('src')))
  expect(scripts.some((src) => src?.includes('calibration'))).toBe(false)
})
