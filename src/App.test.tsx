import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { createPhotoThumbnail, type PhotoThumbnail } from './photos/createPhotoThumbnail.ts'
import type { PhotoFingerprint } from './photos/photoFingerprint.ts'
import type { SharpnessResult } from './photos/sharpness.ts'
import type { PhotoAnalysis } from './photos/sharpnessWorkerClient.ts'
import { createImageFile, createTextFile, readBytes } from './test/imageFiles.ts'
import { installObjectUrlTracker } from './test/objectUrls.ts'
import { adjustTone, resizeBilinear } from './test/photoVariants.ts'
import { fingerprintOf, renderWideScene, viewOf } from './test/similarScenes.ts'
import { gaussianBlur, renderScene, renderUniform } from './test/syntheticImages.ts'

// jsdom에는 Web Worker와 이미지 디코딩이 없으므로 분석기를 테스트에서 직접 끝내는 가짜로 바꾼다.
// 실제 판정은 sharpness.test.ts·photoSimilarity.test.ts, 실제 브라우저 Worker는 E2E에서 확인한다.
const sharpnessAnalyzer = vi.hoisted(() => ({
  pending: [] as { file: Blob; resolve: (analysis: PhotoAnalysis) => void }[],
  analyzedFiles: [] as Blob[],
  disposeCount: 0,
}))
vi.mock('./photos/sharpnessWorkerClient.ts', () => ({
  createSharpnessWorkerAnalyzer: () => ({
    analyzePhoto: (file: Blob) =>
      new Promise<PhotoAnalysis>((resolve) => {
        sharpnessAnalyzer.analyzedFiles.push(file)
        sharpnessAnalyzer.pending.push({ file, resolve })
      }),
    dispose: () => {
      sharpnessAnalyzer.disposeCount += 1
    },
  }),
}))

const analyzedNames = () => sharpnessAnalyzer.analyzedFiles.map((file) => (file as File).name)

// 이름이 같은 사진의 진행 중 분석을 끝낸다. 동시 분석 상한 때문에 아직 시작하지 않은 사진은 기다린다.
async function finishAnalysis(name: string, result: SharpnessResult, fingerprint: PhotoFingerprint | null = null) {
  await waitFor(() => expect(sharpnessAnalyzer.pending.some(({ file }) => (file as File).name === name)).toBe(true))
  const index = sharpnessAnalyzer.pending.findIndex(({ file }) => (file as File).name === name)
  const [job] = sharpnessAnalyzer.pending.splice(index, 1)
  await act(async () => job!.resolve({ sharpness: result, fingerprint }))
}

const sharpnessBadgeOf = (name: string) =>
  screen.getByRole('img', { name }).closest('li')?.querySelector('[data-testid="sharpness-badge"]')?.textContent ?? null
const sharpnessReasonOf = (name: string) =>
  screen.getByRole('img', { name }).closest('li')?.querySelector('[data-testid="sharpness-reason"]')?.textContent ?? null

// jsdom은 이미지를 디코딩하지 못하므로 미리보기 생성만 대체한다. 이름이 broken으로 시작하면 손상된 이미지로 취급한다.
vi.mock('./photos/createPhotoThumbnail.ts', () => ({
  createPhotoThumbnail: vi.fn(async (file: Blob) => {
    if (file instanceof File && file.name.startsWith('broken')) {
      throw new Error('decode failed')
    }
    return { blob: new Blob(['thumbnail']), width: 40, height: 30 }
  }),
}))

function selectFiles(files: File[]) {
  fireEvent.change(screen.getByTestId('photo-file-input'), { target: { files } })
}

async function findGallery(count: number) {
  return screen.findByRole('heading', { level: 2, name: `선택한 사진 ${count}장` })
}

