// 개발용 실제 사진 흐림 평가: runInBrowser.mjs가 저장한 분석용 밝기 이미지(브라우저에서 제품 경로로 디코딩)를
// Node에서 다시 판정해 데이터셋·분할·정답 종류별 지표를 낸다. 같은 이미지로 판정 규칙 후보를 반복 비교하는 용도다.
// 판정은 --classifier 모듈의 `judge(image) → { verdict, cause, measurement }`로 한다. 기본은 현재 제품 판정이다.
//
// 사용: node scripts/blur-eval/evaluateCache.mjs --manifest <manifest.json> --cache-dir <dir> [--split dev|holdout]
//         [--classifier <module>] [--out <rows.json>]
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { loadCachedImage } from './cachedImage.mjs'
import { summarize, formatSummary } from './metrics.mjs'

const { values: args } = parseArgs({
  options: {
    manifest: { type: 'string' },
    'cache-dir': { type: 'string' },
    split: { type: 'string' },
    classifier: { type: 'string' },
    out: { type: 'string' },
  },
})
if (!args.manifest || !args['cache-dir']) throw new Error('--manifest and --cache-dir are required')

const classifierUrl = args.classifier
  ? pathToFileURL(resolve(args.classifier)).href
  : new URL('./currentClassifier.mjs', import.meta.url).href
const { judge } = await import(classifierUrl)

const manifest = JSON.parse(await readFile(args.manifest, 'utf8'))
const items = manifest.items.filter((item) => !args.split || item.split === args.split)

const rows = []
let measureMs = 0
for (const item of items) {
  const image = await loadCachedImage(args['cache-dir'], item.id)
  if (!image) {
    rows.push({ ...item, verdict: 'missing' })
    continue
  }
  const begin = performance.now()
  const { verdict, cause, measurement, detail } = judge(image)
  measureMs += performance.now() - begin
  rows.push({ id: item.id, dataset: item.dataset, scene: item.scene, split: item.split, kind: item.kind, device: item.device, verdict, cause, measurement, detail })
}

console.log(formatSummary(summarize(rows)))
console.log(`judge time: ${(measureMs / Math.max(1, rows.length)).toFixed(1)} ms/photo (Node)`)
if (args.out) await writeFile(args.out, JSON.stringify(rows))
