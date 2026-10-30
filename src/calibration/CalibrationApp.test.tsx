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
