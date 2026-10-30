import { MIN_RELIABLE_CLASS_SIZE, type EvaluationSummary, type Proportion } from './evaluationMetrics.ts'
import { formatInterval, formatProportion } from './evaluationText.ts'

interface MetricRow {
  readonly name: string
  readonly definition: string
  readonly value: Proportion
}

function MetricTable({ caption, rows }: { caption: string; rows: readonly MetricRow[] }) {
  return (
    <table className="mt-3 w-full text-left text-sm">
      <caption className="text-left font-semibold text-neutral-900">{caption}</caption>
      <thead>
        <tr className="border-b border-neutral-300 text-neutral-700">
          <th scope="col" className="py-1 pr-3 font-medium">지표</th>
          <th scope="col" className="py-1 pr-3 font-medium">값</th>
          <th scope="col" className="py-1 pr-3 font-medium">95% 신뢰구간</th>
          <th scope="col" className="py-1 font-medium">정의</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className="border-b border-neutral-200 align-top">
            <th scope="row" className="py-1 pr-3 font-medium">{row.name}</th>
            <td className="py-1 pr-3 tabular-nums">{formatProportion(row.value)}</td>
            <td className="py-1 pr-3 tabular-nums">{formatInterval(row.value)}</td>
            <td className="py-1 text-neutral-700">{row.definition}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// 평가 통계. 판정한 사진 기준 성능은 판정 가능 비율, 분석 불가를 포함한 전체 기준 성능과 함께 보여 준다.
function EvaluationSummaryPanel({ summary }: { summary: EvaluationSummary }) {
  const { counts, labeled } = summary
  return (
    <section aria-labelledby="evaluation-summary-heading" className="rounded-md border border-neutral-300 bg-white p-4">
      <h2 id="evaluation-summary-heading" className="text-lg font-bold text-neutral-950">
        평가 결과
      </h2>
      <p className="mt-1 text-sm text-neutral-700">
        전체 {summary.total}장 · 정답 있음 {labeled.total}장(선명 {labeled.sharp}, 흐림 {labeled.blurry}) · 판단 보류{' '}
        {summary.unsure}장 · 정답 없음 {summary.unlabeled}장
        {summary.pending > 0 && ` · 정답 있는 사진 중 분석 중 ${summary.pending}장`}
      </p>

      {summary.pending > 0 && (
        <p className="mt-2 text-sm font-medium text-amber-950">
          분석 중인 사진은 통계에 넣지 않았습니다. 분석이 끝나면 통계가 바뀝니다.
        </p>
      )}
      {summary.smallSample && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
          표본이 작습니다(선명 {labeled.sharp}장, 흐림 {labeled.blurry}장 — 정답별 {MIN_RELIABLE_CLASS_SIZE}장 미만).
          신뢰구간이 넓으므로 아래 수치는 참고용이며 정확도를 입증하지 않습니다.
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-neutral-700">정상 판정</dt>
          <dd className="font-semibold tabular-nums">
            {counts.truePositive + counts.trueNegative}장 (흐림 {counts.truePositive}, 선명 {counts.trueNegative})
          </dd>
        </div>
        <div>
          <dt className="text-neutral-700">오탐(선명 → 흐림 의심)</dt>
          <dd className="font-semibold tabular-nums">{counts.falsePositive}장</dd>
        </div>
        <div>
          <dt className="text-neutral-700">미탐(흐림 → 선명)</dt>
          <dd className="font-semibold tabular-nums">{counts.falseNegative}장</dd>
        </div>
        <div>
          <dt className="text-neutral-700">분석 불가</dt>
          <dd className="font-semibold tabular-nums">
            {counts.unavailableSharp + counts.unavailableBlurry}장 (선명 {counts.unavailableSharp}, 흐림{' '}
            {counts.unavailableBlurry})
          </dd>
        </div>
      </dl>

      <MetricTable
        caption="판정 가능 비율"
        rows={[
          { name: '전체', definition: '정답 있는 사진 중 선명·흐림으로 판정한 비율', value: summary.coverage.all },
          { name: '선명 사진', definition: '선명 정답 중 판정한 비율', value: summary.coverage.sharp },
          { name: '흐린 사진', definition: '흐림 정답 중 판정한 비율', value: summary.coverage.blurry },
        ]}
      />
      <MetricTable
        caption="판정한 사진 기준(분석 불가 제외 — 판정 가능 비율과 함께 볼 것)"
        rows={[
          { name: '정확도', definition: '(정상 판정) / 판정한 사진', value: summary.judged.accuracy },
          { name: '정밀도', definition: '흐림 의심 중 실제 흐림', value: summary.judged.precision },
          { name: '재현율', definition: '판정한 흐린 사진 중 흐림 의심으로 표시', value: summary.judged.recall },
          { name: '오탐률', definition: '판정한 선명 사진 중 흐림 의심으로 표시', value: summary.judged.falsePositiveRate },
        ]}
      />
      <MetricTable
        caption="전체 기준(분석 불가 포함, 분석 불가는 맞히지 못한 것으로 계산)"
        rows={[
          { name: '정확도', definition: '(정상 판정) / 정답 있는 전체', value: summary.overall.accuracy },
          { name: '재현율', definition: '흐린 사진 중 흐림 의심으로 표시(분석 불가는 놓침)', value: summary.overall.recall },
          { name: '오탐률', definition: '선명 사진 중 흐림 의심으로 표시', value: summary.overall.falsePositiveRate },
        ]}
      />
    </section>
  )
}

export default EvaluationSummaryPanel
