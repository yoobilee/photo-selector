import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

const rowOf = (page: Page, fileName: string) => page.getByRole('row').filter({ hasText: fileName })
// 행 머리(사진) 다음 칸 순서: 정답, 촬영 조건, 장면 번호, 출처, 검토, 자동 판정, 점수, 잡음, 비교, 제거
const verdictCell = (page: Page, fileName: string) => rowOf(page, fileName).getByRole('cell').nth(5)
const scoreCell = (page: Page, fileName: string) => rowOf(page, fileName).getByRole('cell').nth(6)
const outcomeCell = (page: Page, fileName: string) => rowOf(page, fileName).getByRole('cell').nth(8)

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
  await expect(outcomeCell(page, 'alpha-sharp.png')).toHaveText('미탐')
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

test('links ground truth to photos by content hash and exports it without file names', async ({ page }) => {
  const appOrigin = new URL(calibrationUrl).origin
  const unexpectedRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    const isLocalResource = url.protocol === 'blob:' || url.protocol === 'data:'
    const isAppAsset = url.origin === appOrigin && request.method() === 'GET' && !request.postData()
    if (!isLocalResource && !isAppAsset) unexpectedRequests.push(`${request.method()} ${request.url()}`)
  })
  const [sharp, defocus, shake] = files as [(typeof files)[number], (typeof files)[number], (typeof files)[number]]
  const groundTruth = {
    format: 'photo-selector-blur-ground-truth',
    version: 1,
    hashAlgorithm: 'SHA-256',
    entries: [
      { sha256: sha256Of(defocus.buffer), label: 'blurry', condition: 'out-of-focus', origin: 'synthetic-edit', processing: '가우시안 흐림 σ=3', reviewed: true },
      { sha256: sha256Of(sharp.buffer), label: 'sharp', origin: 'synthetic-edit' },
      { sha256: sha256Of(shake.buffer), label: 'blurry' },
      { sha256: sha256Of(shake.buffer), label: 'sharp' },
      { sha256: sha256Of(Buffer.from('not loaded')), label: 'sharp' },
    ],
  }

  await page.goto(calibrationUrl)
  // 정답 데이터와 다른 순서로 사진을 불러온 뒤 정답 데이터를 불러온다.
  await page.getByTestId('calibration-file-input').setInputFiles([shake, defocus, sharp])
  await page.getByTestId('ground-truth-file-input').setInputFiles({
    name: 'truth.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(groundTruth)),
  })
  const panel = page.getByRole('region', { name: '정답 데이터' })
  await expect(panel.getByRole('status')).toHaveText(/사진에 적용할 수 있는 항목 3개.*충돌 1/)
  const count = (label: string) => panel.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]')
  await expect(count('정답 적용')).toHaveText('2장')
  await expect(count('충돌로 적용 안 함')).toHaveText('1장')
  await expect(count('불러온 사진에 없는 정답')).toHaveText('1개')

  const labelSelect = (fileName: string) => rowOf(page, fileName).getByRole('combobox', { name: / 정답$/ })
  await expect(labelSelect(defocus.name)).toHaveValue('blurry')
  await expect(rowOf(page, defocus.name).getByRole('combobox', { name: / 촬영 조건$/ })).toHaveValue('out-of-focus')
  await expect(labelSelect(sharp.name)).toHaveValue('sharp')
  await expect(labelSelect(shake.name)).toHaveValue('')
  await expect(rowOf(page, shake.name)).toContainText('정답 데이터 안에서 충돌 — 적용 안 함')

  // 충돌한 사진은 직접 고르고, 정답 데이터를 다시 내보낸다.
  await labelSelect(shake.name).selectOption('blurry')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.getByRole('button', { name: '정답 데이터 내보내기' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^blur-ground-truth-\d{8}-\d{6}\.json$/)
  const text = readFileSync((await download.path())!, 'utf8')
  for (const { name } of files) expect(text).not.toContain(name.replace('.png', ''))
  const exported = JSON.parse(text)
  const labels = Object.fromEntries(exported.entries.map((entry: { sha256: string; label: string }) => [entry.sha256, entry.label]))
  expect(labels).toEqual({
    [sha256Of(sharp.buffer)]: 'sharp',
    [sha256Of(defocus.buffer)]: 'blurry',
    [sha256Of(shake.buffer)]: 'blurry',
    [sha256Of(Buffer.from('not loaded'))]: 'sharp',
  })

  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  expect(unexpectedRequests).toEqual([])
})

test('removes rows with the keyboard without losing focus', async ({ page }) => {
  await page.goto(calibrationUrl)
  await page.getByTestId('calibration-file-input').setInputFiles(files.slice(0, 2))
  const removeButtons = page.getByRole('button', { name: / 평가에서 제거$/ })
  await expect(removeButtons).toHaveCount(2)

  await removeButtons.first().focus()
  await page.keyboard.press('Enter')
  await expect(removeButtons).toHaveCount(1)
  await expect(removeButtons.first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '사진 불러오기' })).toBeFocused()
})

// 표 안의 화면 밖 글자(sr-only)가 가로 스크롤 영역을 벗어나 모바일에서 화면 전체가 넓어지던 문제의 회귀 검사
test('keeps the page within the screen width when the wide table is shown', async ({ page }) => {
  await page.goto(calibrationUrl)
  await page.getByTestId('calibration-file-input').setInputFiles(files.slice(0, 1))
  await expect(page.getByRole('button', { name: / 평가에서 제거$/ })).toHaveCount(1)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBe(0)
})

test('is not part of the production build users get', async ({ page }) => {
  // 기본 baseURL은 배포 빌드(dist)다.
  await page.goto('/calibration.html')
  await expect(page.getByRole('heading', { name: /흐림 판정 평가/ })).toHaveCount(0)
  const scripts = await page.locator('script[src]').evaluateAll((elements) => elements.map((element) => element.getAttribute('src')))
  expect(scripts.some((src) => src?.includes('calibration'))).toBe(false)

  // 정답 데이터·해시 계산 코드도 배포 빌드 묶음에 없다.
  const assetsDirectory = fileURLToPath(new URL('../dist/assets/', import.meta.url))
  const bundles = readdirSync(assetsDirectory).filter((name) => name.endsWith('.js'))
  expect(bundles.length).toBeGreaterThan(0)
  for (const name of bundles) {
    const source = readFileSync(assetsDirectory + name, 'utf8')
    expect(source, name).not.toContain('photo-selector-blur-ground-truth')
    expect(source, name).not.toContain('SHA-256')
  }
})
