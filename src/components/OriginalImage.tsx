import { useEffect, useRef, useState } from 'react'

interface OriginalImageProps {
  file: File
  // 원본을 읽는 동안 먼저 보여 줄 미리보기
  previewUrl: string
  alt: string
  className: string
}

// 원본 파일을 화면에 그대로 보여 준다. Object URL은 원본 바이트를 복사하지 않고 가리키기만 하며,
// 이 이미지가 화면에 있는 동안만 만들고 사라지면 바로 해제한다. 원본은 읽기만 하고 바꾸지 않는다.
// 다 읽기 전에는 미리보기를 보여 주고, 다 읽으면 미리보기를 치운다(투명 영역이 있는 원본이 미리보기와 겹쳐 보이지 않게).
// 원본을 표시하지 못하면(예: 큰 HEIC를 브라우저가 열지 못함) 미리보기를 그대로 두고 그 사실을 알린다.
function OriginalImage({ file, previewUrl, alt, className }: OriginalImageProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [loadedFile, setLoadedFile] = useState<File | null>(null)
  const [failedFile, setFailedFile] = useState<File | null>(null)
  const isLoaded = loadedFile === file
  const hasFailed = failedFile === file

  useEffect(() => {
    const image = imageRef.current
    if (!image) return
    const url = URL.createObjectURL(file)
    image.src = url
    return () => {
      image.removeAttribute('src')
      URL.revokeObjectURL(url)
    }
  }, [file])

  return (
    <>
      {!isLoaded && (
        <img src={previewUrl} alt="" aria-hidden="true" data-testid="original-preview" className={className} />
      )}
      <img
        ref={imageRef}
        alt={alt}
        decoding="async"
        data-testid="original-image"
        onLoad={() => setLoadedFile(file)}
        onError={(event) => {
          // src를 지울 때 일부 브라우저가 error를 내므로 원본을 가리키는 동안의 실패만 기록한다.
          if (event.currentTarget.getAttribute('src')) setFailedFile(file)
        }}
        className={`${className} ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
      />
      {hasFailed && !isLoaded && (
        <p
          data-testid="original-fallback-note"
          className="absolute right-1 bottom-1 left-1 rounded bg-white/90 px-1.5 py-0.5 text-xs font-semibold text-neutral-900 ring-1 ring-neutral-400"
        >
          원본을 표시하지 못해 작은 미리보기를 보여 줍니다.
        </p>
      )}
    </>
  )
}

export default OriginalImage
