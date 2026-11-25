import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { normalizeBase } from './build/base-path.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// cloudflared 임시 터널 주소로 dev/preview 서버에 들어올 수 있게 허용한다 (휴대폰 확인용).
const tunnelHosts = ['.trycloudflare.com'];

export default defineConfig(({ mode }) => ({
  // Pages 주소가 정해지지 않았으므로 BASE_PATH 환경변수로 바꾼다. 예: BASE_PATH=/bookscan/
  base: normalizeBase(process.env.BASE_PATH),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    // `npm run dev:https` (mode=https): 같은 와이파이의 휴대폰에서 열 수 있도록 자체 서명 HTTPS
    ...(mode === 'https' ? [basicSsl()] : []),
    VitePWA({
      // 새 버전은 사용자가 배너에서 고른 뒤에만 적용한다 (src/main.ts).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: '북스캔',
        short_name: '북스캔',
        description: '책을 펼쳐 두고 페이지만 넘기면 자동으로 촬영되는 북스캔 웹앱',
        lang: 'ko',
        dir: 'ltr',
        display: 'standalone',
        orientation: 'any',
        background_color: '#10151c',
        theme_color: '#10151c',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 앱 셸과 OpenCV.js 를 설치 시 캐시한다 (SPEC 9장: 촬영·로컬 저장이 오프라인에서 동작).
        // OCR(tesseract 코어·언어 데이터)·폰트·비교용 샘플은 크므로 처음 쓸 때 받아 캐시한다.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['vendor/tesseract/**', 'vendor/tessdata/**', 'vendor/samples/**', 'debug/**/*.png'],
        // opencv.js 는 WASM 이 들어 있어 약 11MB
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/\/debug\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/vendor\/(tesseract|tessdata|samples)\/|\/fonts\//.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'bookscan-runtime-v1', expiration: { maxEntries: 40 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { allowedHosts: tunnelHosts },
  preview: { allowedHosts: tunnelHosts },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // /debug/compare/ : 후처리 단계별 결과 비교 페이지 (SPEC 8장)
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        compare: fileURLToPath(new URL('./debug/compare/index.html', import.meta.url)),
      },
    },
  },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
