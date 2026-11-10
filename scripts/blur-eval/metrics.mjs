// 실제 사진 흐림 평가 지표. 분석 불가(low-detail)는 분모에 남긴다(분석 불가를 빼고 정확도를 올리지 않는다).
// - 선명 정답: 오탐률 = 흐림 판정 / 전체, 분석 불가율 = 분석 불가 / 전체
// - 흐림 정답(defocus·motion): 검출률 = 흐림 판정 / 전체, 선명 미검출 = 선명 판정 / 전체, 분석 불가율
// 비율에는 Wilson 95% 구간을 붙인다. 데이터셋 정답은 자료 제작자의 촬영 의도 라벨이며 사람이 다시 검토한 값이 아니다.

export function wilson(successes, total) {
  if (total === 0) return [Number.NaN, Number.NaN]
  const z = 1.959964
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

const toOutcome = (verdict) => (verdict === 'low-detail' ? 'unavailable' : verdict)

export function summarize(rows) {
  const groups = new Map()
  const add = (key, row) => {
    const group = groups.get(key) ?? { total: 0, sharp: 0, blurry: 0, unavailable: 0, missing: 0, unavailableNoScore: 0, unavailableUnjudged: 0 }
    const outcome = toOutcome(row.verdict)
    groups.set(key, group)
    // 캐시가 없는 사진(디코딩 전·실패)은 따로 세고 분모에 넣지 않는다.
    if (outcome === 'missing') {
      group.missing += 1
      return
    }
    group.total += 1
    group[outcome] += 1
    if (outcome === 'unavailable') {
      if (row.measurement?.score === null) group.unavailableNoScore += 1
      else group.unavailableUnjudged += 1
    }
    groups.set(key, group)
  }
  for (const row of rows) {
    add(`${row.dataset}|${row.split}|${row.kind}`, row)
    add(`all|${row.split}|${row.kind}`, row)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const [dataset, split, kind] = key.split('|')
    return { dataset, split, kind, ...group }
  })
}

const percent = (count, total) => (total ? `${((100 * count) / total).toFixed(1)}%` : '-')
const interval = (count, total) => {
  const [low, high] = wilson(count, total)
  return total ? `[${(100 * low).toFixed(1)}, ${(100 * high).toFixed(1)}]` : ''
}

export function formatSummary(groups) {
  const lines = ['dataset   split    kind     n    | 흐림 판정(검출/오탐)          | 선명 판정 | 분석 불가(점수없음/미판정방향)']
  for (const group of groups) {
    const { dataset, split, kind, total, sharp, blurry, unavailable, missing } = group
    lines.push(
      `${dataset.padEnd(9)} ${split.padEnd(8)} ${kind.padEnd(8)} ${String(total).padStart(4)} | ` +
        `${String(blurry).padStart(3)} ${percent(blurry, total).padStart(6)} ${interval(blurry, total).padEnd(14)} | ` +
        `${String(sharp).padStart(3)} ${percent(sharp, total).padStart(6)} | ` +
        `${String(unavailable).padStart(3)} ${percent(unavailable, total).padStart(6)} (${group.unavailableNoScore}/${group.unavailableUnjudged})` +
        (missing ? ` missing ${missing}` : ''),
    )
  }
  return lines.join('\n')
}
