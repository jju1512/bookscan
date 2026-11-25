# HANDOFF — 북스캔 (bookscan)

새 작업은 이 파일을 먼저 읽는다. 요구사항 기준은 [docs/SPEC.md](docs/SPEC.md).

## 지금 상태 (2026-11-25, Phase 1~3 작업 중)

- **사용자 결정: Phase 1·2·3 을 이어서 한 번에 구현** (SPEC 5장과 다름 — 실기기 확인은 끝난 뒤 사용자가 몰아서 한다). AI(Phase 4) 는 보류.
- 작업 브랜치 `ikju1223/phase1-3` (Orca worktree `C:\Users\stam\orca\workspaces\bookscan\phase1-3`). Phase 마다 build·test 통과 시 커밋하고 `git push origin HEAD:main` + 태그 `phase-N`.
- 진행 상황
  - Phase 1: 저장(`src/storage/`), 상태 머신·분석(`src/capture/`), 촬영(`src/camera/shoot.ts`), 화면(`src/app/screens/`), ZIP(`src/export/zip.ts`), 디버그 그래프·녹화·재생 작성, 단위 테스트 통과. 헤드리스 촬영 흐름 확인은 아직.
  - Phase 1 커밋 `d3268d3`(태그 phase-1), Actions 실행 45556908010 성공. 헤드리스: 합성 넘김 영상 5페이지 → 5장, 촬영 중 새로고침 뒤 모두 남음, 탭 수동 촬영 정상 (`scripts/e2e/capture.mjs`).
  - Phase 2: 드라이브 클라이언트·대기열·토큰(`src/sync/`), 화면 연결(`src/sync/index.ts`), 온보딩, 다른 기기에서 불러오기(`src/sync/importer.ts`). 헤드리스로 ID 없음/있음 화면 확인 (`scripts/e2e/drive-ui.mjs`). 실제 구글 로그인은 사용자 Cloud 설정 뒤에만 검증된다.
  - Phase 3: crop/finger/enhance 코어 작성. dewarp(자리표시: 항상 건너뜀)·OCR·PDF·runner·화면은 아직.
  - 합성 테스트 데이터 생성기 `tests/synthetic/*.ts` 와 `tests/fixtures/synthetic/*` 생성됨.
- 2026-11-25 Orca 재시작으로 세션이 한 번 끊겼다. 커밋 안 된 변경은 작업 폴더에 그대로 남아 있었다 → 그 뒤 Phase 1 을 먼저 커밋해 진행분을 지킨다.

### Phase 0 기록

