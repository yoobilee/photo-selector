import { beforeAll, describe, expect, it } from 'vitest'
import { adjustTone, cropImage, jpegLike, matchTone, resizeBilinear } from '../test/photoVariants.ts'
import { fingerprintOf, renderWideScene, VIEW_HEIGHT, VIEW_WIDTH, viewOf } from '../test/similarScenes.ts'
import {
  addNoise,
  composite,
  gaussianBlur,
  motionBlur,
  renderBricks,
  renderChecker,
  renderGradient,
  renderHorizon,
  renderScene,
  renderStripes,
  renderUniform,
} from '../test/syntheticImages.ts'
import type { GrayImage } from './sharpness.ts'
import {
  comparePhotos,
  measureStructure,
  orderPair,
  prepareFingerprint,
  type PhotoComparison,
  type PhotoRelationKind,
} from './photoSimilarity.ts'

// 합성 이미지로 판정 규칙을 확인한다. 실제 카메라 사진으로 검증한 결과가 아니며, 통과해도 실제 사진에서의 정확도를 보장하지 않는다.
const prepared = (image: GrayImage) => prepareFingerprint(fingerprintOf(image))
const compare = (first: GrayImage, second: GrayImage): PhotoComparison => comparePhotos(prepared(first), prepared(second))
const kindOf = (first: GrayImage, second: GrayImage): PhotoRelationKind => compare(first, second).kind
const LINKED: readonly PhotoRelationKind[] = ['same', 'similar']
const NOT_LINKED: readonly PhotoRelationKind[] = ['uncertain', 'different', 'incomparable']
const lens = (image: GrayImage) => gaussianBlur(image, 0.8)

