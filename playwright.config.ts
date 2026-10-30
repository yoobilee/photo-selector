import { defineConfig, devices } from '@playwright/test'

const previewPort = 4173
// 개발용 흐림 판정 평가 도구는 배포 빌드(dist)에 없으므로 평가 전용 빌드(dist-calibration)를 따로 띄운다.
export const calibrationPort = 4174

// 빌드 결과물(dist)을 대상으로 검증한다. 단독 실행 시 먼저 `npm run build`가 필요하다.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${previewPort}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    // WebKit 엔진 근사치이며 실제 iOS Safari 확인을 대체하지 않는다.
    { name: 'mobile-webkit', use: { ...devices['iPhone 15'] } },
  ],
  webServer: [
    {
      command: `npm run preview -- --port ${previewPort} --strictPort`,
      url: `http://localhost:${previewPort}`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npm run build:calibration && npm run preview -- --outDir dist-calibration --port ${calibrationPort} --strictPort`,
      url: `http://localhost:${calibrationPort}/calibration.html`,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