- **Phase 0 구현 완료.**
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
| **(Phase 1)** 화면 라우팅은 해시(`#/book/<id>` 등, `src/app/router.ts`) | Pages 는 없는 경로에 index.html 을 주지 않는다 |
| 데이터 모델에 SPEC 4장에 없는 필드를 덧붙였다(`src/storage/types.ts` 에 "(추가)" 표시): `Capture.order`(표시 순서, seq 는 파일 이름용으로 고정), `Book.nextSeq`, 업로드 `nextAttemptAt`·`checkRemote`, Page `skip`·`auto`·`notes`·`fingerOverText`·`needsManual`·`durations`, 책 단위 작업 `jobs` 스토어(book.json·PDF 업로드) | 순서 변경·재촬영을 seq 를 바꾸지 않고 하려면 별도 순서가 필요. 나머지는 재시도·이어 하기·화면 표시용 |
| 촬영 저장 순서: seq 예약 → OPFS 원본·썸네일 쓰기 → IndexedDB 커밋 → 그 뒤에만 피드백 | 규칙 1. 파일 쓰기가 실패하면 기록이 없고, 그 seq 는 건너뛴다 |
| 삭제는 `deleted:true` 로 기록을 남기고 로컬 파일만 지운다 | 드라이브 쪽 중복 확인·book.json 에서 빼기 위해 |
| 새로고침 뒤 이어 찍을 때 마지막 촬영 썸네일을 기준 프레임으로 쓴다 (화각 비율이 2% 안으로 같을 때만) | 기준 프레임이 없으면 "첫 장" 규칙으로 같은 페이지를 또 찍는다(중복). takePhoto 와 미리보기의 화각이 다르면 못 쓴다 |
| 프레임 분석은 OpenCV 없이 직접 계산(320px 흑백·5탭 블러·차이·라플라시안). sharpness 는 블러 **전** 흑백으로 | SPEC "OpenCV.js나 Canvas 연산". 320px 는 1~2ms. 블러 후에는 흔들림 구분이 약해진다 |
| 촬영 방식 설정 `auto/photo/frame`. auto 는 takePhoto 가 1초 넘거나 실패하거나 미리보기 프레임 간격이 600ms 넘으면 이번 세션은 frame 으로 | SPEC 6장 "두 방식 모두 구현하고 설정에서 고를 수 있게" |
| 세션 녹화는 미리보기를 640px 캔버스로 줄여 MediaRecorder(webm) | 4K 스트림을 그대로 녹화하면 폰이 버겁다. 재생 분석은 어차피 320px |
| 녹화 재생은 영상을 재생하며 requestVideoFrameCallback 의 mediaTime 으로 프레임을 뽑는다(seek 안 함) | MediaRecorder webm 은 탐색이 느리고 부정확하다. 대신 재생 시간만큼 걸린다(2×·4× 선택) |
| ZIP 은 fflate 스트리밍으로 OPFS 파일에 바로 쓰고 그 파일을 내려받게 한다. 원본은 무압축 | 300장이면 1GB 가까이 되어 메모리에 못 올린다. JPEG 는 다시 압축해도 줄지 않는다 |
| ZIP 가져오기는 항상 새 책 ID (같은 책이 있으면 제목에 "(가져옴)") | 덮어쓰기 사고 방지 |
| **(Phase 2)** 클라이언트 ID 는 빌드 변수 `VITE_GOOGLE_CLIENT_ID`, 워크플로는 저장소 **변수**(vars)에서 읽는다 | 공개값이라 secret 이 아니다. 없으면 드라이브 UI 를 숨기고 온보딩 질문도 하지 않는다 |
| book.json 은 "후처리 끝난 뒤"가 아니라 촬영 업로드가 끝날 때마다(책이 바뀌면) 올린다 | SPEC 7장은 후처리 뒤에 올린다고 적었지만, 그러면 휴대폰에서 촬영만 한 책을 PC 에서 불러올 수 없다(주 용도와 모순). 폴더 구조의 "book.json: 다른 기기에서 복원할 때 사용"을 따랐다 |
| 드라이브에서 불러온 책은 원래 책 ID 를 그대로 쓰고 촬영은 upload=done·driveFileId 로, 책 폴더 ID 도 이어 받는다 | 다시 올리지 않고, PC 에서 만든 PDF 가 같은 폴더에 들어가게. 두 기기가 같은 book.json 을 갱신하면 마지막에 쓴 쪽이 이긴다 |
| resumable 조각 PUT 에도 Authorization 헤더를 붙인다 (coder 구현 그대로) | "매 요청 토큰". 조각 도중 만료되면 401 → 대기열이 재발급 후 다시 올린다 |
| 401 이 새 토큰 이전 요청에서 늦게 오면 무시(토큰 세대), 재발급 10초 안에 또 401 이면 바로 "다시 연결" | 멀쩡한 새 토큰으로 "다시 연결"이 뜨거나 재발급이 무한 반복되는 것을 막는다 |

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
- **`vite preview` 를 띄운 채 `npm ci`** → `EPERM unlink ...rolldown-binding.win32-x64-msvc.node` 로 실패하고 node_modules 가 반쯤 지워진다. 원인: preview 프로세스가 rolldown 네이티브 바인딩을 잡고 있음. `npx` 를 taskkill 해도 자식 `node vite.js preview` 가 남으므로 `Stop-Process -Id <그 PID>` 로 끄고 다시 `npm ci`.
- **Emscripten(OpenCV.js) 모듈을 `await`** → 영원히 안 끝난다. 모듈이 then() 을 가진 thenable 이라 자기 자신으로 resolve 를 반복. `onRuntimeInitialized` 를 기다리고 then 을 지운다(`src/process/cvload.ts`).
