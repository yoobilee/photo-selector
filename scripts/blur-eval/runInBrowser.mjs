// 개발용 실제 사진 흐림 평가: 평가 목록(manifest)의 사진을 실제 브라우저에서 제품과 같은 경로로 분석한다.
// - 제품 경로: createSharpnessWorkerAnalyzer().measure(파일) → Worker 디코딩·측정·판정(사용자 화면과 같은 함수)
// - --cache-dir를 주면 같은 사진을 제품의 decodeAnalysisImage로 한 번 더 디코딩해 분석용 밝기 이미지를 저장한다
//   (Node에서 알고리즘 후보를 반복 비교할 때 사진을 다시 디코딩하지 않으려는 용도. 1/256 고정소수점 Uint16).
// 사진은 로컬 파일을 Playwright 요청 가로채기로만 페이지에 전달한다. 외부로 보내지 않는다.
//
// 사용: node scripts/blur-eval/runInBrowser.mjs --manifest <manifest.json> --out <result.json>
//         [--browser chromium|webkit] [--cache-dir <dir>] [--only-split dev|holdout] [--limit N]
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { chromium, webkit, devices } from '@playwright/test'
import { createServer } from 'vite'

const { values: args } = parseArgs({
  options: {
    manifest: { type: 'string' },
    out: { type: 'string' },
    browser: { type: 'string', default: 'chromium' },
    'cache-dir': { type: 'string' },
    'only-split': { type: 'string' },
    limit: { type: 'string' },
    port: { type: 'string', default: '5199' },
    // 축소 영향 비교: 제품 분석을 건너뛰고 이 긴 변 크기로 디코딩한 밝기 이미지만 저장한다.
    'max-edge': { type: 'string' },
  },
})
const maxEdge = args['max-edge'] ? Number(args['max-edge']) : null
if (maxEdge && !args['cache-dir']) throw new Error('--max-edge needs --cache-dir')
if (!args.manifest || !args.out) throw new Error('--manifest and --out are required')

const manifest = JSON.parse(await readFile(args.manifest, 'utf8'))
let items = manifest.items.filter((item) => !args['only-split'] || item.split === args['only-split'])
if (args.limit) items = items.slice(0, Number(args.limit))

// 데스크톱은 Desktop Chrome, 모바일은 iPhone 15(WebKit) 설정. WebKit은 실제 iOS Safari를 대체하지 않는다.
const profiles = {
  chromium: { engine: chromium, device: devices['Desktop Chrome'] },
  webkit: { engine: webkit, device: devices['iPhone 15'] },
}
const profile = profiles[args.browser]
if (!profile) throw new Error(`unknown browser ${args.browser}`)

const port = Number(args.port)
// 파일 변경 감시·HMR을 끈다. 평가 중 저장소 파일을 고치면 페이지가 다시 불러와져 실행이 끊긴다.
const server = await createServer({ server: { port, strictPort: true, hmr: false, watch: null }, logLevel: 'error' })
await server.listen()
const browser = await profile.engine.launch()
const context = await browser.newContext({ ...profile.device })
const page = await context.newPage()
const byToken = new Map(items.map((item, index) => [`p${index}`, item]))
await page.route(`http://localhost:${port}/__eval/**`, async (route) => {
  const token = new URL(route.request().url()).pathname.split('/').pop()
  const item = byToken.get(token)
  if (!item) return route.fulfill({ status: 404 })
  return route.fulfill({ status: 200, body: await readFile(item.path), contentType: item.contentType })
})
await page.goto(`http://localhost:${port}/calibration.html`)
await page.evaluate(async () => {
  const client = await import('/src/photos/sharpnessWorkerClient.ts')
  const decode = await import('/src/photos/analyzeImageSharpness.ts')
  const sharpness = await import('/src/photos/sharpness.ts')
  // 제품과 같은 캔버스를 쓴다. OffscreenCanvas가 없는 브라우저(예: Windows용 Playwright WebKit)는 canvas 요소로 디코딩한다.
  const createElementContext = (width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas.getContext('2d', { willReadFrequently: true })
  }
  const createContext = typeof OffscreenCanvas === 'undefined' ? createElementContext : decode.createOffscreenContext
  const decoder = { ...decode, createContext, toGrayscaleForEval: sharpness.toGrayscale, downsampleForEval: sharpness.downsampleByAverage }
  const state = { analyzer: client.createSharpnessWorkerAnalyzer(), decoder, path: client.getAnalysisPath() }
  Object.assign(globalThis, { __blurEval: state })
})
const analysisPath = await page.evaluate(() => globalThis.__blurEval.path)
const userAgent = await page.evaluate(() => navigator.userAgent)

