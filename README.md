# 북스캔 (bookscan)

안드로이드 크롬에서 책을 펼쳐 두고 페이지만 넘기면 자동으로 촬영되는 정적 웹앱(PWA)이다. 서버 없이 GitHub Pages에 올리고, 이미지는 사용자 기기 안에만 저장한다.

- 요구사항 원문: [docs/SPEC.md](docs/SPEC.md) — 이 문서가 기준이다.
- 작업 상태·결정·미결: [HANDOFF.md](HANDOFF.md)
- 배포 주소: https://jju1512.github.io/bookscan/ (저장소 https://github.com/jju1512/bookscan)
- 현재 단계: **Phase 0 (기반)**. 카메라 권한 화면, 후면 카메라 미리보기(받은 해상도 표시), 디버그 패널 틀, PWA 설치까지만 있다.

## 사용법 (Phase 0)

1. 안드로이드 크롬으로 https://jju1512.github.io/bookscan/ 에 들어간다.
2. **카메라 켜기** → 권한 허용. 후면 카메라 미리보기가 나오고, 왼쪽 위에 실제로 받은 해상도가 보인다.
3. 오른쪽 위 **디버그**: 환경, 카메라 정보(요청·받은·최대 해상도, torch 지원), 파라미터 편집, 로그 내보내기.
   주소 끝에 `?debug` 를 붙이면 패널이 열린 채로 시작한다.
4. **홈 화면에 설치** 버튼(크롬이 설치 가능하다고 판단할 때만 보임) 또는 크롬 메뉴 → "앱 설치/홈 화면에 추가".
5. 새 버전이 배포되면 화면 아래에 "새 버전이 있습니다 [새로고침]" 배너가 뜬다. 누르기 전에는 바뀌지 않는다.

## 로컬 개발

Node 22 이상(개발은 24에서 확인).

```bash
npm ci
npm run dev          # http://localhost:5173  (서비스 워커 꺼짐)
npm test             # 단위 테스트 (vitest)
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + vite build → dist/
npm run preview      # http://localhost:4173  (빌드 결과, 서비스 워커 켜짐)
```

- 카메라는 HTTPS 또는 `localhost` 에서만 열린다.
- 아이콘을 다시 만들려면 `npm run icons` (public/icons/*.png 를 덮어쓴다).
- 튜닝 파라미터는 `src/config/params.ts` 한 곳에만 둔다. 디버그 패널에서 바꾼 값은 localStorage(`bookscan.params.v1`)에 기본값과 다른 것만 저장된다.

### 휴대폰으로 확인하기 (Pages 배포 전)

휴대폰 크롬은 `http://192.168.x.x` 같은 주소에서는 카메라를 열어 주지 않는다. 아래 중 하나를 쓴다.

| 방법 | 명령 | 카메라 | 설치·서비스 워커 | 메모 |
|---|---|---|---|---|
| ① cloudflared 임시 터널 (권장) | `npm run build && npm run preview` 를 띄운 채 다른 창에서 `cloudflared tunnel --url http://localhost:4173` | O | O | 출력된 `https://<임의>.trycloudflare.com` 을 폰에서 연다. 정식 인증서라 PWA 설치까지 시험할 수 있다. 터널을 켜 둔 동안은 주소를 아는 누구나 접속할 수 있다(앱 파일만 있고 이미지는 폰 밖으로 나가지 않는다). |
| ② USB 디버깅 포트 포워딩 | `npm run preview` 후 PC 크롬 `chrome://inspect/#devices` → Port forwarding `4173` → `localhost:4173` | O | O | 폰에서 `http://localhost:4173` 을 연다. 개발자 옵션의 USB 디버깅이 필요하다. |
| ③ 같은 와이파이 + 자체 서명 HTTPS | `npm run dev:https` → `https://<PC IP>:5173` | O | X | 인증서 경고에서 "고급 → 계속". 자체 서명 인증서에서는 서비스 워커가 등록되지 않아 설치 시험은 안 된다. Windows 방화벽이 5173 포트를 막으면 허용한다. |
| ④ 크롬 플래그 | `npm run preview:lan` → 폰 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 에 `http://<PC IP>:4173` 등록 | O | 부분 | 폰 크롬 설정을 바꾸므로 시험 후 되돌린다. |

`vite.config.ts` 의 `server/preview.allowedHosts` 에 `.trycloudflare.com` 이 들어 있어서 ①이 바로 동작한다.

## 배포 (GitHub Pages)

워크플로: [`.github/workflows/pages.yml`](.github/workflows/pages.yml)

- `main` 에 push 하거나 Actions 화면에서 수동 실행하면 `npm ci → npm test → npm run build → Pages 배포` 를 한다. PR 에서는 배포 없이 빌드까지만 한다.
- Pages 는 Settings → Pages → Source **GitHub Actions** 로 켜져 있다(`build_type: workflow`). 꺼지면 `configure-pages` 단계에서 실패한다.
- Vite `base` 는 빌드 시 환경변수 `BASE_PATH` 로 정한다. 워크플로는 `configure-pages` 가 알려 주는 하위 경로(`/bookscan`)를 자동으로 넣는다. 다른 값이 필요하면 저장소 변수 `BOOKSCAN_BASE_PATH` 를 만든다.
- 로컬에서 Pages 와 같은 경로로 빌드해 보기: `BASE_PATH=/bookscan/ npm run build`
  (Git Bash 에서는 `/bookscan/` 이 Windows 경로로 바뀌므로 `MSYS_NO_PATHCONV=1 BASE_PATH=/bookscan/ npm run build`)
- 출처(origin)는 `https://jju1512.github.io` 다. 같은 계정의 다른 Pages 사이트와 브라우저 저장소(IndexedDB·OPFS·localStorage)의 출처를 함께 쓰므로 키 이름을 `bookscan.*` 으로 구분한다. Phase 2 OAuth "승인된 JavaScript 원본"도 이 값이다.

## 구글 설정

Phase 2에서 쓴다. OAuth 웹 클라이언트 ID 를 빌드 시 `VITE_GOOGLE_CLIENT_ID` 로 넣는다(클라이언트 시크릿은 쓰지 않는다). 절차는 Phase 2 때 이 절에 적는다.

## 폴더 구조

SPEC 3장 권장안을 따른다. 아직 쓰지 않는 폴더에는 README 한 줄만 있다.

```
bookscan/
  .github/workflows/pages.yml  Pages 배포
  build/base-path.ts     BASE_PATH → Vite base 정규화 (빌드 설정용)
  scripts/gen-icons.mjs  PWA 아이콘 생성
  public/                favicon, icons/
  src/
    app/       화면 (권한 화면, 미리보기, 설치 버튼, 새 버전 배너)
    camera/    카메라 열기·정보·오류 문구
    capture/   (Phase 1) 자동 촬영 상태 머신, 분석 worker
    storage/   (Phase 1) IndexedDB·OPFS
    sync/      (Phase 2) 드라이브
    process/   step.ts = 후처리 단계 공통 인터페이스, crop/ finger/ dewarp/ enhance/ ocr/ (Phase 3)
    export/    (Phase 1) ZIP, (Phase 3) PDF
    config/    튜닝 파라미터 (한 곳에만)
    debug/     디버그 패널, 로그
  tests/       vitest 단위 테스트, fixtures/
```

## 라이선스

사용한 라이브러리는 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) 에 정리한다.
