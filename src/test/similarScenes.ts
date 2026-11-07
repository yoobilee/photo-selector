import { createPhotoFingerprint, type PhotoFingerprint } from '../photos/photoFingerprint.ts'
import type { GrayImage } from '../photos/sharpness.ts'
import { cropImage } from './photoVariants.ts'
import { gaussianBlur, renderScene } from './syntheticImages.ts'

// 비슷한 사진 테스트용 합성 장면. 넓게 그린 장면을 잘라 카메라를 조금 움직여 찍은 사진(연속 촬영)을 흉내 낸다.
export const VIEW_WIDTH = 512
export const VIEW_HEIGHT = 384

// 보기 크기보다 10% 넓은 장면. 같은 seed는 같은 장면이다.
export function renderWideScene(seed: number): GrayImage {
  return gaussianBlur(renderScene(Math.round(VIEW_WIDTH * 1.1), Math.round(VIEW_HEIGHT * 1.1), seed), 0.8)
}

// 넓은 장면에서 (dx, dy)화소 옮긴 위치를 잘라 낸 사진. 64×64 비교 크기에서 8화소가 1화소다.
export function viewOf(wide: GrayImage, dx = 0, dy = 0): GrayImage {
  return cropImage(wide, dx, dy, VIEW_WIDTH, VIEW_HEIGHT)
}

export function fingerprintOf(image: GrayImage): PhotoFingerprint {
  const fingerprint = createPhotoFingerprint(image)
  if (!fingerprint) throw new Error('Image is too small to fingerprint')
  return fingerprint
}
