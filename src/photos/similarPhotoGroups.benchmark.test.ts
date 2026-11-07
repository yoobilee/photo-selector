// 비슷한 사진 묶음 계산의 성능 측정. 기본 테스트에서는 건너뛰고 다음처럼 따로 실행한다.
//   SIMILARITY_BENCHMARK=1 npx vitest run src/photos/similarPhotoGroups.benchmark.test.ts
// 합성 장면이라 실제 사진 모음의 pHash 분포·후보 수와 다를 수 있다. 측정 기기에 따라 값이 크게 달라진다.
import { describe, expect, it } from 'vitest'
import { cropImage } from '../test/photoVariants.ts'
import { gaussianBlur, renderScene } from '../test/syntheticImages.ts'
import { evaluateAnalysisImage } from './analyzeImageSharpness.ts'
import { createPhotoFingerprint, type PhotoFingerprint } from './photoFingerprint.ts'
import { createSimilarityIndex } from './similarPhotoGroups.ts'

const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const WIDTH = 256
const HEIGHT = 192

const fingerprint = (image: Parameters<typeof createPhotoFingerprint>[0]) => createPhotoFingerprint(image)!

// 사진의 60%는 5장씩 연속 촬영(조금씩 이동), 나머지는 서로 다른 장면이다.
function mixedLibrary(count: number): Map<string, PhotoFingerprint> {
  const entries = new Map<string, PhotoFingerprint>()
  let seed = 1000
  while (entries.size < count) {
    seed += 1
    if (entries.size < count * 0.6) {
      const wide = gaussianBlur(renderScene(Math.round(WIDTH * 1.1), Math.round(HEIGHT * 1.1), seed), 0.8)
      for (let shot = 0; shot < 5 && entries.size < count; shot += 1) {
        entries.set(`photo-${entries.size}`, fingerprint(cropImage(wide, shot * 3, shot * 2, WIDTH, HEIGHT)))
      }
    } else {
      entries.set(`photo-${entries.size}`, fingerprint(gaussianBlur(renderScene(WIDTH, HEIGHT, seed), 0.8)))
    }
  }
  return entries
}

// 가장 나쁜 경우: 같은 장면을 조금씩 옮겨 계속 찍어 모든 사진이 서로 pHash 후보다.
function staticSceneLibrary(count: number): Map<string, PhotoFingerprint> {
  const wide = gaussianBlur(renderScene(WIDTH + 40, HEIGHT + 30, 7), 0.8)
  const entries = new Map<string, PhotoFingerprint>()
  for (let index = 0; index < count; index += 1) {
    entries.set(`photo-${index}`, fingerprint(cropImage(wide, (index * 7) % 40, (index * 3) % 30, WIDTH, HEIGHT)))
  }
  return entries
}

// 여러 번 실행한 시간(ms)의 중앙값
function medianMs(run: () => void, repeat: number): number {
  const times: number[] = []
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const start = performance.now()
    run()
    times.push(performance.now() - start)
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!
}

describe.runIf(environment?.SIMILARITY_BENCHMARK)('similar photo grouping benchmark', () => {
  it('measures grouping from scratch, one incoming photo and the slowest time slice', { timeout: 600_000 }, () => {
    const rows: Record<string, string | number>[] = []
    const scenarios: [string, Map<string, PhotoFingerprint>][] = [
      ['mixed 100', mixedLibrary(100)],
      ['mixed 500', mixedLibrary(500)],
      ['mixed 1000', mixedLibrary(1000)],
      ['one static scene 500', staticSceneLibrary(500)],
      ['one static scene 1000', staticSceneLibrary(1000)],
    ]
    for (const [name, entries] of scenarios) {
      // 처음부터: 모든 지문을 맞추고 비교를 끝낸 뒤 묶음을 만든다(총 계산량).
      let comparisons = 0
      let groups = 0
      const fromScratch = medianMs(() => {
        const index = createSimilarityIndex()
        index.sync(entries)
        index.work(Number.POSITIVE_INFINITY)
        groups = index.groups().length
        comparisons = index.comparisonCount
      }, 3)

      // 앱에서 실제로 일어나는 일: 분석이 끝난 사진이 한 장씩 들어오고 8ms 조각으로 비교한다. 가장 긴 조각을 잰다.
      const index = createSimilarityIndex()
      const growing = new Map<string, PhotoFingerprint>()
      let longestSlice = 0
      let longestSync = 0
      let longestGroups = 0
      for (const [id, value] of entries) {
        growing.set(id, value)
        const syncStart = performance.now()
        index.sync(growing)
        longestSync = Math.max(longestSync, performance.now() - syncStart)
        let done = false
        while (!done) {
          const sliceStart = performance.now()
          done = index.work(8)
          longestSlice = Math.max(longestSlice, performance.now() - sliceStart)
        }
        const groupsStart = performance.now()
        index.groups()
        longestGroups = Math.max(longestGroups, performance.now() - groupsStart)
      }
      const crowded = [...entries.keys()].filter((id) => index.statusOf(id) === 'crowded').length
      rows.push({
        scenario: name,
        'from scratch ms': Number(fromScratch.toFixed(1)),
        comparisons,
        groups,
        crowded,
        'longest sync ms': Number(longestSync.toFixed(2)),
        'longest 8ms slice ms': Number(longestSlice.toFixed(2)),
        'longest groups() ms': Number(longestGroups.toFixed(2)),
      })
    }

    const image = gaussianBlur(renderScene(1024, 768, 3), 0.8)
    rows.push({ scenario: 'worker: fingerprint 1024×768', 'from scratch ms': Number(medianMs(() => createPhotoFingerprint(image), 21).toFixed(2)) })
    rows.push({ scenario: 'worker: blur evaluation 1024×768', 'from scratch ms': Number(medianMs(() => evaluateAnalysisImage(image), 5).toFixed(1)) })

    console.table(rows)
    expect(rows.length).toBeGreaterThan(0)
  })
})