if (args['cache-dir']) await mkdir(args['cache-dir'], { recursive: true })
const exists = (path) => access(path).then(() => true, () => false)

const results = []
let cacheFailures = 0
const started = performance.now()
for (const [index, item] of items.entries()) {
  const token = `p${index}`
  const cachePath = args['cache-dir'] ? join(args['cache-dir'], `${item.id}.u16`) : null
  const wantCache = cachePath !== null && !(await exists(cachePath))
  // 축소 비교 모드는 캐시만 만들므로 이미 있는 사진은 건너뛴다(중단된 실행 이어 하기).
  if (maxEdge && !wantCache) continue
  const row = await page.evaluate(
    async ({ url, wantCache, maxEdge }) => {
      const { analyzer, decoder } = globalThis.__blurEval
      const file = await (await fetch(url)).blob()
      let result = null
      let measurement = null
      let analysisMs = null
      if (!maxEdge) {
        const begin = performance.now()
        ;({ result, measurement } = await analyzer.measure(file))
        analysisMs = performance.now() - begin
      }
      // 축소 영향 비교용: 분석 크기만 바꾸고 제품과 같은 방식(2배로 그린 뒤 2×2 평균)으로 디코딩한다.
      const decodeAt = async (edge) => {
        const bitmap = await createImageBitmap(file)
        try {
          const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
          const width = Math.round(bitmap.width * scale)
          const height = Math.round(bitmap.height * scale)
          const factor = bitmap.width >= width * 2 && bitmap.height >= height * 2 ? 2 : 1
          const context = decoder.createContext(width * factor, height * factor)
          const canvas = context.canvas
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.imageSmoothingQuality = 'high'
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const gray = decoder.toGrayscaleForEval(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
          return factor === 2 ? decoder.downsampleForEval(gray, 2) : gray
        } finally {
          bitmap.close()
        }
      }
      let cache = null
      let cacheFailed = false
      if (wantCache) {
        // 캐시는 부가 산출물이다. 디코딩할 수 없는 사진은 제품 경로 결과(분석 불가 failed)를 그대로 남기고 캐시만 건너뛴다.
        let image = null
        try {
          image = maxEdge ? await decodeAt(maxEdge) : await decoder.decodeAnalysisImage(file, decoder.createContext)
        } catch {
          cacheFailed = true
        }
        if (image) {
          const fixed = new Uint16Array(image.pixels.length)
          for (let i = 0; i < fixed.length; i += 1) fixed[i] = Math.round(image.pixels[i] * 256)
          const bytes = new Uint8Array(fixed.buffer)
          let binary = ''
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          cache = { width: image.width, height: image.height, base64: btoa(binary) }
        }
      }
      return { result, measurement, analysisMs, cache, cacheFailed }
    },
    { url: `http://localhost:${port}/__eval/${token}`, wantCache, maxEdge },
  )
  if (row.cache && cachePath) {
    await writeFile(cachePath, Buffer.from(row.cache.base64, 'base64'))
    await writeFile(`${cachePath}.json`, JSON.stringify({ width: row.cache.width, height: row.cache.height }))
  }
  if (row.cacheFailed) {
    cacheFailures += 1
    console.log(`cache skipped (decode failed): ${item.id}`)
  }
  // 축소 비교 모드는 제품 판정을 하지 않으므로 결과 행을 남기지 않는다.
  if (!maxEdge) results.push({ id: item.id, result: row.result, measurement: row.measurement, analysisMs: row.analysisMs })
  if ((index + 1) % 50 === 0) console.log(`${args.browser}: ${index + 1}/${items.length}`)
}
const totalSeconds = (performance.now() - started) / 1000

await writeFile(
  args.out,
  JSON.stringify(
    { browser: args.browser, device: args.browser === 'webkit' ? 'iPhone 15 (Playwright WebKit)' : 'Desktop Chrome', userAgent, analysisPath, totalSeconds, cacheFailures, results },
    null,
    1,
  ),
)
await browser.close()
await server.close()
console.log(`done ${results.length} photos (cache failures ${cacheFailures}) in ${totalSeconds.toFixed(1)}s → ${args.out}`)
