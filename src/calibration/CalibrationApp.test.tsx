import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharpnessAnalysis } from '../photos/analyzeImageSharpness.ts'
import { createImageFile, readBytes } from '../test/imageFiles.ts'
import { installObjectUrlTracker } from '../test/objectUrls.ts'
import CalibrationApp from './CalibrationApp.tsx'

// jsdom은 이미지를 디코딩하지 못하므로 미리보기 생성만 대체한다.
vi.mock('../photos/createPhotoThumbnail.ts', () => ({
  createPhotoThumbnail: vi.fn(async () => ({ blob: new Blob(['thumbnail']), width: 400, height: 300 })),
}))

// 실제 Worker 대신 테스트에서 직접 끝내는 분석기. 평가 도구는 measure(판정 + 측정값)만 써야 한다.
const analyzer = vi.hoisted(() => ({
  pending: [] as { file: Blob; resolve: (analysis: SharpnessAnalysis) => void }[],
  measured: [] as Blob[],
  analyzeCalls: 0,
  disposeCount: 0,
}))
vi.mock('../photos/sharpnessWorkerClient.ts', () => ({
  getAnalysisPath: () => 'worker',
  createSharpnessWorkerAnalyzer: () => ({
    analyze: () => {
      analyzer.analyzeCalls += 1
      return new Promise(() => {})
    },
    measure: (file: Blob) =>
      new Promise<SharpnessAnalysis>((resolve) => {
        analyzer.measured.push(file)
        analyzer.pending.push({ file, resolve })
      }),
    dispose: () => {
      analyzer.disposeCount += 1
    },
  }),
}))

// 내보낸 파일 내용을 확인한다. 파일 이름 규칙은 실제 함수를 쓴다.
const downloads = vi.hoisted(() => [] as { fileName: string; mimeType: string; text: string }[])
vi.mock('./downloadText.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./downloadText.ts')>()),
  downloadText: (fileName: string, mimeType: string, text: string) => downloads.push({ fileName, mimeType, text }),
}))

const SHARP: SharpnessAnalysis = { result: { status: 'sharp' }, measurement: { score: 0.0812, hasUnjudgedDirection: false, noise: 0.21 } }
const BLURRY: SharpnessAnalysis = { result: { status: 'blurry' }, measurement: { score: 0.0123, hasUnjudgedDirection: false, noise: 0.05 } }
const LOW_DETAIL: SharpnessAnalysis = {
  result: { status: 'unavailable', reason: 'low-detail' },
  measurement: { score: null, hasUnjudgedDirection: false, noise: 2.1 },
}

const measuredNames = () => analyzer.measured.map((file) => (file as File).name)

function selectFiles(files: File[]) {
  fireEvent.change(screen.getByTestId('calibration-file-input'), { target: { files } })
}

async function finishMeasure(name: string, analysis: SharpnessAnalysis) {
  await waitFor(() => expect(analyzer.pending.some(({ file }) => (file as File).name === name)).toBe(true))
  const index = analyzer.pending.findIndex(({ file }) => (file as File).name === name)
  const [job] = analyzer.pending.splice(index, 1)
  await act(async () => job!.resolve(analysis))
}

const rowOf = (id: string) => screen.getByRole('rowheader', { name: new RegExp(`^${id} 미리보기`) }).closest('tr')!
const setLabel = (id: string, label: '' | 'sharp' | 'blurry' | 'unsure') =>
  fireEvent.change(screen.getByRole('combobox', { name: `${id} 정답` }), { target: { value: label } })
const metric = (caption: RegExp, name: string) =>
  within(within(screen.getByRole('table', { name: caption })).getByRole('rowheader', { name }).closest('tr')!)
    .getAllByRole('cell')[0]!.textContent
const photoIds = () =>
  screen.queryAllByRole('combobox', { name: / 정답$/ }).map((element) => element.getAttribute('aria-label')!.replace(' 정답', ''))
// 테스트가 직접 계산한 기대 해시. 평가 도구의 해시 계산 코드를 쓰지 않는다.
const sha256Of = async (file: Blob) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('')

