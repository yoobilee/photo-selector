import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { createPhotoThumbnail, type PhotoThumbnail } from './photos/createPhotoThumbnail.ts'
import { createImageFile, createTextFile } from './test/imageFiles.ts'
import { installObjectUrlTracker } from './test/objectUrls.ts'

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
})
