/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// 기본 빌드(dist)는 사용자 앱(index.html)만 포함한다. 개발용 흐림 판정 평가 도구(calibration.html)는
// 개발 서버(`npm run calibrate`)와 E2E용 평가 빌드(`npm run build:calibration` → dist-calibration)에서만 쓴다.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build:
    mode === 'calibration'
      ? {
          outDir: 'dist-calibration',
          rollupOptions: { input: fileURLToPath(new URL('./calibration.html', import.meta.url)) },
        }
      : undefined,
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
}))
