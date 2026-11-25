# THIRD_PARTY_LICENSES

배포되는 앱(dist/)에 들어가는 외부 코드와 모델을 적는다 (SPEC 9장). 라이브러리나 모델을 추가할 때 이 표를 함께 고친다.
AI 모델은 쓰기 전에 라이선스를 먼저 적고, 비상업 전용이나 GPL 계열이면 사용자에게 먼저 묻는다 (SPEC 8장).

## 앱에 포함되는 것

| 이름 | 버전 | 라이선스 | 쓰는 곳 |
|---|---|---|---|
| workbox (workbox-window, 서비스 워커 런타임) | 7.4.1 | MIT | 서비스 워커 등록·앱 셸 캐시 (vite-plugin-pwa 가 생성) |

## 빌드에만 쓰는 것 (앱에 포함되지 않음)

| 이름 | 버전 | 라이선스 |
|---|---|---|
| vite | 8.3.8 | MIT |
| vite-plugin-pwa | 2.0.0 | MIT |
| @vitejs/plugin-basic-ssl | 2.3.0 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| vitest | 5.1.1 | MIT |

## AI 모델

없음 (Phase 4 보류).
