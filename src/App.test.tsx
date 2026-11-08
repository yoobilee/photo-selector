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
    vi.unstubAllGlobals()
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
    expect(screen.getByText(/JPEG, PNG, WebP, HEIC 형식을 지원합니다/)).toBeInTheDocument()
    // HEIC는 브라우저가 직접 열 수 있을 때만 된다는 한계와, 앱이 관여할 수 없는 iPhone 선택 화면의 준비 시간을 함께 알린다.
    expect(screen.getByText('HEIC는 사진을 직접 열 수 있는 브라우저(iPhone·Mac의 Safari 17 이상)에서만 추가됩니다.')).toBeInTheDocument()
    expect(screen.getByText(/선택 화면이 닫히기까지 시간이 걸릴 수 있습니다/)).toBeInTheDocument()
  })

  it('opens the file picker that accepts only supported formats', () => {
    render(<App />)
    const input = screen.getByTestId('photo-file-input')
    const clickSpy = vi.spyOn(input, 'click')

    fireEvent.click(screen.getByRole('button', { name: '사진 선택' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(input).toHaveAttribute('multiple')
    expect(input).toHaveAttribute('accept', expect.stringContaining('image/webp'))
    expect(input).toHaveAttribute('accept', expect.stringContaining('image/heic'))
  })

  it('imports a HEIC photo the browser can decode and analyses the original file', async () => {
    render(<App />)
    const heic = createImageFile('IMG_0001.HEIC', 'heif', [1, 2, 3])
    const bytesBefore = await readBytes(heic)

    selectFiles([heic, createImageFile('b.jpg', 'jpeg', [4])])

    await findGallery(2)
    expect(screen.getByRole('img', { name: 'IMG_0001.HEIC' })).toHaveAttribute('src', expect.stringMatching(/^blob:/))
    // 미리보기는 원본과 다른 Blob이고, 분석에는 원본 File 자체를 넘긴다.
    expect(objectUrls.createObjectURL).not.toHaveBeenCalledWith(heic)
    await waitFor(() => expect(sharpnessAnalyzer.analyzedFiles).toContain(heic))
    await finishAnalysis('IMG_0001.HEIC', { status: 'blurry', cause: 'defocus' })
    expect(sharpnessBadgeOf('IMG_0001.HEIC')).toBe('초점 불량 의심')
    await expect(readBytes(heic)).resolves.toEqual(bytesBefore)
  })

  it('explains HEIC photos this browser cannot open and still adds the other photos', async () => {
    // 이 브라우저가 HEIC를 디코딩하지 못하는 경우. 파일은 한 장씩 차례로 처리하므로 첫 파일(HEIC)만 실패한다.
    vi.mocked(createPhotoThumbnail).mockImplementationOnce(async () => {
      throw new Error('decode failed')
    })
    render(<App />)

    selectFiles([createImageFile('IMG_0001.HEIC', 'heif', [1]), createImageFile('b.jpg', 'jpeg', [2])])

    await findGallery(1)
    expect(screen.getByRole('status')).toHaveTextContent('사진 1장을 추가했습니다. 1개 파일은 추가하지 않았습니다.')
    const notice = screen.getByRole('region', { name: '추가하지 않은 파일 1개' })
    expect(within(notice).getByText('이 브라우저에서 열 수 없는 HEIC 사진 1개')).toBeInTheDocument()
    expect(within(notice).getByText(/JPEG로 저장한 사본을 선택하세요/)).toBeInTheDocument()
    expect(within(notice).getByText('IMG_0001.HEIC')).toBeInTheDocument()
    expect(within(notice).queryByText(/열 수 없는 파일/)).not.toBeInTheDocument()
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

  describe('keeping and comparing photos', () => {
    let fingerprints: Record<'portrait' | 'portraitSmall' | 'portraitBright' | 'burstA' | 'burstB' | 'other', PhotoFingerprint>
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
      }
    })

    const keepButton = (name: string, container: HTMLElement = document.body) =>
      within(container).getByRole('button', { name: `${name} 남기기` })
    const keptSummary = () => screen.getByTestId('kept-summary').textContent
    const keptLabelOf = (name: string) =>
      screen.getByRole('img', { name }).closest('li')?.querySelector('[data-testid="kept-label"]')?.textContent ?? null
    const listedNames = (container: HTMLElement) =>
      within(container)
        .getAllByRole('img')
        .map((image) => image.getAttribute('alt'))
    const showView = (name: '모든 사진' | '비슷한 사진끼리 보기' | '남길 사진만 보기') =>
      fireEvent.click(screen.getByRole('button', { name }))
    // 원본 File로 만든 Object URL(비교 화면의 원본 표시)만 센다. 미리보기 URL은 원본과 다른 Blob으로 만든다.
    const originalUrlFiles = () =>
      (objectUrls.createObjectURL.mock.calls as unknown[][])
        .map(([value]) => value)
        .filter((value): value is File => value instanceof File)
        .map((file) => file.name)

    // 사진 다섯 장: a·b·c는 거의 같은 사진, d·e는 연속 촬영, 나머지는 묶음 밖이다.
    async function importGroupedPhotos(names = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg']) {
      render(<App />)
      selectFiles(names.map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(names.length)
      const results: [string, SharpnessResult, PhotoFingerprint][] = [
        ['a.jpg', { status: 'sharp' }, fingerprints.portrait],
        ['b.jpg', { status: 'blurry', cause: 'shake' }, fingerprints.portraitSmall],
        ['c.jpg', { status: 'sharp' }, fingerprints.portraitBright],
        ['d.jpg', { status: 'sharp' }, fingerprints.burstA],
        ['e.jpg', { status: 'sharp' }, fingerprints.burstB],
        ['f.jpg', { status: 'sharp' }, fingerprints.other],
      ]
      for (const [name, result, fingerprint] of results) {
        if (names.includes(name)) await finishAnalysis(name, result, fingerprint)
      }
      await waitFor(() => expect(screen.getByTestId('similar-summary').textContent).not.toBe('비슷한 사진 확인 중'))
    }

    it('lets the user keep several photos, inside or outside a group, and shares the choice across views', async () => {
      await importGroupedPhotos()
      expect(keptSummary()).toBe('남길 사진을 아직 고르지 않았습니다')
      expect(keepButton('a.jpg')).toHaveAttribute('aria-pressed', 'false')

      // 같은 묶음의 두 장과 묶음 밖 사진을 남긴다.
      fireEvent.click(keepButton('a.jpg'))
      fireEvent.click(keepButton('c.jpg'))
      fireEvent.click(keepButton('f.jpg'))
      expect(keptSummary()).toBe('남길 사진 3장')
      expect(keepButton('a.jpg')).toHaveAttribute('aria-pressed', 'true')
      // 색상 말고도 글자로 남긴 사진을 알 수 있다.
      expect(keptLabelOf('a.jpg')).toBe('남김')
      expect(keptLabelOf('b.jpg')).toBeNull()

      // 묶음 보기에서도 같은 상태를 보고 바꿀 수 있다.
      showView('비슷한 사진끼리 보기')
      const same = screen.getByRole('region', { name: '묶음 1 · 거의 같은 사진 3장' })
      expect(keepButton('a.jpg', same)).toHaveAttribute('aria-pressed', 'true')
      expect(keepButton('b.jpg', same)).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(keepButton('c.jpg', same))
      fireEvent.click(keepButton('e.jpg'))
      expect(keptSummary()).toBe('남길 사진 3장')

      // 남길 사진만 모아 보고, 남기지 않은 사진은 지우거나 숨기지 않는다.
      showView('남길 사진만 보기')
      expect(listedNames(screen.getByRole('list'))).toEqual(['a.jpg', 'e.jpg', 'f.jpg'])
      expect(screen.getByText('남기지 않은 사진 3장도 지워지지 않으며 ‘모든 사진’에서 볼 수 있습니다.')).toBeInTheDocument()
      // 남길 사진 보기에서도 묶음 번호를 보여 준다.
      expect(screen.getAllByTestId('similar-group-badge').map((badge) => badge.textContent)).toEqual([
        '묶음 1비슷한 사진 묶음 1',
        '묶음 2비슷한 사진 묶음 2',
      ])

      showView('모든 사진')
      expect(listedNames(screen.getByRole('list'))).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg'])
      expect(screen.getByRole('heading', { level: 2, name: '선택한 사진 6장' })).toBeInTheDocument()
    })

    it('does not restart blur or similarity analysis when the user keeps photos', async () => {
      await importGroupedPhotos()
      const analyzedBefore = analyzedNames()
      const summaryBefore = screen.getByTestId('similar-summary').textContent

      for (const name of ['a.jpg', 'b.jpg', 'd.jpg']) fireEvent.click(keepButton(name))
      fireEvent.click(keepButton('b.jpg'))

      expect(analyzedNames()).toEqual(analyzedBefore)
      expect(sharpnessAnalyzer.pending).toHaveLength(0)
      expect(screen.getByTestId('similar-summary').textContent).toBe(summaryBefore)
      expect(screen.getByText('흔들림 의심')).toBeInTheDocument()
    })

    it('keeps the choice while groups are recalculated and forgets photos removed from the list', async () => {
      render(<App />)
      selectFiles(['a.jpg', 'b.jpg', 'c.jpg'].map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(3)
      // 분석이 끝나기 전에 고른 선택도 묶음이 생기고 바뀌는 동안 유지된다.
      fireEvent.click(keepButton('b.jpg'))
      showView('비슷한 사진끼리 보기')
      await finishAnalysis('a.jpg', { status: 'sharp' }, fingerprints.portrait)
      await finishAnalysis('b.jpg', { status: 'sharp' }, fingerprints.portraitSmall)
      const group = await screen.findByRole('region', { name: '묶음 1 · 거의 같은 사진 2장' })
      expect(keepButton('b.jpg', group)).toHaveAttribute('aria-pressed', 'true')
      await finishAnalysis('c.jpg', { status: 'sharp' }, fingerprints.portraitBright)
      const grown = await screen.findByRole('region', { name: '묶음 1 · 거의 같은 사진 3장' })
      expect(keepButton('b.jpg', grown)).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(keepButton('c.jpg', grown))
      expect(keptSummary()).toBe('남길 사진 2장')

      // 남긴 사진을 목록에서 제거하면 남길 사진에서도 빠진다.
      fireEvent.click(within(grown).getByRole('button', { name: 'b.jpg 목록에서 제거' }))
      await findGallery(2)
      expect(keptSummary()).toBe('남길 사진 1장')
      showView('남길 사진만 보기')
      expect(listedNames(screen.getByRole('list'))).toEqual(['c.jpg'])

      // 같은 파일을 다시 가져와도 새 사진이므로 남기지 않은 상태로 시작한다.
      selectFiles([createImageFile('b.jpg', 'jpeg', [1])])
      await findGallery(3)
      expect(keptSummary()).toBe('남길 사진 1장')
      showView('모든 사진')
      expect(keepButton('b.jpg')).toHaveAttribute('aria-pressed', 'false')
    })

    it('keeps showing the preview with a notice when the original cannot be shown in the comparison', async () => {
      await importGroupedPhotos(['a.jpg', 'b.jpg', 'c.jpg'])
      showView('비슷한 사진끼리 보기')
      const urlsBefore = objectUrls.liveUrls.size
      fireEvent.click(screen.getByRole('button', { name: '묶음 1 크게 비교' }))
      const dialog = screen.getByRole('dialog')

      // 예: 브라우저가 큰 원본(HEIC 등)을 표시하지 못함. 미리보기를 그대로 두고 그 사실을 글로 알린다.
      fireEvent.error(within(dialog).getByTestId('original-image'))
      expect(within(dialog).getByTestId('original-preview')).toBeInTheDocument()
      expect(within(dialog).getByText('원본을 표시하지 못해 작은 미리보기를 보여 줍니다.')).toBeInTheDocument()
      expect(objectUrls.liveUrls.size).toBe(urlsBefore + 1)

      // 다음 사진은 원본을 새로 읽으므로 안내가 사라지고, 앞 사진의 원본 URL은 해제된다.
      fireEvent.click(within(dialog).getByRole('button', { name: '다음 사진' }))
      expect(within(dialog).queryByText('원본을 표시하지 못해 작은 미리보기를 보여 줍니다.')).not.toBeInTheDocument()
      expect(objectUrls.liveUrls.size).toBe(urlsBefore + 1)

      fireEvent.click(within(dialog).getByRole('button', { name: '비교 닫기' }))
      expect(objectUrls.liveUrls.size).toBe(urlsBefore)
    })

    it('moves keyboard focus to a neighbor when a photo is unkept in the kept-only view', async () => {
      await importGroupedPhotos(['a.jpg', 'f.jpg'])
      fireEvent.click(keepButton('a.jpg'))
      fireEvent.click(keepButton('f.jpg'))
      showView('남길 사진만 보기')

      keepButton('a.jpg').focus()
      fireEvent.click(keepButton('a.jpg'))
      expect(screen.queryByRole('img', { name: 'a.jpg' })).not.toBeInTheDocument()
      expect(keepButton('f.jpg')).toHaveFocus()

      fireEvent.click(keepButton('f.jpg'))
      expect(screen.getByText(/남기기로 표시한 사진이 없습니다/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '남길 사진만 보기' })).toHaveFocus()
      expect(screen.getByText('남기지 않은 사진 2장도 지워지지 않으며 ‘모든 사진’에서 볼 수 있습니다.')).toBeInTheDocument()
    })

    it('compares a group one photo at a time on narrow screens, reading only the visible original', async () => {
      await importGroupedPhotos()
      showView('비슷한 사진끼리 보기')
      const openButton = screen.getByRole('button', { name: '묶음 1 크게 비교' })
      openButton.focus()
      const urlsBefore = objectUrls.liveUrls.size

      fireEvent.click(openButton)

      const dialog = screen.getByRole('dialog', { name: '묶음 1 · 거의 같은 사진 크게 비교' })
      // 초점이 비교 화면 안으로 옮겨진다.
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
      expect(within(dialog).getByTestId('compare-position')).toHaveTextContent('1 / 3')
      expect(within(dialog).getAllByTestId('compare-pane')).toHaveLength(1)
      // 원본은 보이는 한 장만 읽고, 나머지는 이미 있는 미리보기로 보여 준다.
      expect(originalUrlFiles()).toEqual(['a.jpg'])
      expect(objectUrls.liveUrls.size).toBe(urlsBefore + 1)
      expect(within(dialog).getByRole('img', { name: 'a.jpg' })).toHaveAttribute('src', expect.stringMatching(/^blob:/))
      expect(within(dialog).getByText('흐림 의심 없음')).toBeInTheDocument()
      // 원본을 다 읽기 전에는 미리보기를 보여 주고, 다 읽으면 미리보기를 치운다(투명 영역이 겹쳐 보이지 않게).
      expect(within(dialog).getByTestId('original-preview')).toHaveAttribute('src', screen.getAllByRole('img', { name: 'a.jpg' })[0]!.getAttribute('src'))
      fireEvent.load(within(dialog).getByTestId('original-image'))
      expect(within(dialog).queryByTestId('original-preview')).not.toBeInTheDocument()

      // 넘기면 앞 사진의 원본을 바로 해제한다.
      fireEvent.click(within(dialog).getByRole('button', { name: '다음 사진' }))
      expect(within(dialog).getByTestId('compare-position')).toHaveTextContent('2 / 3')
      expect(within(dialog).getByText('흔들림 의심: 윤곽이 한 방향으로 번져 있습니다')).toBeInTheDocument()
      expect(originalUrlFiles()).toEqual(['a.jpg', 'b.jpg'])
      expect(objectUrls.liveUrls.size).toBe(urlsBefore + 1)
      expect(screen.getByText('b.jpg · 2 / 3', { selector: '[aria-live]' })).toBeInTheDocument()

      // 방향키와 사진 목록으로도 넘긴다. 끝에서는 더 넘어가지 않는다.
      fireEvent.keyDown(dialog, { key: 'ArrowRight' })
      fireEvent.keyDown(dialog, { key: 'ArrowRight' })
      expect(within(dialog).getByTestId('compare-position')).toHaveTextContent('3 / 3')
      expect(within(dialog).getByRole('button', { name: '다음 사진' })).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(within(dialog).getByRole('button', { name: 'a.jpg 보기' }))
      expect(within(dialog).getByTestId('compare-position')).toHaveTextContent('1 / 3')
      expect(within(dialog).getByRole('button', { name: 'a.jpg 보기' })).toHaveAttribute('aria-current', 'true')

      // 비교 중 남기기를 바꾸면 갤러리에도 그대로 반영된다.
      fireEvent.click(keepButton('a.jpg', dialog))
      expect(keepButton('a.jpg', dialog)).toHaveAttribute('aria-pressed', 'true')
      expect(within(dialog).getByRole('button', { name: 'a.jpg 보기, 남김' })).toBeInTheDocument()
      expect(keptSummary()).toBe('남길 사진 1장')

      // 닫으면 원본 URL을 모두 해제하고 비교를 연 버튼으로 초점을 돌린다.
      fireEvent.click(within(dialog).getByRole('button', { name: '비교 닫기' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(objectUrls.liveUrls.size).toBe(urlsBefore)
      expect(screen.getByRole('button', { name: '묶음 1 크게 비교' })).toHaveFocus()
      const group = screen.getByRole('region', { name: '묶음 1 · 거의 같은 사진 3장' })
      expect(keepButton('a.jpg', group)).toHaveAttribute('aria-pressed', 'true')
    })

    it('shows two photos side by side on wide screens and keeps focus on the same pane while navigating', async () => {
      const matchMedia = vi.fn((query: string) => ({
        matches: query === '(min-width: 768px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
      vi.stubGlobal('matchMedia', matchMedia)
      try {
        await importGroupedPhotos()
        showView('비슷한 사진끼리 보기')
        fireEvent.click(screen.getByRole('button', { name: '묶음 1 크게 비교' }))
        const dialog = screen.getByRole('dialog')

        expect(within(dialog).getAllByTestId('compare-pane')).toHaveLength(2)
        expect(within(dialog).getByTestId('compare-position')).toHaveTextContent('1–2 / 3')
        expect(originalUrlFiles()).toEqual(['a.jpg', 'b.jpg'])

        // 오른쪽 칸의 남기기 버튼에 초점을 두고 넘기면, 새로 보이는 같은 칸의 남기기 버튼이 초점을 받는다.
        keepButton('b.jpg', dialog).focus()
        fireEvent.keyDown(dialog, { key: 'ArrowRight' })
        expect(within(dialog).getByTestId('compare-position')).toHaveTextContent('2–3 / 3')
        expect(keepButton('b.jpg', dialog)).toHaveFocus()
        fireEvent.click(within(dialog).getByRole('button', { name: '이전 사진' }))
        keepButton('b.jpg', dialog).focus()
        fireEvent.keyDown(dialog, { key: 'ArrowRight' })
        expect(keepButton('b.jpg', dialog)).toHaveFocus()
        // 왼쪽 칸이 사라지면(a → b) 같은 왼쪽 칸의 새 사진 버튼으로 옮긴다.
        fireEvent.keyDown(dialog, { key: 'ArrowLeft' })
        keepButton('a.jpg', dialog).focus()
        fireEvent.keyDown(dialog, { key: 'ArrowRight' })
        expect(keepButton('b.jpg', dialog)).toHaveFocus()
        // 두 장 묶음 끝까지 넘겨도 원본은 보이는 두 장만 남아 있다.
        expect(within(dialog).getAllByTestId('original-image')).toHaveLength(2)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('keeps comparing the same photos while analysis changes the groups', async () => {
      // 천천히 옮겨 찍은 세 장: c가 들어오면 묶음이 a·b에서 b·c로 바뀐다(a-c는 비슷하지 않음).
      const pan = renderWideScene(4)
      const [panStart, panMiddle, panEnd] = [viewOf(pan), viewOf(pan, 16, 8), viewOf(pan, 32, 16)].map(fingerprintOf)
      render(<App />)
      selectFiles(['a.jpg', 'b.jpg', 'c.jpg'].map((name, index) => createImageFile(name, 'jpeg', [index])))
      await findGallery(3)
      await finishAnalysis('a.jpg', { status: 'sharp' }, panStart)
      await finishAnalysis('b.jpg', { status: 'sharp' }, panMiddle)
      showView('비슷한 사진끼리 보기')
      await screen.findByRole('region', { name: '묶음 1 · 비슷한 사진 2장' })
      fireEvent.click(screen.getByRole('button', { name: '묶음 1 크게 비교' }))
      const dialog = screen.getByRole('dialog')

      await finishAnalysis('c.jpg', { status: 'blurry', cause: 'defocus' }, panEnd)
      await waitFor(() =>
        expect(within(screen.getByRole('region', { name: '묶음 1 · 비슷한 사진 2장' })).queryByRole('img', { name: 'a.jpg' })).toBeNull(),
      )
      // 비교 화면은 연 때의 사진을 그대로 비교한다.
      expect(within(dialog).getByTestId('compare-position')).toHaveTextContent('1 / 2')
      expect(within(dialog).getByRole('img', { name: 'a.jpg' })).toBeInTheDocument()
      expect(
        within(dialog)
          .getAllByRole('button', { name: /보기/ })
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(['a.jpg 보기', 'b.jpg 보기'])

      // 닫기(Esc 포함)는 dialog의 close 이벤트로 처리한다. 비교를 연 버튼이 남아 있으면 그 버튼으로 초점을 돌린다.
      act(() => (dialog as HTMLDialogElement).close())
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '묶음 1 크게 비교' })).toHaveFocus()
    })

    it('turns pages with a one-finger swipe but not while pinching or zoomed in', async () => {
      // 브라우저의 확대 배율(visualViewport)을 흉내 낸다. 비교 화면이 열릴 때 바뀜 알림을 구독하므로 먼저 설치한다.
      const viewport = Object.assign(new EventTarget(), { scale: 1 })
      vi.stubGlobal('visualViewport', viewport)
      await importGroupedPhotos()
      showView('비슷한 사진끼리 보기')
      fireEvent.click(screen.getByRole('button', { name: '묶음 1 크게 비교' }))
      const dialog = screen.getByRole('dialog')
      const panes = within(dialog).getByTestId('compare-panes')
      const position = () => within(dialog).getByTestId('compare-position').textContent
      const touch = (type: 'pointerDown' | 'pointerUp', pointerId: number, clientX: number) =>
        fireEvent[type](panes, { pointerType: 'touch', pointerId, clientX, clientY: 200 })

      // 두 손가락 확대·축소는 사진을 넘기지 않는다.
      touch('pointerDown', 1, 300)
      touch('pointerDown', 2, 200)
      touch('pointerUp', 2, 60)
      touch('pointerUp', 1, 100)
      expect(position()).toBe('1 / 3')

      // 한 손가락으로 왼쪽으로 밀면 다음 사진이다.
      touch('pointerDown', 3, 300)
      touch('pointerUp', 3, 100)
      expect(position()).toBe('2 / 3')

      expect(panes).toHaveClass('touch-pan-y', 'touch-pinch-zoom')

      // 확대한 상태에서 미는 것은 확대한 화면을 옮기는 동작이다. 가로 이동도 브라우저에 맡긴다.
      try {
        viewport.scale = 2
        act(() => viewport.dispatchEvent(new Event('resize')))
        expect(panes).toHaveClass('touch-manipulation')
        expect(panes).not.toHaveClass('touch-pan-y')
        touch('pointerDown', 4, 300)
        touch('pointerUp', 4, 100)
        expect(position()).toBe('2 / 3')

        // 다시 원래 크기로 돌아오면 가로 밀기로 넘긴다.
        viewport.scale = 1
        act(() => viewport.dispatchEvent(new Event('resize')))
        expect(panes).toHaveClass('touch-pan-y', 'touch-pinch-zoom')
        touch('pointerDown', 5, 100)
        touch('pointerUp', 5, 300)
        expect(position()).toBe('1 / 3')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('reads no original image until the comparison is opened', async () => {
      await importGroupedPhotos()
      fireEvent.click(keepButton('a.jpg'))
      showView('비슷한 사진끼리 보기')
      showView('남길 사진만 보기')
      expect(originalUrlFiles()).toEqual([])
    })
  })
})
