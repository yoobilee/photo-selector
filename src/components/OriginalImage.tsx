import { useEffect, useRef, useState } from 'react'

interface OriginalImageProps {
  file: File
  alt: string
  className: string
}

// 원본 파일을 화면에 그대로 보여 준다. Object URL은 원본 바이트를 복사하지 않고 가리키기만 하며,
// 이 이미지가 화면에 있는 동안만 만들고 사라지면 바로 해제한다. 원본은 읽기만 하고 바꾸지 않는다.
// 다 읽기 전에는 투명하게 두어 아래에 깔린 미리보기가 보이고, 읽지 못하면 미리보기를 그대로 둔다.
function OriginalImage({ file, alt, className }: OriginalImageProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [loadedFile, setLoadedFile] = useState<File | null>(null)

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
    <img
      ref={imageRef}
      alt={alt}
      decoding="async"
      data-testid="original-image"
      onLoad={() => setLoadedFile(file)}
      className={`${className} ${loadedFile === file ? 'opacity-100' : 'opacity-0'}`}
    />
  )
}

export default OriginalImage
