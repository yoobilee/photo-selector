// runInBrowser.mjs 결과(제품 경로 판정)를 평가 목록의 정답과 연결해 지표를 낸다. --compare를 주면 두 실행의 판정 일치를 본다.
//
// 사용: node scripts/blur-eval/summarizeBrowserRun.mjs --manifest <manifest.json> --run <result.json>
//         [--split dev|holdout] [--compare <다른 result.json>]
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { formatSummary, summarize } from './metrics.mjs'

const { values: args } = parseArgs({
  options: { manifest: { type: 'string' }, run: { type: 'string' }, split: { type: 'string' }, compare: { type: 'string' } },
})
if (!args.manifest || !args.run) throw new Error('--manifest and --run are required')

const manifest = JSON.parse(await readFile(args.manifest, 'utf8'))
const byId = new Map(manifest.items.map((item) => [item.id, item]))
const load = async (path) => JSON.parse(await readFile(path, 'utf8'))

// 제품 결과를 판정 하나로 바꾼다. low-detail 외의 분석 불가 사유는 그대로 남긴다.
const verdictOf = ({ result }) =>
  result.status === 'unavailable' ? (result.reason === 'low-detail' ? 'low-detail' : `unavailable-${result.reason}`) : result.status

function toRows(run) {
  return run.results
    .map((entry) => ({ entry, item: byId.get(entry.id) }))
    .filter(({ item }) => item && (!args.split || item.split === args.split))
    .map(({ entry, item }) => ({
      ...item,
      verdict: verdictOf(entry).startsWith('unavailable-') ? 'low-detail' : verdictOf(entry),
      rawVerdict: verdictOf(entry),
      cause: entry.result.status === 'blurry' ? entry.result.cause : null,
      measurement: entry.measurement,
      analysisMs: entry.analysisMs,
    }))
}

const formatScore = (row) => {
  const score = row.measurement?.score
  return typeof score === 'number' ? score.toFixed(4) : String(score ?? null)
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

const run = await load(args.run)
const rows = toRows(run)
console.log(`${run.device} (${run.analysisPath}), ${rows.length} photos`)
console.log(formatSummary(summarize(rows)))

const otherReasons = {}
for (const row of rows) if (row.rawVerdict.startsWith('unavailable-')) otherReasons[row.rawVerdict] = (otherReasons[row.rawVerdict] ?? 0) + 1
console.log('low-detail 외 분석 불가:', otherReasons)

const causes = {}
for (const row of rows.filter((row) => row.verdict === 'blurry')) {
  const key = `${row.kind}→${row.cause}`
  causes[key] = (causes[key] ?? 0) + 1
}
console.log('흐림 판정의 원인 추정(정답 종류→추정):', causes)

const times = rows.map((row) => row.analysisMs).filter((value) => typeof value === 'number')
if (times.length) {
  console.log(
    `분석 시간(ms, Worker 디코딩 포함): 중앙값 ${percentile(times, 0.5).toFixed(0)}, 95% ${percentile(times, 0.95).toFixed(0)}, 최대 ${Math.max(...times).toFixed(0)}`,
  )
}

if (args.compare) {
  const other = new Map(toRows(await load(args.compare)).map((row) => [row.id, row]))
  let same = 0
  let total = 0
  const differences = []
  for (const row of rows) {
    const pair = other.get(row.id)
    if (!pair) continue
    total += 1
    if (pair.rawVerdict === row.rawVerdict && pair.cause === row.cause) same += 1
    else differences.push(`${row.id}: ${row.rawVerdict}/${row.cause} ↔ ${pair.rawVerdict}/${pair.cause} (score ${formatScore(row)} ↔ ${formatScore(pair)})`)
  }
  console.log(`판정·원인 일치: ${same}/${total}`)
  for (const line of differences) console.log(`  ${line}`)
}
