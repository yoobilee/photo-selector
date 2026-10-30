import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { createPhotoThumbnail, type PhotoThumbnail } from './photos/createPhotoThumbnail.ts'
import type { SharpnessResult } from './photos/sharpness.ts'
import { createImageFile, createTextFile, readBytes } from './test/imageFiles.ts'
import { installObjectUrlTracker } from './test/objectUrls.ts'

// jsdom에는 Web Worker와 이미지 디코딩이 없으므로 흐림 분석기를 테스트에서 직접 끝내는 가짜로 바꾼다.
// 실제 판정은 sharpness.test.ts, 실제 브라우저 Worker는 E2E에서 확인한다.
const sharpnessAnalyzer = vi.hoisted(() => ({
  pending: [] as { file: Blob; resolve: (result: SharpnessResult) => void }[],
  analyzedFiles: [] as Blob[],
  disposeCount: 0,
}))
vi.mock('./photos/sharpnessWorkerClient.ts', () => ({
  createSharpnessWorkerAnalyzer: () => ({
    analyze: (file: Blob) =>
      new Promise<SharpnessResult>((resolve) => {
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
async function finishAnalysis(name: string, result: SharpnessResult) {
  await waitFor(() => expect(sharpnessAnalyzer.pending.some(({ file }) => (file as File).name === name)).toBe(true))
  const index = sharpnessAnalyzer.pending.findIndex(({ file }) => (file as File).name === name)
  const [job] = sharpnessAnalyzer.pending.splice(index, 1)
  await act(async () => job!.resolve(result))
}

const sharpnessBadgeOf = (name: string) =>
  screen.getByRole('img', { name }).closest('li')?.querySelector('[data-testid="sharpness-badge"]')?.textContent ?? null

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
    it('shows progress while analyzing and then badges only blurry and undecidable photos', async () => {
      render(<App />)
      selectFiles([
        createImageFile('sharp.jpg', 'jpeg', [1]),
        createImageFile('blurry.jpg', 'jpeg', [2]),
        createImageFile('wall.jpg', 'jpeg', [3]),
      ])
      await findGallery(3)

      expect(screen.getByText('흐림 확인 중 0/3장')).toBeInTheDocument()
      expect(screen.getByRole('img', { name: 'sharp.jpg' })).toHaveAccessibleDescription('흐림 확인 중')
      expect(sharpnessBadgeOf('wall.jpg')).toBe('확인 중')

      await finishAnalysis('sharp.jpg', { status: 'sharp' })
      expect(screen.getByText('흐림 확인 중 1/3장')).toBeInTheDocument()
      await finishAnalysis('blurry.jpg', { status: 'blurry' })
      await finishAnalysis('wall.jpg', { status: 'unavailable', reason: 'low-detail' })

      expect(screen.getByRole('img', { name: 'sharp.jpg' })).toHaveAccessibleDescription('흐림 의심 없음')
      expect(sharpnessBadgeOf('sharp.jpg')).toBeNull()
      expect(screen.getByRole('img', { name: 'blurry.jpg' })).toHaveAccessibleDescription('흐림 의심')
      expect(sharpnessBadgeOf('blurry.jpg')).toBe('흐림 의심')
      expect(screen.getByRole('img', { name: 'wall.jpg' })).toHaveAccessibleDescription(
        '흐림 분석 불가: 윤곽이 적거나 잡음이 많아 판정할 수 없습니다',
      )
      expect(sharpnessBadgeOf('wall.jpg')).toBe('분석 불가')
      // 진행 수는 화면에만 보이고, 낭독용 알림은 시작과 끝에만 바뀐다.
      const summary = '흐림 의심 1장 · 분석 불가 1장'
      expect(screen.getAllByText(summary).map((element) => element.getAttribute('aria-live'))).toEqual([null, 'polite'])
      // 흐림 분석은 기존 가져오기 상태 문장을 바꾸지 않는다.
      expect(screen.getByRole('status')).toHaveTextContent('사진 3장을 추가했습니다.')
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
      await finishAnalysis('b.jpg', { status: 'blurry' })

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
      await finishAnalysis('d.jpg', { status: 'blurry' })

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
      await finishAnalysis('a.jpg', { status: 'blurry' })
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
      await act(async () => sharpnessAnalyzer.pending[0]!.resolve({ status: 'blurry' }))
      expect(objectUrls.liveUrls.size).toBe(0)
    })
  })
})
