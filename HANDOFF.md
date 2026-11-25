# HANDOFF — 북스캔 (bookscan)

새 작업은 이 파일을 먼저 읽는다. 요구사항 기준은 [docs/SPEC.md](docs/SPEC.md).

## 지금 상태 (2026-11-25)

- **Phase 0 구현 완료, 사용자 실기기 확인 대기.** Phase 1 은 시작하지 않았다 (SPEC 5장: Phase 마다 실기기 확인 후 진행).
- 저장소: https://github.com/jju1512/bookscan (공개, 기본 브랜치 `main`), 로컬 `C:\jju_make\bookscan`.
- 배포: https://jju1512.github.io/bookscan/ — GitHub Actions(`.github/workflows/pages.yml`)로 main push 때 자동 배포. Pages 는 `build_type: workflow` 로 켰다.
  - 첫 배포(2026-11-25, 커밋 `298d776`, [실행 45551414790](https://github.com/jju1512/bookscan/actions/runs/45551414790)) 성공. 사이트·`manifest.webmanifest`·`sw.js`·아이콘 모두 200, 경로는 `/bookscan/`, manifest `start_url`·`scope` 도 `/bookscan/`. 헤드리스 크롬 가짜 카메라로 배포 주소에서 미리보기와 해상도 표시를 확인했다.
  - Orca 프로젝트로 등록돼 있다(`orca repo add --path C:\jju_make\bookscan`).
- 출발점: `ikju1223/grok_bot_make` 의 브랜치 `ikju1223/book-scan` 커밋 `cb7fb07` 의 `book_scan/` 를 이 저장소 루트로 옮겼다(2026-11-25). 원본은 그쪽에 남아 있으나 앞으로는 이 저장소가 기준이다.
- 로컬 확인:
  - `npm ci && npm run build && npm test` 통과 (단위 테스트 39개).
  - `npm run preview` + 헤드리스 크롬 가짜 카메라: 권한 허용 시 미리보기가 뜨고 배지·디버그 패널에 받은 해상도(가짜 장치 3840×2160)가 표시된다. 412px 폭에서도 레이아웃 정상, 크롬이 `beforeinstallprompt` 를 띄워 "홈 화면에 설치" 버튼이 보인다(설치 가능 판정).
  - Orca 내장 브라우저는 카메라 권한이 `denied` 로 막혀 있어, 거부 안내 화면이 뜨는 것까지 확인했다.
  - 실제 안드로이드 기기는 확인하지 않았다 → 사용자 몫.

## 결정과 근거

| 결정 | 근거 |
|---|---|
| UI 프레임워크 없음 (바닐라 TS + `src/app/dom.ts` 의 작은 `h()` 도우미) | SPEC 3장이 번들 작은 쪽을 권장. Phase 0 JS 약 21KB(gzip 8KB) |
| PWA 는 vite-plugin-pwa `generateSW`, `registerType: 'prompt'` | 자동 갱신은 촬영·후처리 중 화면을 새로고침할 수 있다. 새 버전은 배너에서 사용자가 누를 때만 적용 |
| 카메라 요청은 `facingMode: {ideal: 'environment'}`, `width/height: {ideal: 4096×3072}` | SPEC "가능한 최대 해상도". 안드로이드 후면 센서는 대개 4:3. `exact` 를 쓰면 PC 에서 열리지 않아 후처리용 PC 확인이 막힌다 |
| 받은 해상도는 `getSettings`, `<video>` 크기, `getCapabilities` 최대, `ImageCapture.getPhotoCapabilities` 최대를 모두 표시 | Phase 1 에서 takePhoto 와 스트림 캡처 중 무엇을 쓸지 고를 근거가 된다 |
| 파라미터는 `src/config/params.ts` 에만 정의. % 값은 비율(0~1)로 저장, 화면에서만 ×100 | 상태 머신 코드에서 단위 혼동을 막는다. 기본값은 SPEC 6장 표 + 8장 PROCESS_MAX_EDGE 3000 |
| 디버그 패널 값은 기본값과 **다른 것만** localStorage `bookscan.params.v1` 에 저장 | 나중에 기본값을 바꾸면 손대지 않은 값은 새 기본값을 따른다. localStorage 는 작은 설정값만 (SPEC 2장) |
| 탭이 숨겨지면 카메라를 끄고 돌아오면 다시 연다 | SPEC 6장. Phase 0 에도 넣어 두면 백그라운드에서 카메라가 켜진 채 남지 않는다 |
| Vite `base` 는 `BASE_PATH` 환경변수(`build/base-path.ts` 로 정규화). 워크플로는 `configure-pages` 의 `base_path` 를 넣고, 저장소 변수 `BOOKSCAN_BASE_PATH` 로 덮어쓸 수 있다 | 로컬·PR 은 `/`, Pages 는 `/bookscan/` 이 자동으로 맞는다 |
| 워크플로 `.github/workflows/pages.yml` 하나. push(main)·수동 실행 때 배포, PR 은 테스트·빌드까지 | 저장소 전체가 앱이라 paths 필터가 필요 없다 |
| 워크플로 build 잡에 `pages: write` 를 준다 (최상위는 `contents: read`) | `configure-pages` 가 Pages 설정을 읽는다. GitHub 공식 Pages 스타터와 같은 권한. 첫 배포에서 이 권한으로 성공했다. `pages: read` 로 줄여도 되는지는 시험하지 않았다 |
| 배포 대상은 jju1512 계정의 새 공개 저장소 `bookscan` (2026-11-25 사용자 결정) | 무료 요금제로 Pages 가능, SPEC 기본안 이름과 같음. grok_bot_make 는 비공개라 Pages 에 Pro 이상이 필요했다 |
| 후처리 단계 인터페이스는 `src/process/step.ts` 에 타입만 (`run(input, meta) => Promise<{image, meta}>`, `impl: 'opensource' \| 'ai'`) | AI 연동 보류. 나중에 구현만 바꿔 끼울 수 있게 방향만 고정. ONNX 등 의존성은 넣지 않았다 |
| 린터(ESLint)는 넣지 않았다. 검사는 `tsc --noEmit`(strict) 과 vitest | Phase 0 범위를 작게. 필요하면 Phase 1 에서 추가 |

## 미결

1. **출처 공유** — 출처(origin)가 `https://jju1512.github.io` 라서 같은 계정의 다른 Pages 사이트와 IndexedDB·OPFS·localStorage 출처를 함께 쓴다(키 이름 `bookscan.*` 로 구분 중). Phase 2 OAuth "승인된 JavaScript 원본"도 이 값이다. 문제가 되면 사용자 지정 도메인을 검토한다.
2. **PROJECT DOCS 템플릿** — 전역 규칙상 `docs/` 템플릿(`D:\PROJECT DOCS\_templates\`) 복사 여부를 사용자에게 물어야 한다. 이번에는 `docs/SPEC.md` 만 두었다.
3. **기준 테스트 기기** — 사용자 폰 모델을 받으면 Phase 1 성능 목표를 잡는다 (SPEC 9장 미정 사항).
4. **npm audit 경고 4건(moderate)** — `vite-plugin-pwa 2.0.0 → workbox-build 7.4.1 → glob/minimatch`. 빌드 도구에만 있고 앱에는 들어가지 않는다. `npm audit fix --force` 는 vite-plugin-pwa 를 1.1.0 으로 내리므로 하지 않았다. 상위 버전이 나오면 올린다.

## 해 봤는데 안 된 것

- **Git Bash 에서 `BASE_PATH=/bookscan npm run build`** → base 가 `/C:/Program Files/Git/bookscan/` 로 빌드됨. MSYS 경로 변환 탓. `MSYS_NO_PATHCONV=1` 을 붙이면 된다. CI(우분투)와 PowerShell 은 문제없다.
- **Orca 내장 브라우저로 카메라 미리보기 확인** → 권한이 `denied` 로 고정돼 있어 불가. PC 크롬 헤드리스 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` 를 CDP 로 몰아서 확인했다. `--screenshot` 단독은 getUserMedia 가 끝나기 전에 찍혀서 쓸모없었다.
- **이 PC 에서 `npm test`/`tsc` 가 가끔 비정상 종료**(vitest 워커 exit 3221226505, tsgo `runtime.sysUsedOS` panic) → 그때 실메모리 여유 445MB, 커밋 여유 1.8GB 였다. 코드 문제가 아니라 메모리 부족. 다시 돌리거나 `npx vitest run --maxWorkers=1` 로 통과.
- 긴 heredoc(`cat > file <<'EOF'` 여러 개를 한 명령에)으로 파일을 쓰다 Git Bash 가 `unexpected EOF` 로 실패, 아무 파일도 안 써짐 → 파일 쓰기 도구로 바꿨다.
