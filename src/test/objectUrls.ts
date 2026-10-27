import { vi } from 'vitest'

// jsdom에는 Object URL API가 없으므로 생성·해제를 추적하는 테스트용 구현을 설치한다.
export function installObjectUrlTracker() {
  const liveUrls = new Set<string>()
  let createdCount = 0

  const createObjectURL = vi.fn(() => {
    createdCount += 1
    const url = `blob:test/${createdCount}`
    liveUrls.add(url)
    return url
  })
  const revokeObjectURL = vi.fn((url: string) => {
    liveUrls.delete(url)
  })

  const original = {
    createObjectURL: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  }
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })

  const restore = () => {
    for (const key of ['createObjectURL', 'revokeObjectURL'] as const) {
      const descriptor = original[key]
      if (descriptor) Object.defineProperty(URL, key, descriptor)
      else Reflect.deleteProperty(URL, key)
    }
  }

  return { liveUrls, createObjectURL, revokeObjectURL, restore }
}
