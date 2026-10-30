import { crc32, deflateSync } from 'node:zlib'
import type { GrayImage } from '../../src/photos/sharpness.ts'

// 합성 밝기 이미지를 8비트 회색조 PNG로 만든다. 같은 입력은 항상 같은 바이트가 되므로 고정 파일을 저장소에 두지 않는다.
export function encodeGrayPng(image: GrayImage): Buffer {
  const { width, height, pixels } = image
  const rows = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    // 각 행 앞의 0은 필터 없음이다.
    const offset = y * (width + 1)
    rows[offset] = 0
    for (let x = 0; x < width; x += 1) {
      rows[offset + 1 + x] = Math.round(Math.min(255, Math.max(0, pixels[y * width + x]!)))
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  // 비트 깊이 8, 회색조(0), 압축·필터·인터레이스 기본값
  header.set([8, 0, 0, 0, 0], 8)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, checksum])
}
