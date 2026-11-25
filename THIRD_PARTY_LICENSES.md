---
tags: [라이선스, 개발]
aliases: [외부 라이선스]
updated: 2026-11-25
---

# THIRD_PARTY_LICENSES

- 배포되는 앱(`dist/`)에 들어가는 외부 코드·데이터·폰트와, 빌드·테스트에만 쓰는 도구를 적는다(SPEC 9장).
- 라이브러리·데이터를 추가하면 이 표를 함께 고친다. 버전은 `package-lock.json` 기준이다.
- AI 모델은 쓰기 전에 라이선스를 먼저 적고, 비상업 전용이나 GPL 계열이면 사용자에게 먼저 묻는다(SPEC 8장).
- 언어 데이터·OpenCV·Tesseract 파일은 CDN이 아니라 npm 패키지에서 `public/vendor/`로 복사해(`scripts/copy-vendor.mjs`) 앱과 같은 출처에서 내려준다. 폰트는 `public/fonts/`에 커밋돼 있다.

## 앱에 포함되는 것

| 이름 | 버전 | 라이선스 | 쓰는 곳 |
|---|---|---|---|
| workbox (window, core, precaching, routing, strategies, expiration) | 7.4.1 | MIT | 서비스 워커 등록·캐시 (vite-plugin-pwa 가 생성) |
| idb | 8.0.4 | ISC | IndexedDB 래퍼 (`src/storage/db.ts`) |
| fflate | 0.8.3 | MIT | ZIP 내보내기·가져오기 (`src/export/zip.ts`) |
| pdf-lib | 1.17.1 | MIT | 검색 가능한 PDF (`src/export/pdf.ts`) |
| └ 함께 번들: @pdf-lib/standard-fonts 1.0.0, @pdf-lib/upng 1.0.1 | | MIT | pdf-lib 의존성 |
| └ 함께 번들: pako 1.0.11 | | MIT AND Zlib | pdf-lib·fontkit 의존성 |
| └ 함께 번들: tslib 1.14.1 | | 0BSD | pdf-lib 의존성 |
| @pdf-lib/fontkit | 1.1.1 | MIT | PDF 한글 폰트 서브셋 |
| tesseract.js | 7.0.0 | Apache-2.0 | OCR (`src/process/ocr/ocr.ts`), `vendor/tesseract/worker.min.js` |
| └ worker.min.js 안: bmp-js 0.1.0, zlibjs 0.3.1, regenerator-runtime 0.13.11, is-url 1.2.4, buffer | | MIT | tesseract.js 의존성 |
| └ worker.min.js 안: idb-keyval 6.3.0, wasm-feature-detect 1.10.1 | | Apache-2.0 | tesseract.js 의존성 |
| └ worker.min.js 안: ieee754 | | BSD-3-Clause | buffer 의존성 |
| tesseract.js-core | 7.0.0 | Apache-2.0 | OCR 엔진 WASM (Tesseract OCR, Apache-2.0), LSTM 전용 3종 |
| @tesseract.js-data/kor, @tesseract.js-data/eng | 1.0.0 | 패키지 MIT, 언어 데이터 Apache-2.0 | 언어 데이터 `4.0.0_best_int` (tesseract-ocr/tessdata_best 를 int 로 변환한 것) |
| @techstark/opencv-js | 4.12.0-release.1 | Apache-2.0 (OpenCV) | 자르기·손가락·펴기·보정 (`vendor/opencv/opencv.js`) |
| NanumGothic Regular | — | SIL OFL 1.1 (`public/fonts/OFL.txt`) | PDF 텍스트 레이어. 출처 github.com/google/fonts `ofl/nanumgothic`. PDF 에는 쓰인 글자만 서브셋 |

알고리즘 출처: 펴기(`src/process/dewarp/`)는 mzucker/page_dewarp (MIT) 방식을 옮겼다. 코드를 복사하지 않았다.

## 빌드·테스트에만 쓰는 것 (앱에 포함되지 않음)

| 이름 | 버전 | 라이선스 |
|---|---|---|
| vite | 8.3.8 | MIT |
| vite-plugin-pwa | 2.0.0 | MIT |
| @vitejs/plugin-basic-ssl | 2.3.0 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| vitest | 5.1.1 | MIT |
| fake-indexeddb | 6.2.8 | Apache-2.0 |
| pngjs | 7.0.0 | MIT |
| pdfjs-dist | 6.5.438 | Apache-2.0 |
| puppeteer-core | 25.18.1 | Apache-2.0 |
| @types/node | 24.19.2 | MIT |
| @types/pngjs | 6.0.5 | MIT |

## AI 모델

없음 (Phase 4 보류).

## 변경 이력

- 2026-11-25 Phase 1~3 의존성(저장·ZIP·PDF·OCR·OpenCV·폰트)과 테스트 도구 추가 #claude-code