describe('App', () => {
  let objectUrls: ReturnType<typeof installObjectUrlTracker>

  beforeEach(() => {
    objectUrls = installObjectUrlTracker()
    sharpnessAnalyzer.pending.length = 0
    sharpnessAnalyzer.analyzedFiles.length = 0
    sharpnessAnalyzer.disposeCount = 0
  })

  afterEach(() => {
    objectUrls.restore()
    vi.restoreAllMocks()
  })

  it('renders the service title as the main heading', () => {
    render(<App />)

    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Photo Selector' })).toBeInTheDocument()
  })

  it('shows a photo selection guide on first visit', () => {
    render(<App />)

    expect(screen.getByRole('heading', { level: 2, name: '정리할 사진을 선택하세요' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '사진 선택' })).toBeInTheDocument()
    expect(screen.getByText(/JPEG, PNG, WebP 형식을 지원합니다/)).toBeInTheDocument()
  })

  it('opens the file picker that accepts only supported formats', () => {
    render(<App />)
    const input = screen.getByTestId('photo-file-input')
    const clickSpy = vi.spyOn(input, 'click')

    fireEvent.click(screen.getByRole('button', { name: '사진 선택' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(input).toHaveAttribute('multiple')
    expect(input).toHaveAttribute('accept', expect.stringContaining('image/webp'))
  })

  it('adds several photos and switches to the gallery', async () => {
    render(<App />)

    selectFiles([
      createImageFile('a.jpg', 'jpeg', [1]),
      createImageFile('b.png', 'png', [2]),
      createImageFile('c.webp', 'webp', [3]),
    ])

    const heading = await findGallery(3)
    // 초점 이동은 화면 반영 후 effect에서 일어나므로 기다린다.
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent('사진 3장을 추가했습니다.')
    const images = within(screen.getByRole('list')).getAllByRole('img')
    expect(images.map((image) => image.getAttribute('alt'))).toEqual(['a.jpg', 'b.png', 'c.webp'])
    expect(screen.queryByRole('button', { name: '사진 선택' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '사진 추가' })).toBeInTheDocument()
  })

  it('keeps the current photos when the file selection is cancelled', async () => {
    render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await findGallery(1)

    selectFiles([])

    expect(screen.getByRole('heading', { level: 2, name: '선택한 사진 1장' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'a.jpg' })).toBeInTheDocument()
  })

  it('appends newly selected photos to the existing gallery', async () => {
    render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await findGallery(1)

    selectFiles([createImageFile('b.jpg', 'jpeg', [2]), createImageFile('c.png', 'png', [3])])

    await findGallery(3)
    const names = within(screen.getByRole('list'))
      .getAllByRole('img')
      .map((image) => image.getAttribute('alt'))
    expect(names).toEqual(['a.jpg', 'b.jpg', 'c.png'])
  })

  it('explains why unsupported, corrupted and duplicate files were skipped', async () => {
    render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await findGallery(1)

    selectFiles([
      createImageFile('anim.gif', 'gif'),
      createTextFile('document.pdf'),
      createImageFile('broken.jpg', 'jpeg', [8]),
      createImageFile('a-copy.jpg', 'jpeg', [1]),
      createImageFile('d.png', 'png', [4]),
    ])

    await findGallery(2)
    expect(screen.getByRole('status')).toHaveTextContent(
      '사진 1장을 추가했습니다. 4개 파일은 추가하지 않았습니다.',
    )
    const notice = screen.getByRole('region', { name: '추가하지 않은 파일 4개' })
    expect(within(notice).getByText('지원하지 않는 형식 2개')).toBeInTheDocument()
    expect(within(notice).getByText('anim.gif')).toBeInTheDocument()
    expect(within(notice).getByText('document.pdf')).toBeInTheDocument()
    expect(within(notice).getByText('열 수 없는 파일 1개')).toBeInTheDocument()
    expect(within(notice).getByText('broken.jpg')).toBeInTheDocument()
    expect(within(notice).getByText('이미 추가된 사진 1개')).toBeInTheDocument()
    expect(within(notice).getByText('a-copy.jpg')).toBeInTheDocument()

    fireEvent.click(within(notice).getByRole('button', { name: '알림 닫기' }))
    expect(screen.queryByRole('region', { name: /추가하지 않은 파일/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '사진 추가' })).toHaveFocus()
  })

  it('stays on the guide screen when every selected file is rejected', async () => {
    render(<App />)

    selectFiles([createTextFile('notes.txt')])

    expect(await screen.findByRole('region', { name: '추가하지 않은 파일 1개' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('추가한 사진이 없습니다.')
    expect(screen.getByRole('button', { name: '사진 선택' })).toBeInTheDocument()
  })

  it('removes a single photo from the list, releases its preview and moves focus', async () => {
    render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1]), createImageFile('b.jpg', 'jpeg', [2])])
    await findGallery(2)
    const removedUrl = screen.getByRole('img', { name: 'a.jpg' }).getAttribute('src')

    fireEvent.click(screen.getByRole('button', { name: 'a.jpg 목록에서 제거' }))

    await findGallery(1)
    expect(screen.queryByRole('img', { name: 'a.jpg' })).not.toBeInTheDocument()
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith(removedUrl)
    await waitFor(() => expect(screen.getByRole('button', { name: 'b.jpg 목록에서 제거' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'b.jpg 목록에서 제거' }))

    const pickerButton = await screen.findByRole('button', { name: '사진 선택' })
    await waitFor(() => expect(pickerButton).toHaveFocus())
    expect(objectUrls.liveUrls.size).toBe(0)
  })

  it('allows a removed photo to be added again', async () => {
    render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1]), createImageFile('b.jpg', 'jpeg', [2])])
    await findGallery(2)
    fireEvent.click(screen.getByRole('button', { name: 'a.jpg 목록에서 제거' }))
    await findGallery(1)

    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])

    await findGallery(2)
    expect(screen.getByRole('status')).toHaveTextContent('사진 1장을 추가했습니다.')
  })

  it('checks duplicates against the current list when a photo is removed during an import', async () => {
    render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await findGallery(1)

    let finishThumbnail: (thumbnail: PhotoThumbnail) => void = () => {}
    vi.mocked(createPhotoThumbnail).mockImplementationOnce(
      () => new Promise((resolve) => (finishThumbnail = resolve)),
    )
    selectFiles([createImageFile('b.jpg', 'jpeg', [2]), createImageFile('a-copy.jpg', 'jpeg', [1])])
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('(0/2)'))

    fireEvent.click(screen.getByRole('button', { name: 'a.jpg 목록에서 제거' }))
    await screen.findByRole('button', { name: '사진 선택' })
    finishThumbnail({ blob: new Blob(['thumbnail']), width: 40, height: 30 })

    await findGallery(2)
    const names = within(screen.getByRole('list'))
      .getAllByRole('img')
      .map((image) => image.getAttribute('alt'))
    expect(names).toEqual(['b.jpg', 'a-copy.jpg'])
    expect(screen.queryByRole('region', { name: /추가하지 않은 파일/ })).not.toBeInTheDocument()
  })

  it('releases every preview URL when the app unmounts', async () => {
    const { unmount } = render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1]), createImageFile('b.jpg', 'jpeg', [2])])
    await findGallery(2)
    expect(objectUrls.liveUrls.size).toBe(2)

    unmount()

    expect(objectUrls.liveUrls.size).toBe(0)
  })

  it('discards an import that finishes after the app unmounts', async () => {
    let finishThumbnail: (thumbnail: PhotoThumbnail) => void = () => {}
    vi.mocked(createPhotoThumbnail).mockImplementationOnce(
      () => new Promise((resolve) => (finishThumbnail = resolve)),
    )
    const { unmount } = render(<App />)
    selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
    await waitFor(() => expect(createPhotoThumbnail).toHaveBeenCalled())

    unmount()
    finishThumbnail({ blob: new Blob(['thumbnail']), width: 40, height: 30 })

    await waitFor(() => expect(objectUrls.revokeObjectURL).toHaveBeenCalledTimes(1))
    expect(objectUrls.createObjectURL).toHaveBeenCalledTimes(1)
    expect(objectUrls.liveUrls.size).toBe(0)
  })

  it('does not send photos over the network or write them to the console', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const xhrOpenSpy = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    )
    render(<App />)

    selectFiles([
      createImageFile('a.jpg', 'jpeg', [1]),
      createImageFile('broken.jpg', 'jpeg', [2]),
      createTextFile('notes.txt'),
    ])
    await findGallery(1)
    fireEvent.click(screen.getByRole('button', { name: 'a.jpg 목록에서 제거' }))
    await screen.findByRole('button', { name: '사진 선택' })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhrOpenSpy).not.toHaveBeenCalled()
    consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
  })

  describe('blur detection', () => {
    it('shows progress while analyzing and then labels each blur cause and undecidable photos with a visible reason', async () => {
      render(<App />)
      selectFiles([
        createImageFile('sharp.jpg', 'jpeg', [1]),
        createImageFile('shaken.jpg', 'jpeg', [2]),
        createImageFile('soft.jpg', 'jpeg', [3]),
        createImageFile('blurry.jpg', 'jpeg', [4]),
        createImageFile('wall.jpg', 'jpeg', [5]),
        createImageFile('slow.jpg', 'jpeg', [6]),
      ])
      await findGallery(6)

      expect(screen.getByText('흐림 확인 중 0/6장')).toBeInTheDocument()
      expect(screen.getByRole('img', { name: 'sharp.jpg' })).toHaveAccessibleDescription('흐림 확인 중')
      expect(sharpnessBadgeOf('wall.jpg')).toBe('확인 중')
      expect(sharpnessReasonOf('wall.jpg')).toBeNull()

      await finishAnalysis('sharp.jpg', { status: 'sharp' })
      expect(screen.getByText('흐림 확인 중 1/6장')).toBeInTheDocument()
      await finishAnalysis('shaken.jpg', { status: 'blurry', cause: 'shake' })
      await finishAnalysis('soft.jpg', { status: 'blurry', cause: 'defocus' })
      await finishAnalysis('blurry.jpg', { status: 'blurry', cause: 'unknown' })
      await finishAnalysis('wall.jpg', { status: 'unavailable', reason: 'low-detail' })
      await finishAnalysis('slow.jpg', { status: 'unavailable', reason: 'timeout' })

      expect(screen.getByRole('img', { name: 'sharp.jpg' })).toHaveAccessibleDescription('흐림 의심 없음')
      expect(sharpnessBadgeOf('sharp.jpg')).toBeNull()
      expect(sharpnessReasonOf('sharp.jpg')).toBeNull()

      expect(screen.getByRole('img', { name: 'shaken.jpg' })).toHaveAccessibleDescription(
        '흔들림 의심: 윤곽이 한 방향으로 번져 있습니다',
      )
      expect(sharpnessBadgeOf('shaken.jpg')).toBe('흔들림 의심')
      expect(sharpnessReasonOf('shaken.jpg')).toBe('한 방향으로 번진 윤곽')

      expect(screen.getByRole('img', { name: 'soft.jpg' })).toHaveAccessibleDescription(
        '초점 불량 의심: 윤곽이 모든 방향으로 고르게 흐립니다',
      )
      expect(sharpnessBadgeOf('soft.jpg')).toBe('초점 불량 의심')
      expect(sharpnessReasonOf('soft.jpg')).toBe('전체가 고르게 흐림')

      // 원인을 구분할 근거가 부족하면 원인을 단정하지 않는다.
      expect(screen.getByRole('img', { name: 'blurry.jpg' })).toHaveAccessibleDescription(
        '흐림 의심: 윤곽이 흐리지만 원인은 구분하기 어렵습니다',
      )
      expect(sharpnessBadgeOf('blurry.jpg')).toBe('흐림 의심')
      expect(sharpnessReasonOf('blurry.jpg')).toBe('원인 구분 어려움')

      expect(screen.getByRole('img', { name: 'wall.jpg' })).toHaveAccessibleDescription(
        '흐림 분석 불가: 윤곽이 적거나 잡음이 많아 판정할 수 없습니다',
      )
      expect(sharpnessBadgeOf('wall.jpg')).toBe('분석 불가')
      expect(sharpnessReasonOf('wall.jpg')).toBe('윤곽 부족 또는 잡음')
      expect(screen.getByRole('img', { name: 'slow.jpg' })).toHaveAccessibleDescription(
        '흐림 분석 불가: 분석이 너무 오래 걸려 중단했습니다',
      )
      expect(sharpnessReasonOf('slow.jpg')).toBe('분석 시간 초과')

      // 진행 수는 화면에만 보이고, 낭독용 알림은 시작과 끝에만 바뀐다.
      const summary = '흔들림 의심 1장 · 초점 불량 의심 1장 · 흐림 의심 1장 · 분석 불가 2장'
      expect(screen.getAllByText(summary).map((element) => element.getAttribute('aria-live'))).toEqual([null, 'polite'])
      // 흐림 분석은 기존 가져오기 상태 문장을 바꾸지 않는다.
      expect(screen.getByRole('status')).toHaveTextContent('사진 6장을 추가했습니다.')
    })

    it('analyzes each original photo once, in the background, without changing its bytes', async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      const first = createImageFile('a.jpg', 'jpeg', [1, 2, 3])
      const second = createImageFile('b.jpg', 'jpeg', [4, 5, 6])
      selectFiles([first, second])
      await findGallery(2)
      await finishAnalysis('a.jpg', { status: 'sharp' })
      await finishAnalysis('b.jpg', { status: 'blurry', cause: 'unknown' })

      // 중복 파일은 가져오지 않으므로 다시 분석하지 않고, 새 사진만 분석한다.
      selectFiles([createImageFile('a-copy.jpg', 'jpeg', [1, 2, 3]), createImageFile('c.jpg', 'jpeg', [7])])
      await findGallery(3)
      await finishAnalysis('c.jpg', { status: 'sharp' })

      expect(analyzedNames()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
      expect(sharpnessAnalyzer.analyzedFiles[0]).toBe(first)
      expect(sharpnessAnalyzer.analyzedFiles[1]).toBe(second)
      expect(await readBytes(first)).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
      expect(sharpnessBadgeOf('b.jpg')).toBe('흐림 의심')
    })

    it('limits concurrent analyses and keeps going when one photo cannot be analyzed', async () => {
      render(<App />)
      selectFiles(['a', 'b', 'c', 'd'].map((name, index) => createImageFile(`${name}.jpg`, 'jpeg', [index])))
      await findGallery(4)

      await waitFor(() => expect(analyzedNames()).toEqual(['a.jpg', 'b.jpg']))
      await finishAnalysis('a.jpg', { status: 'unavailable', reason: 'failed' })
      await waitFor(() => expect(analyzedNames()).toEqual(['a.jpg', 'b.jpg', 'c.jpg']))
      await finishAnalysis('b.jpg', { status: 'sharp' })
      await finishAnalysis('c.jpg', { status: 'sharp' })
      await finishAnalysis('d.jpg', { status: 'blurry', cause: 'unknown' })

      expect(screen.getByRole('img', { name: 'a.jpg' })).toHaveAccessibleDescription(
        '흐림 분석 불가: 분석 중 오류가 발생했습니다',
      )
      expect(sharpnessBadgeOf('a.jpg')).toBe('분석 불가')
      expect(sharpnessBadgeOf('d.jpg')).toBe('흐림 의심')
    })

    it('ignores the result of a removed photo and never analyzes a removed waiting photo', async () => {
      render(<App />)
      selectFiles(['a', 'b', 'c'].map((name, index) => createImageFile(`${name}.jpg`, 'jpeg', [index])))
      await findGallery(3)
      await waitFor(() => expect(analyzedNames()).toEqual(['a.jpg', 'b.jpg']))

      // a는 분석 중, c는 대기 중에 제거한다.
      fireEvent.click(screen.getByRole('button', { name: 'a.jpg 목록에서 제거' }))
      fireEvent.click(screen.getByRole('button', { name: 'c.jpg 목록에서 제거' }))
      await findGallery(1)
      await finishAnalysis('a.jpg', { status: 'blurry', cause: 'unknown' })
      await finishAnalysis('b.jpg', { status: 'sharp' })

      expect(analyzedNames()).toEqual(['a.jpg', 'b.jpg'])
      expect(screen.queryByText(/흐림 의심 \d장/)).not.toBeInTheDocument()
      expect(screen.getAllByText('흐림 의심 사진이 없습니다')).toHaveLength(2)
    })

    it('stops analysis and releases workers when the app unmounts', async () => {
      const { unmount } = render(<App />)
      selectFiles([createImageFile('a.jpg', 'jpeg', [1])])
      await findGallery(1)
      await waitFor(() => expect(analyzedNames()).toEqual(['a.jpg']))

      unmount()

      expect(sharpnessAnalyzer.disposeCount).toBe(1)
      await act(async () =>
        sharpnessAnalyzer.pending[0]!.resolve({ sharpness: { status: 'blurry', cause: 'unknown' }, fingerprint: null }),
      )
      expect(objectUrls.liveUrls.size).toBe(0)
    })
  })

  describe('similar photos', () => {
    // 실제 지문 계산으로 만든 합성 장면의 지문. 판정 규칙 자체는 photoSimilarity.test.ts에서 확인한다.
    let fingerprints: Record<'portrait' | 'portraitSmall' | 'portraitBright' | 'burstA' | 'burstB' | 'other' | 'wall', PhotoFingerprint>
    beforeAll(() => {
      const portrait = viewOf(renderWideScene(21))
      const burst = renderWideScene(22)
      fingerprints = {
        portrait: fingerprintOf(portrait),
        portraitSmall: fingerprintOf(resizeBilinear(portrait, 320, 240)),
        portraitBright: fingerprintOf(adjustTone(portrait, { gain: 0.8, offset: 40 })),
        burstA: fingerprintOf(viewOf(burst)),
        burstB: fingerprintOf(viewOf(burst, 16, 8)),
        other: fingerprintOf(gaussianBlur(renderScene(512, 384, 40), 0.8)),
        wall: fingerprintOf(renderUniform(512, 384, 120)),
      }
    })

    const galleryNames = () =>
      within(screen.getAllByRole('list')[0]!)
        .getAllByRole('img')
        .map((image) => image.getAttribute('alt'))
    const groupBadgeOf = (name: string) =>
      screen.getByRole('img', { name }).closest('li')?.querySelector('[data-testid="similar-group-badge"]')?.textContent ?? null
    const similarSummary = () => screen.getByTestId('similar-summary').textContent

    it('marks groups without reordering the gallery and shows each group for comparison', async () => {
      render(<App />)
      const names = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg']
      selectFiles(names.map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(6)
      expect(similarSummary()).toBe('비슷한 사진 확인 중')

      await finishAnalysis('a.jpg', { status: 'sharp' }, fingerprints.portrait)
      await finishAnalysis('b.jpg', { status: 'sharp' }, fingerprints.other)
      await finishAnalysis('c.jpg', { status: 'blurry', cause: 'defocus' }, fingerprints.portraitSmall)
      // 분석 중에도 비교가 끝나 묶인 사진에는 표시가 붙지만 갤러리 순서는 그대로다.
      await waitFor(() => expect(groupBadgeOf('a.jpg')).toBe('묶음 1비슷한 사진 묶음 1'))
      expect(similarSummary()).toBe('비슷한 사진 확인 중')
      expect(galleryNames()).toEqual(names)
      await finishAnalysis('d.jpg', { status: 'sharp' }, fingerprints.burstA)
      await finishAnalysis('e.jpg', { status: 'blurry', cause: 'shake' }, fingerprints.burstB)
      await finishAnalysis('f.jpg', { status: 'unavailable', reason: 'low-detail' }, fingerprints.wall)

      await waitFor(() => expect(similarSummary()).toBe('비슷한 사진 묶음 2개(4장) · 비교하지 못한 사진 1장'))
      expect(galleryNames()).toEqual(names)
      expect(['a.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].map(groupBadgeOf)).toEqual([
        '묶음 1비슷한 사진 묶음 1',
        '묶음 1비슷한 사진 묶음 1',
        '묶음 2비슷한 사진 묶음 2',
        '묶음 2비슷한 사진 묶음 2',
      ])
      expect(groupBadgeOf('b.jpg')).toBeNull()
      expect(groupBadgeOf('f.jpg')).toBeNull()

      const allButton = screen.getByRole('button', { name: '모든 사진' })
      const groupsButton = screen.getByRole('button', { name: '비슷한 사진끼리 보기' })
      expect(allButton).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(groupsButton)
      expect(groupsButton).toHaveAttribute('aria-pressed', 'true')

      const same = screen.getByRole('region', { name: '묶음 1 · 거의 같은 사진 2장' })
      expect(within(same).getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual(['a.jpg', 'c.jpg'])
      expect(within(same).getByText(/크기·화질·밝기·선명도만 다를 수 있습니다/)).toBeInTheDocument()
      // 묶음 안에서도 흐림 표시와 제거 버튼을 그대로 쓴다.
      expect(within(same).getByText('초점 불량 의심')).toBeInTheDocument()
      const similar = screen.getByRole('region', { name: '묶음 2 · 비슷한 사진 2장' })
      expect(within(similar).getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual(['d.jpg', 'e.jpg'])
      expect(screen.getByText('묶음에 없는 사진 2장은 ‘모든 사진’에서 볼 수 있습니다.')).toBeInTheDocument()
      expect(screen.queryByTestId('similar-group-badge')).not.toBeInTheDocument()

      // 묶음에서 한 장을 제거하면 혼자 남은 사진은 묶음에서 빠지고 초점은 갤러리 제목으로 간다.
      fireEvent.click(within(similar).getByRole('button', { name: 'd.jpg 목록에서 제거' }))
      await findGallery(5)
      expect(screen.queryByRole('region', { name: /묶음 2/ })).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: '선택한 사진 5장' })).toHaveFocus())
      expect(similarSummary()).toBe('비슷한 사진 묶음 1개(2장) · 비교하지 못한 사진 1장')

      fireEvent.click(allButton)
      expect(galleryNames()).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'e.jpg', 'f.jpg'])
      expect(groupBadgeOf('e.jpg')).toBeNull()
    })

    it('moves focus to the next photo of a group that keeps at least two photos', async () => {
      render(<App />)
      selectFiles(['a.jpg', 'b.jpg', 'c.jpg'].map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(3)
      await finishAnalysis('a.jpg', { status: 'sharp' }, fingerprints.portrait)
      await finishAnalysis('b.jpg', { status: 'sharp' }, fingerprints.portraitSmall)
      await finishAnalysis('c.jpg', { status: 'sharp' }, fingerprints.portraitBright)
      fireEvent.click(screen.getByRole('button', { name: '비슷한 사진끼리 보기' }))

      const group = await screen.findByRole('region', { name: '묶음 1 · 거의 같은 사진 3장' })
      fireEvent.click(within(group).getByRole('button', { name: 'a.jpg 목록에서 제거' }))

      await waitFor(() => expect(screen.getByRole('button', { name: 'b.jpg 목록에서 제거' })).toHaveFocus())
      expect(screen.getByRole('region', { name: '묶음 1 · 거의 같은 사진 2장' })).toBeInTheDocument()
    })

    it('keeps keyboard focus on a photo in grouped view while analysis changes the groups', async () => {
      render(<App />)
      selectFiles(['x.jpg', 'y.jpg', 'z.jpg', 'w.jpg', 'v.jpg'].map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(5)
      await finishAnalysis('y.jpg', { status: 'sharp' }, fingerprints.burstA)
      await finishAnalysis('z.jpg', { status: 'sharp' }, fingerprints.burstB)
      fireEvent.click(screen.getByRole('button', { name: '비슷한 사진끼리 보기' }))
      await screen.findByRole('region', { name: '묶음 1 · 비슷한 사진 2장' })
      const focusedButton = screen.getByRole('button', { name: 'y.jpg 목록에서 제거' })
      focusedButton.focus()

      // 앞선 순서의 사진이 묶음을 만들어 y가 두 번째 묶음으로 옮겨져도 y의 제거 버튼에 초점이 남는다.
      await finishAnalysis('x.jpg', { status: 'sharp' }, fingerprints.portrait)
      await finishAnalysis('w.jpg', { status: 'sharp' }, fingerprints.portraitSmall)
      await screen.findByRole('region', { name: '묶음 2 · 비슷한 사진 2장' })
      await waitFor(() => expect(screen.getByRole('button', { name: 'y.jpg 목록에서 제거' })).toHaveFocus())

      // 초점이 있는 사진의 묶음에 사진이 더해져도 초점이 남는다.
      screen.getByRole('button', { name: 'x.jpg 목록에서 제거' }).focus()
      await finishAnalysis('v.jpg', { status: 'sharp' }, fingerprints.portraitBright)
      await screen.findByRole('region', { name: '묶음 1 · 거의 같은 사진 3장' })
      expect(screen.getByRole('button', { name: 'x.jpg 목록에서 제거' })).toHaveFocus()
    })

    it('moves focus to the view switch when regrouping hides the focused photo', async () => {
      // 천천히 옮겨 찍은 세 장: A-B보다 B-C가 더 비슷하면 C가 들어올 때 A가 묶음에서 빠진다(A-C는 비슷하지 않음).
      const pan = renderWideScene(4)
      const [start, middle, end] = [viewOf(pan), viewOf(pan, 16, 8), viewOf(pan, 32, 16)].map(fingerprintOf)
      render(<App />)
      selectFiles(['a.jpg', 'b.jpg', 'c.jpg'].map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(3)
      await finishAnalysis('a.jpg', { status: 'sharp' }, start)
      await finishAnalysis('b.jpg', { status: 'sharp' }, middle)
      fireEvent.click(screen.getByRole('button', { name: '비슷한 사진끼리 보기' }))
      const group = await screen.findByRole('region', { name: '묶음 1 · 비슷한 사진 2장' })
      within(group).getByRole('button', { name: 'a.jpg 목록에서 제거' }).focus()

      await finishAnalysis('c.jpg', { status: 'sharp' }, end)

      await waitFor(() =>
        expect(within(screen.getByRole('region', { name: '묶음 1 · 비슷한 사진 2장' })).queryByRole('img', { name: 'a.jpg' })).toBeNull(),
      )
      await waitFor(() => expect(screen.getByRole('button', { name: '비슷한 사진끼리 보기' })).toHaveFocus())
    })

    it('leaves photos that could not be analyzed or were removed during analysis out of groups', async () => {
      render(<App />)
      selectFiles(['a.jpg', 'b.jpg', 'c.jpg'].map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(3)
      await waitFor(() => expect(analyzedNames()).toEqual(['a.jpg', 'b.jpg']))

      // b는 분석 중에 제거한다. 늦게 온 결과는 묶음에 쓰지 않는다.
      fireEvent.click(screen.getByRole('button', { name: 'b.jpg 목록에서 제거' }))
      await findGallery(2)
      await finishAnalysis('b.jpg', { status: 'sharp' }, fingerprints.portraitSmall)
      await finishAnalysis('a.jpg', { status: 'sharp' }, fingerprints.portrait)
      await finishAnalysis('c.jpg', { status: 'unavailable', reason: 'failed' })

      await waitFor(() => expect(similarSummary()).toBe('비슷한 사진 묶음이 없습니다 · 비교하지 못한 사진 1장'))
      expect(screen.queryByTestId('similar-group-badge')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '비슷한 사진끼리 보기' }))
      expect(screen.getByText('비슷한 사진 묶음이 없습니다.')).toBeInTheDocument()
      expect(screen.getByText('묶음에 없는 사진 2장은 ‘모든 사진’에서 볼 수 있습니다.')).toBeInTheDocument()
    })
  })
})
