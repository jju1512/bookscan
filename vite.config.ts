import { readFileSync } from 'node:fs';
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
        // 앱 셸을 설치 시 캐시한다. OpenCV.js 는 Phase 1 에서 추가한다.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { allowedHosts: tunnelHosts },
  preview: { allowedHosts: tunnelHosts },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