describe('comparePhotos', () => {
  describe('the same photo saved differently', () => {
    let original: GrayImage
    beforeAll(() => {
      original = lens(renderScene(1024, 768, 21))
    })

    it('treats other resolutions and JPEG compression levels as almost the same photo', () => {
      const smaller = resizeBilinear(original, 640, 480)
      expect(kindOf(original, smaller)).toBe('same')
      expect(kindOf(original, jpegLike(smaller, 40))).toBe('same')
      expect(kindOf(original, jpegLike(resizeBilinear(original, 800, 600), 20))).toBe('same')
    })

    it('treats brightness, contrast and gamma changes as almost the same photo', () => {
      expect(kindOf(original, adjustTone(original, { gain: 0.7, offset: 40 }))).toBe('same')
      expect(kindOf(original, adjustTone(original, { gain: 1.3, offset: -30 }))).toBe('same')
      expect(kindOf(original, adjustTone(original, { gamma: 0.7 }))).toBe('same')
    })

    it('treats blur and noise that the 64×64 comparison cannot see as almost the same photo', () => {
      // 흐림 차이는 묶음 안의 흐림 표시로 구분한다.
      expect(kindOf(original, gaussianBlur(original, 2.5))).toBe('same')
      expect(kindOf(original, motionBlur(original, 25))).toBe('same')
      expect(kindOf(original, addNoise(original, 6, 3))).toBe('same')
    })

    it('gives the same result whichever photo comes first', () => {
      const smaller = jpegLike(resizeBilinear(original, 640, 480), 40)
      expect(compare(original, smaller)).toEqual(compare(smaller, original))
    })
  })

  describe('another moment of the same scene', () => {
    let wide: GrayImage
    let other: GrayImage
    beforeAll(() => {
      wide = renderWideScene(21)
      other = lens(renderScene(VIEW_WIDTH, VIEW_HEIGHT, 77))
    })

    it('groups a camera move of up to about 5% of the frame as similar, not as the same photo', () => {
      // 64×64 비교 크기에서 1, 2, 3화소 이동이다.
      for (const [dx, dy] of [[8, 4], [16, 8], [24, 16]] as const) {
        expect(kindOf(viewOf(wide), viewOf(wide, dx, dy))).toBe('similar')
      }
    })

    it('groups a photo where a small part changed (expression, movement) as similar', () => {
      const changedFace = composite(viewOf(wide), other, { x: 0.3, y: 0.3, w: 0.25, h: 0.25 })
      expect(kindOf(viewOf(wide), changedFace)).toBe('similar')
      const movedAndChanged = composite(viewOf(wide, 8, 4), other, { x: 0.25, y: 0.25, w: 0.5, h: 0.3 })
      expect(kindOf(viewOf(wide), movedAndChanged)).toBe('similar')
    })

    it('keeps photos near the threshold out of groups', () => {
      // 이동이 비교 범위(64×64에서 3화소)를 넘거나 사진의 1/4이 바뀌면 경계로 두고 묶지 않는다.
      expect(NOT_LINKED).toContain(kindOf(viewOf(wide), viewOf(wide, 32, 16)))
      const halfChanged = composite(viewOf(wide), other, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 })
      expect(kindOf(viewOf(wide), halfChanged)).toBe('uncertain')
    })
  })

  describe('different photos', () => {
    it('never links different scenes even when their brightness and contrast match', () => {
      const scenes = Array.from({ length: 10 }, (_, index) => lens(renderScene(VIEW_WIDTH, VIEW_HEIGHT, 100 + index)))
      for (let first = 0; first < scenes.length; first += 1) {
        for (let second = first + 1; second < scenes.length; second += 1) {
          const lookalike = matchTone(scenes[second]!, scenes[first]!)
          expect(kindOf(scenes[first]!, lookalike)).toBe('different')
          // pHash에서 걸러지지 않았더라도 윤곽 구조는 크게 다르다(여유 확인).
          const [a, b] = orderPair(prepared(scenes[first]!), prepared(lookalike))
          const structure = measureStructure(a, b, { full: true })
          expect(structure.correlation).toBeLessThan(0.25)
          expect(structure.matchedCells / structure.detailedCells).toBeLessThan(0.25)
        }
      }
    })

    it('does not link repetitive patterns of different scenes', () => {
      const bricks = lens(renderBricks(1024, 768))
      const smallerBricks = lens(resizeBilinear(renderBricks(1600, 1200), 1024, 768))
      const stripes = lens(renderStripes(1024, 768, 48, 0))
      expect(NOT_LINKED).toContain(kindOf(bricks, smallerBricks))
      expect(NOT_LINKED).toContain(kindOf(stripes, lens(renderStripes(1024, 768, 48, 20))))
      expect(NOT_LINKED).toContain(kindOf(stripes, lens(renderStripes(1024, 768, 64, 0))))
      expect(NOT_LINKED).toContain(kindOf(lens(renderChecker(1024, 768, 32)), lens(renderChecker(1024, 768, 40))))
      expect(NOT_LINKED).toContain(kindOf(lens(renderChecker(1024, 768, 32)), bricks))
    })

    it('does not trust alignment on strongly repeating patterns, even for a shifted copy', () => {
      // 줄무늬·바둑판은 여러 위치에서 맞아 같은 장면인지 구분할 수 없으므로 묶지 않는다.
      const stripes = lens(renderStripes(1100, 800, 48, 0))
      const checker = lens(renderChecker(1100, 800, 32))
      expect(NOT_LINKED).toContain(kindOf(cropImage(stripes, 0, 0, 1024, 768), cropImage(stripes, 10, 13, 1024, 768)))
      expect(NOT_LINKED).toContain(kindOf(cropImage(checker, 0, 0, 1024, 768), cropImage(checker, 10, 13, 1024, 768)))
      expect(prepared(cropImage(stripes, 0, 0, 1024, 768)).repetitive).toBe(true)
      expect(prepared(viewOf(renderWideScene(21))).repetitive).toBe(false)
    })

    it('does not link different scenes that share a horizon and layout', () => {
      const horizon = lens(renderHorizon(1024, 768))
      const landscape = (seed: number) => composite(horizon, lens(renderScene(1024, 768, seed)), { x: 0, y: 0.5, w: 1, h: 0.5 })
      expect(NOT_LINKED).toContain(kindOf(landscape(5), landscape(6)))
    })

    it('does not link photos with different aspect ratios', () => {
      const wide = renderWideScene(21)
      expect(kindOf(viewOf(wide), cropImage(wide, 0, 0, VIEW_WIDTH, VIEW_WIDTH))).toBe('different')
    })
  })

  describe('photos without enough outlines', () => {
    it('does not compare plain walls, smooth skies or noise, whatever their brightness', () => {
      expect(kindOf(renderUniform(800, 600, 150), renderUniform(800, 600, 90))).toBe('incomparable')
      expect(kindOf(renderGradient(800, 600), renderGradient(800, 600, 40, 230))).toBe('incomparable')
      expect(kindOf(addNoise(renderGradient(800, 600), 4, 1), addNoise(renderGradient(800, 600), 4, 2))).toBe('incomparable')
      expect(kindOf(renderGradient(800, 600), lens(renderScene(800, 600, 3)))).toBe('incomparable')
    })
  })

  describe('known limits (synthetic reproductions)', () => {
    it('cannot tell apart scenes that differ only in details smaller than 1/64 of the frame', () => {
      // 64×64로 줄이면 사라지는 작은 세부만 다르고 큰 형태가 같은 사진은 비슷한 사진으로 묶인다.
      const layout = gaussianBlur(renderScene(1024, 768, 21), 12)
      const withDetails = (seed: number) => {
        const details = renderScene(1024, 768, seed)
        const smooth = gaussianBlur(details, 8)
        return { ...layout, pixels: layout.pixels.map((value, index) => value + 0.6 * (details.pixels[index]! - smooth.pixels[index]!)) }
      }
      expect(LINKED).toContain(kindOf(withDetails(30), withDetails(31)))
    })

    it('misses a zoomed shot of the same scene', () => {
      // 같은 장면을 약 7% 확대해 찍으면 이동만으로 맞출 수 없어 묶지 않는다.
      const zoomed = lens(cropImage(renderScene(1100, 825, 21), 0, 0, 1024, 768))
      expect(NOT_LINKED).toContain(kindOf(lens(renderScene(1024, 768, 21)), zoomed))
    })
  })
})