describe('CalibrationApp', () => {
  let objectUrls: ReturnType<typeof installObjectUrlTracker>

  beforeEach(() => {
    objectUrls = installObjectUrlTracker()
    analyzer.pending.length = 0
    analyzer.measured.length = 0
    analyzer.analyzeCalls = 0
    analyzer.disposeCount = 0
    downloads.length = 0
  })

  afterEach(() => {
    objectUrls.restore()
    vi.restoreAllMocks()
  })

  it('starts empty with statistics that cannot be computed yet', () => {
    render(<CalibrationApp />)

    expect(screen.getByRole('heading', { level: 1, name: '흐림 판정 평가 (개발용)' })).toBeInTheDocument()
    expect(screen.getByText('평가할 사진을 불러오세요.')).toBeInTheDocument()
    expect(metric(/^판정한 사진 기준/, '정확도')).toBe('계산 불가(0장)')
    expect(screen.getByText(/표본이 작습니다/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'JSON 내보내기' })).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'CSV 내보내기' }))
    expect(downloads).toEqual([])
  })

  it('compares labels with the same analysis results the gallery uses and recounts when a label changes', async () => {
    render(<CalibrationApp />)
    selectFiles([
      createImageFile('a.jpg', 'jpeg', [1]),
      createImageFile('b.jpg', 'jpeg', [2]),
      createImageFile('c.jpg', 'jpeg', [3]),
      createImageFile('d.jpg', 'jpeg', [4]),
      createImageFile('e.jpg', 'jpeg', [5]),
    ])
    await waitFor(() => expect(photoIds()).toHaveLength(5))
    const [a, b, c, d, e] = photoIds() as [string, string, string, string, string]
    expect(within(rowOf(a)).getByText('분석 중')).toBeInTheDocument()

    await finishMeasure('a.jpg', SHARP)
    await finishMeasure('b.jpg', BLURRY)
    await finishMeasure('c.jpg', BLURRY)
    await finishMeasure('d.jpg', SHARP)
    await finishMeasure('e.jpg', LOW_DETAIL)
    // 평가 도구는 사용자 화면용 analyze를 따로 부르지 않고 같은 분석의 측정값을 쓴다.
    expect(analyzer.analyzeCalls).toBe(0)

    expect(within(rowOf(a)).getByText('0.0812')).toBeInTheDocument()
    expect(within(rowOf(e)).getByText('분석 불가')).toBeInTheDocument()
    expect(within(rowOf(e)).getByText('윤곽이 적거나 잡음이 많아 판정할 수 없습니다')).toBeInTheDocument()
    expect(within(rowOf(a)).getByText('정답 없음')).toBeInTheDocument()

    // a 선명→선명(정상), b 흐림→흐림(정상), c 선명→흐림 의심(오탐), d 흐림→선명(미탐), e 흐림→분석 불가
    setLabel(a, 'sharp')
    setLabel(b, 'blurry')
    setLabel(c, 'sharp')
    setLabel(d, 'blurry')
    setLabel(e, 'blurry')

    expect(within(rowOf(c)).getByText('오탐')).toBeInTheDocument()
    expect(within(rowOf(d)).getByText('미탐')).toBeInTheDocument()
    expect(screen.getByText(/정답 있음 5장\(선명 2, 흐림 3\)/)).toBeInTheDocument()
    expect(metric(/^판정 가능 비율/, '전체')).toBe('80.0% (4/5)')
    expect(metric(/^판정한 사진 기준/, '정확도')).toBe('50.0% (2/4)')
    expect(metric(/^판정한 사진 기준/, '재현율')).toBe('50.0% (1/2)')
    expect(metric(/^전체 기준/, '재현율')).toBe('33.3% (1/3)')
    expect(metric(/^전체 기준/, '정확도')).toBe('40.0% (2/5)')

    // 정답을 고치면 통계가 바로 바뀐다. 판단 보류와 미지정은 통계에서 빠진다.
    setLabel(c, 'blurry')
    setLabel(d, 'unsure')
    setLabel(e, '')
    expect(within(rowOf(c)).getByText('정상(흐림)')).toBeInTheDocument()
    expect(screen.getByText(/정답 있음 3장\(선명 1, 흐림 2\) · 판단 보류 1장 · 정답 없음 1장/)).toBeInTheDocument()
    expect(metric(/^판정한 사진 기준/, '정확도')).toBe('100.0% (3/3)')
    expect(metric(/^판정한 사진 기준/, '정밀도')).toBe('100.0% (2/2)')
  })

  it('analyzes at most two photos at once, keeps going after a failure and analyzes each photo once', async () => {
    render(
      <StrictMode>
        <CalibrationApp />
      </StrictMode>,
    )
    const original = createImageFile('a.jpg', 'jpeg', [9, 8, 7])
    selectFiles([original, createImageFile('b.jpg', 'jpeg', [2]), createImageFile('c.jpg', 'jpeg', [3])])
    await waitFor(() => expect(measuredNames()).toEqual(['a.jpg', 'b.jpg']))

    await finishMeasure('a.jpg', { result: { status: 'unavailable', reason: 'failed' }, measurement: null })
    await waitFor(() => expect(measuredNames()).toEqual(['a.jpg', 'b.jpg', 'c.jpg']))
    await finishMeasure('b.jpg', SHARP)
    await finishMeasure('c.jpg', SHARP)

    // 같은 내용의 파일은 다시 가져오지 않으므로 다시 분석하지 않는다.
    selectFiles([createImageFile('a-copy.jpg', 'jpeg', [9, 8, 7])])
    expect(await screen.findByRole('region', { name: '추가하지 않은 파일 1개' })).toBeInTheDocument()

    expect(measuredNames()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(analyzer.measured[0]).toBe(original)
    expect(await readBytes(original)).toEqual([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7])
    expect(within(rowOf(photoIds()[0]!)).getByText('분석 중 오류가 발생했습니다')).toBeInTheDocument()
  })

  it('drops the label and late result of a removed photo and starts over when it is imported again', async () => {
    render(<CalibrationApp />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1]), createImageFile('b.jpg', 'jpeg', [2]), createImageFile('c.jpg', 'jpeg', [3])])
    await waitFor(() => expect(photoIds()).toHaveLength(3))
    const [a, b] = photoIds() as [string, string, string]
    setLabel(a, 'blurry')

    // a는 분석 중, c는 대기 중에 제거한다.
    fireEvent.click(screen.getByRole('button', { name: `${a} 평가에서 제거` }))
    fireEvent.click(screen.getByRole('button', { name: `${photoIds()[1]} 평가에서 제거` }))
    await waitFor(() => expect(photoIds()).toEqual([b]))
    await finishMeasure('a.jpg', BLURRY)
    await finishMeasure('b.jpg', SHARP)
    expect(measuredNames()).toEqual(['a.jpg', 'b.jpg'])
    expect(screen.getByText(/전체 1장 · 정답 있음 0장/)).toBeInTheDocument()

    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await waitFor(() => expect(photoIds()).toHaveLength(2))
    const reimported = photoIds()[1]!
    expect(reimported).not.toBe(a)
    expect(screen.getByRole('combobox', { name: `${reimported} 정답` })).toHaveValue('')
    expect(within(rowOf(reimported)).getByText('분석 중')).toBeInTheDocument()
    await finishMeasure('a.jpg', BLURRY)
    expect(within(rowOf(reimported)).getByText('흐림 의심')).toBeInTheDocument()
  })

  // Codex 리뷰 P2(PR #9 1회차): 키보드로 행을 지우면 초점이 사라졌다.
  it('keeps keyboard focus on a neighboring row when a row is removed, then on the import button', async () => {
    render(<CalibrationApp />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1]), createImageFile('b.jpg', 'jpeg', [2]), createImageFile('c.jpg', 'jpeg', [3])])
    await waitFor(() => expect(photoIds()).toHaveLength(3))
    const [a, b, c] = photoIds() as [string, string, string]
    const removeButton = (id: string) => screen.getByRole('button', { name: `${id} 평가에서 제거` })
    const removeWithKeyboard = (id: string) => {
      removeButton(id).focus()
      fireEvent.click(removeButton(id))
    }

    removeWithKeyboard(b)
    await waitFor(() => expect(removeButton(c)).toHaveFocus())
    removeWithKeyboard(c)
    await waitFor(() => expect(removeButton(a)).toHaveFocus())
    removeWithKeyboard(a)
    await waitFor(() => expect(screen.getByRole('button', { name: '사진 불러오기' })).toHaveFocus())
  })

  it('exports JSON and CSV with evaluation IDs only, never file names', async () => {
    render(<CalibrationApp />)
    const privateName = '홍길동_우리집_2026-10-01.jpg'
    selectFiles([createImageFile(privateName, 'jpeg', [1]), createImageFile('IMG_0001.jpg', 'jpeg', [2])])
    await waitFor(() => expect(photoIds()).toHaveLength(2))
    const [first, second] = photoIds() as [string, string]
    await finishMeasure(privateName, BLURRY)
    await finishMeasure('IMG_0001.jpg', SHARP)
    setLabel(first, 'blurry')
    fireEvent.change(screen.getByRole('combobox', { name: `${first} 촬영 조건` }), { target: { value: 'camera-shake' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: `${first} 장면 번호` }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('textbox', { name: /기기·카메라/ }), { target: { value: 'Pixel 7' } })

    fireEvent.click(screen.getByRole('button', { name: 'JSON 내보내기' }))
    fireEvent.click(screen.getByRole('button', { name: 'CSV 내보내기' }))

    expect(downloads.map(({ fileName, mimeType }) => [fileName.replace(/\d{8}-\d{6}/, 'TIME'), mimeType])).toEqual([
      ['blur-evaluation-TIME.json', 'application/json'],
      ['blur-evaluation-TIME.csv', 'text/csv'],
    ])
    for (const { text } of downloads) {
      expect(text).not.toContain('홍길동')
      expect(text).not.toContain('IMG_0001')
      expect(text).not.toContain('.jpg')
      expect(text).not.toContain('blob:')
      expect(text).toContain(first)
      expect(text).toContain(second)
      expect(text).toContain('Pixel 7')
      expect(text).not.toContain(navigator.userAgent)
    }
    const report = JSON.parse(downloads[0]!.text)
    expect(report.photos[0]).toMatchObject({ id: first, label: 'blurry', condition: 'camera-shake', sceneGroup: 2, verdict: 'blurry', outcome: 'true-positive', score: 0.0123 })
    expect(report.environment).toEqual({ device: 'Pixel 7', analysisPath: 'worker', userAgent: null })

    fireEvent.click(screen.getByRole('checkbox', { name: /User-Agent/ }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON 내보내기' }))
    expect(JSON.parse(downloads[2]!.text).environment.userAgent).toBe(navigator.userAgent)
  })

  it('keeps photos on the device and stops analysis when closed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method))
    const { unmount } = render(<CalibrationApp />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await waitFor(() => expect(measuredNames()).toEqual(['a.jpg']))

    unmount()

    expect(analyzer.disposeCount).toBe(1)
    expect(objectUrls.liveUrls.size).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
  })
})

describe('CalibrationApp ground truth dataset', () => {
  let objectUrls: ReturnType<typeof installObjectUrlTracker>

  beforeEach(() => {
    objectUrls = installObjectUrlTracker()
    analyzer.pending.length = 0
    analyzer.measured.length = 0
    downloads.length = 0
  })

  afterEach(() => {
    objectUrls.restore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const loadGroundTruth = (file: File) => fireEvent.change(screen.getByTestId('ground-truth-file-input'), { target: { files: [file] } })
  const groundTruthFile = (entries: unknown[], change: Record<string, unknown> = {}) =>
    new File([JSON.stringify({ format: 'photo-selector-blur-ground-truth', version: 1, hashAlgorithm: 'SHA-256', entries, ...change })], 'truth.json', {
      type: 'application/json',
    })
  const labelOf = (id: string) => (screen.getByRole('combobox', { name: `${id} 정답` }) as HTMLSelectElement).value
  const idOfFile = (name: string) => screen.getByTitle(name).closest('tr')!.querySelector('th span')!.textContent!
  const panel = () => within(screen.getByRole('region', { name: '정답 데이터' }))
  const count = (label: string) => panel().getByText(label, { selector: 'dt' }).nextElementSibling!.textContent
  const status = () => panel().getByRole('status').textContent

  it('applies labels by file content regardless of file name or import order, and counts what did not match', async () => {
    render(<CalibrationApp />)
    const a = createImageFile('a.jpg', 'jpeg', [1])
    const b = createImageFile('b.jpg', 'jpeg', [2])
    const c = createImageFile('c.jpg', 'jpeg', [3])
    loadGroundTruth(
      groundTruthFile([
        { sha256: await sha256Of(c), label: 'sharp', origin: 'real-capture', reviewed: true },
        { sha256: await sha256Of(a), label: 'blurry', condition: 'camera-shake', sceneGroup: 3, processing: '가로 손떨림' },
        { sha256: await sha256Of(createImageFile('x.jpg', 'jpeg', [9])), label: 'sharp' },
      ]),
    )
    expect(await panel().findByText(/사진에 적용할 수 있는 항목 3개/)).toBeInTheDocument()

    // 정답 데이터와 다른 순서로 불러온다.
    selectFiles([c, b, a])
    await waitFor(() => expect(count('정답 적용')).toBe('2장'))
    const [idA, idB, idC] = [idOfFile('a.jpg'), idOfFile('b.jpg'), idOfFile('c.jpg')]
    expect(labelOf(idA)).toBe('blurry')
    expect(screen.getByRole('combobox', { name: `${idA} 촬영 조건` })).toHaveValue('camera-shake')
    expect(screen.getByRole('spinbutton', { name: `${idA} 장면 번호` })).toHaveValue(3)
    expect(within(rowOf(idA)).getByText('가공: 가로 손떨림')).toBeInTheDocument()
    expect(labelOf(idC)).toBe('sharp')
    expect(screen.getByRole('combobox', { name: `${idC} 출처` })).toHaveValue('real-capture')
    expect(screen.getByRole('checkbox', { name: `${idC} 정답 검토함` })).toBeChecked()
    expect(screen.getByRole('combobox', { name: `${idA} 정답` })).toHaveAccessibleDescription('정답 데이터에서 적용')
    expect(labelOf(idB)).toBe('')
    expect(within(rowOf(idB)).getByText('정답 데이터에 없음')).toBeInTheDocument()
    expect(count('정답 데이터에 없는 사진')).toBe('1장')
    expect(count('불러온 사진에 없는 정답')).toBe('1개')

    // 불러온 정답은 통계에 그대로 쓰인다.
    await finishMeasure('c.jpg', SHARP)
    await finishMeasure('b.jpg', SHARP)
    await finishMeasure('a.jpg', SHARP)
    expect(screen.getByText(/정답 있음 2장\(선명 1, 흐림 1\)/)).toBeInTheDocument()
    expect(within(rowOf(idA)).getByText('미탐')).toBeInTheDocument()
    // 해시 계산은 원본을 바꾸지 않는다.
    expect(await readBytes(a)).toEqual([0xff, 0xd8, 0xff, 0xe0, 1])
  })

  it('matches by content when names collide and does not add a renamed copy twice', async () => {
    render(<CalibrationApp />)
    const labeled = createImageFile('IMG_0001.jpg', 'jpeg', [7, 7])
    loadGroundTruth(groundTruthFile([{ sha256: await sha256Of(labeled), label: 'blurry' }]))
    await panel().findByText(/사진에 적용할 수 있는 항목 1개/)

    // 같은 이름, 다른 내용의 사진은 정답을 받지 않는다.
    selectFiles([createImageFile('IMG_0001.jpg', 'jpeg', [8, 8])])
    await waitFor(() => expect(count('정답 데이터에 없는 사진')).toBe('1장'))
    selectFiles([labeled])
    await waitFor(() => expect(count('정답 적용')).toBe('1장'))
    expect(photoIds().map(labelOf)).toEqual(['', 'blurry'])

    // 이름만 다르고 내용이 같은 파일은 이미 있는 사진이므로 추가하지 않는다.
    selectFiles([createImageFile('renamed.jpg', 'jpeg', [7, 7])])
    expect(await screen.findByRole('region', { name: '추가하지 않은 파일 1개' })).toBeInTheDocument()
    expect(photoIds()).toHaveLength(2)
    expect(count('정답 적용')).toBe('1장')
  })

  it('keeps labels picked by hand, skips conflicting entries and lets the user correct applied labels', async () => {
    render(<CalibrationApp />)
    const manual = createImageFile('manual.jpg', 'jpeg', [1])
    const conflict = createImageFile('conflict.jpg', 'jpeg', [2])
    const applied = createImageFile('applied.jpg', 'jpeg', [3])
    selectFiles([manual, conflict, applied])
    await waitFor(() => expect(photoIds()).toHaveLength(3))
    const [idManual, idConflict, idApplied] = photoIds() as [string, string, string]
    setLabel(idManual, 'sharp')

    loadGroundTruth(
      groundTruthFile([
        { sha256: await sha256Of(manual), label: 'blurry' },
        { sha256: await sha256Of(conflict), label: 'sharp' },
        { sha256: await sha256Of(conflict), label: 'blurry' },
        { sha256: await sha256Of(applied), label: 'blurry', processing: '가우시안 흐림 σ=3', origin: 'synthetic-edit' },
        { sha256: 'photo-3', label: 'sharp' },
      ]),
    )
    await waitFor(() => expect(count('정답 적용')).toBe('1장'))
    expect(status()).toMatch(/적용할 수 있는 항목 2개.*손상 1, 충돌 1/)
    expect(count('손상(형식 오류)')).toBe('1개')
    expect(panel().getByText('손상 항목 순번: 5')).toBeInTheDocument()

    expect(labelOf(idManual)).toBe('sharp')
    expect(within(rowOf(idManual)).getByText('직접 고른 정답 유지(정답 데이터와 다름)')).toBeInTheDocument()
    expect(count('직접 고른 정답 유지(데이터와 다름)')).toBe('1장')
    expect(labelOf(idConflict)).toBe('')
    expect(within(rowOf(idConflict)).getByText('정답 데이터 안에서 충돌 — 적용 안 함')).toBeInTheDocument()
    expect(count('충돌로 적용 안 함')).toBe('1장')
    expect(labelOf(idApplied)).toBe('blurry')

    // 적용된 정답을 고치면 직접 고른 정답이 되며 나머지 설명은 유지된다.
    setLabel(idApplied, 'unsure')
    expect(labelOf(idApplied)).toBe('unsure')
    expect(within(rowOf(idApplied)).getByText('직접 고른 정답 유지(정답 데이터와 다름)')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: `${idApplied} 출처` })).toHaveValue('synthetic-edit')
    expect(count('직접 고른 정답 유지(데이터와 다름)')).toBe('2장')

    // 정답 데이터를 닫으면 데이터에서 온 정답만 사라지고 직접 고른 정답은 남는다.
    fireEvent.click(panel().getByRole('button', { name: '정답 데이터 닫기' }))
    expect(panel().getByRole('button', { name: '정답 데이터 불러오기' })).toHaveFocus()
    expect(photoIds().map(labelOf)).toEqual(['sharp', '', 'unsure'])
  })

  it('explains broken or wrong files and keeps using the dataset loaded before', async () => {
    render(<CalibrationApp />)
    const photo = createImageFile('a.jpg', 'jpeg', [1])
    selectFiles([photo])
    await waitFor(() => expect(photoIds()).toHaveLength(1))

    loadGroundTruth(new File(['{"format": "photo-selector-blur-ground-truth", "entries": ['], 'broken.json'))
    expect(await panel().findByText(/JSON 형식이 아닙니다/)).toBeInTheDocument()
    expect(status()).not.toMatch(/이전에 불러온/)

    loadGroundTruth(groundTruthFile([{ sha256: await sha256Of(photo), label: 'blurry' }]))
    await waitFor(() => expect(labelOf(photoIds()[0]!)).toBe('blurry'))

    loadGroundTruth(groundTruthFile([], { format: 'photo-selector-blur-evaluation', version: 1 }))
    expect(await panel().findByText(/평가 결과 파일입니다.*이전에 불러온 정답 데이터를 계속 씁니다/)).toBeInTheDocument()
    loadGroundTruth(groundTruthFile([], { version: 99 }))
    expect(await panel().findByText(/지원하지 않는 정답 데이터 버전/)).toBeInTheDocument()
    expect(labelOf(photoIds()[0]!)).toBe('blurry')
  })

  it('links a removed photo again when it is imported again', async () => {
    render(<CalibrationApp />)
    const photo = createImageFile('a.jpg', 'jpeg', [1])
    loadGroundTruth(groundTruthFile([{ sha256: await sha256Of(photo), label: 'sharp', origin: 'public-image' }]))
    await panel().findByText(/사진에 적용할 수 있는 항목 1개/)
    selectFiles([photo])
    await waitFor(() => expect(count('정답 적용')).toBe('1장'))
    const first = photoIds()[0]!
    setLabel(first, 'blurry')

    fireEvent.click(screen.getByRole('button', { name: `${first} 평가에서 제거` }))
    await waitFor(() => expect(photoIds()).toEqual([]))
    expect(count('불러온 사진에 없는 정답')).toBe('1개')

    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await waitFor(() => expect(count('정답 적용')).toBe('1장'))
    const again = photoIds()[0]!
    expect(again).not.toBe(first)
    // 제거하면서 직접 고친 정답은 지웠으므로 정답 데이터의 값으로 다시 붙는다.
    expect(labelOf(again)).toBe('sharp')
    expect(screen.getByRole('combobox', { name: `${again} 출처` })).toHaveValue('public-image')
  })

  it('marks a photo whose hash failed and keeps linking the others', async () => {
    render(<CalibrationApp />)
    const broken = createImageFile('broken.jpg', 'jpeg', [1])
    broken.arrayBuffer = () => Promise.reject(new Error('NotReadableError'))
    const fine = createImageFile('fine.jpg', 'jpeg', [2])
    loadGroundTruth(groundTruthFile([{ sha256: await sha256Of(fine), label: 'sharp' }]))
    await panel().findByText(/사진에 적용할 수 있는 항목 1개/)
    selectFiles([broken, fine])

    await waitFor(() => expect(count('해시 계산 실패')).toBe('1장'))
    await waitFor(() => expect(count('정답 적용')).toBe('1장'))
    expect(within(rowOf(idOfFile('broken.jpg'))).getByText('해시 계산 실패 — 정답 데이터와 연결 불가')).toBeInTheDocument()
    expect(labelOf(idOfFile('fine.jpg'))).toBe('sharp')
    // 해시가 없어도 분석과 직접 정답 고르기는 그대로 된다.
    await finishMeasure('broken.jpg', BLURRY)
    setLabel(idOfFile('broken.jpg'), 'blurry')
    expect(within(rowOf(idOfFile('broken.jpg'))).getByText('정상(흐림)')).toBeInTheDocument()
  })

  it('warns when the page cannot hash files at all', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    render(<CalibrationApp />)
    expect(panel().getByText(/Web Crypto를 쓸 수 없어 해시를 계산하지 못합니다/)).toBeInTheDocument()
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await waitFor(() => expect(within(rowOf(photoIds()[0]!)).getByText('해시 계산 실패 — 정답 데이터에 넣을 수 없음')).toBeInTheDocument())
  })

  it('exports hashes and human labels only, keeps entries for photos not loaded and never puts hashes in evaluation results', async () => {
    render(<CalibrationApp />)
    const privateName = '홍길동_우리집_2026-10-01.jpg'
    const labeled = createImageFile(privateName, 'jpeg', [1])
    const unlabeled = createImageFile('IMG_0002.jpg', 'jpeg', [2])
    const notLoadedHash = await sha256Of(createImageFile('elsewhere.jpg', 'jpeg', [5]))
    loadGroundTruth(groundTruthFile([{ sha256: notLoadedHash, label: 'unsure', sourceNote: '공개 이미지 예시', reviewed: true }]))
    await panel().findByText(/사진에 적용할 수 있는 항목 1개/)
    selectFiles([labeled, unlabeled])
    await waitFor(() => expect(count('정답 데이터에 없는 사진')).toBe('2장'))
    const [first] = photoIds() as [string, string]
    setLabel(first, 'blurry')
    fireEvent.click(screen.getByRole('checkbox', { name: `${first} 정답 검토함` }))
    // 자동 판정이 끝났어도 정답 없는 사진은 판정으로 정답을 만들지 않는다.
    await finishMeasure(privateName, BLURRY)
    await finishMeasure('IMG_0002.jpg', SHARP)

    fireEvent.click(panel().getByRole('button', { name: '정답 데이터 내보내기' }))
    expect(status()).toBe('정답 데이터 2개를 내보냈습니다(지금 사진 1개, 불러온 정답 데이터에서 유지 1개). 넣지 않음: 정답 미지정 사진 1.')
    const [download] = downloads
    expect(download!.fileName).toMatch(/^blur-ground-truth-\d{8}-\d{6}\.json$/)
    expect(download!.mimeType).toBe('application/json')
    for (const forbidden of ['홍길동', 'IMG_0002', '.jpg', 'blob:', 'verdict', 'score']) expect(download!.text).not.toContain(forbidden)
    expect(download!.text).not.toMatch(/photo-\d/)
    const exported = JSON.parse(download!.text)
    expect(exported.entries).toEqual(
      [
        { sha256: await sha256Of(labeled), label: 'blurry', condition: null, sceneGroup: null, origin: null, reviewed: true, processing: null, sourceNote: null },
        { sha256: notLoadedHash, label: 'unsure', condition: null, sceneGroup: null, origin: null, reviewed: true, processing: null, sourceNote: '공개 이미지 예시' },
      ].sort((x, y) => (x.sha256 < y.sha256 ? -1 : 1)),
    )

    fireEvent.click(screen.getByRole('button', { name: 'JSON 내보내기' }))
    fireEvent.click(screen.getByRole('button', { name: 'CSV 내보내기' }))
    for (const { text } of downloads.slice(1)) {
      expect(text).not.toContain(await sha256Of(labeled))
      expect(text).not.toContain(notLoadedHash)
      expect(text).not.toContain('공개 이미지 예시')
    }
    expect(JSON.parse(downloads[1]!.text).photos[0]).toMatchObject({ id: first, label: 'blurry', reviewed: true, origin: null })
  })

  it('does not download an empty ground truth file', async () => {
    render(<CalibrationApp />)
    expect(panel().getByRole('button', { name: '정답 데이터 내보내기' })).toHaveAttribute('aria-disabled', 'true')
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await waitFor(() => expect(photoIds()).toHaveLength(1))
    fireEvent.click(panel().getByRole('button', { name: '정답 데이터 내보내기' }))
    expect(downloads).toEqual([])
    expect(status()).toMatch(/^내보낼 정답이 없습니다/)
  })

  it('does not download a ground truth file that could not be loaded again', async () => {
    render(<CalibrationApp />)
    const fullDataset = Array.from({ length: 20_000 }, (_, index) => ({ sha256: index.toString(16).padStart(64, '0'), label: 'sharp' }))
    loadGroundTruth(groundTruthFile(fullDataset))
    await panel().findByText(/사진에 적용할 수 있는 항목 20000개/)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await waitFor(() => expect(count('정답 데이터에 없는 사진')).toBe('1장'))
    setLabel(photoIds()[0]!, 'blurry')

    fireEvent.click(panel().getByRole('button', { name: '정답 데이터 내보내기' }))
    expect(downloads).toEqual([])
    expect(status()).toBe('정답 데이터를 내보내지 못했습니다. 항목이 불러오기 한도(최대 20,000개)를 넘어 다시 불러올 수 없습니다.')
  })
})
