// 실제 이미지 디코딩 없이 형식 판별과 가져오기 흐름을 검증하기 위한 테스트용 파일
const signatures = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  webp: [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
  gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
} as const

const mimeTypes = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
} as const

export type TestImageFormat = keyof typeof signatures

export function createImageFile(name: string, format: TestImageFormat, body: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array([...signatures[format], ...body])], name, {
    type: mimeTypes[format],
  })
}

export function createTextFile(name: string, text = 'not an image'): File {
  return new File([text], name, { type: 'text/plain' })
}

export async function readBytes(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}
