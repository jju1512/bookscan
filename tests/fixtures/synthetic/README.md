---
tags: [개발, 테스트]
aliases: [합성 테스트 이미지]
updated: 2026-11-25
---

# tests/fixtures/synthetic

- 후처리 회귀 테스트용 **합성 이미지**다. 사용자 실제 사진이 아직 없어서 대신 쓴다.
- 이미지마다 같은 이름의 `.json`에 정답이 있다. 생성기는 `tests/synthetic/`이고 시드가 고정이라 다시 만들어도 같은 바이트가 나온다.
- `/debug/compare/`의 "내장 샘플"도 이 PNG를 쓴다(`scripts/copy-vendor.mjs`가 `public/vendor/samples/`로 복사).

## 들어 있는 것

| 파일 | 장면 |
|---|---|
| `spread-flat` | 펼침, 정면에 가까움 (1600×1150) |
| `spread-perspective` | 펼침, 위가 훨씬 좁은 강한 원근 |
| `spread-curved` | 펼침, 원근 + 책등 쪽으로 처지는 휨(4.5%) |
| `spread-finger-margin` | 펼침, 좌우 바깥 여백에만 손가락 |
| `spread-finger-text` | 펼침, 아래·오른쪽 손가락이 본문 글자를 덮음 + 휨 |
| `spread-figure` | 펼침, 왼쪽은 그림 + 설명 두 줄, 오른쪽은 본문 |
| `page-flat` | 한 페이지, 세로 사진 (1100×1500) |
| `ocr-ko` | OCR용 깨끗한 페이지, 한국어 6줄 + 영어 1줄 (1200×1600) |
| `dewarp-metrics.json` | 펴기 전·후 글자 줄 곧음(‰) 기준값. `tests/dewarp.test.ts`가 비교한다 |

정답 `.json` 필드 요약
- **장면(spread-*, page-flat)**: `bookQuad`(책 외곽 4점), `spine`(책등 위·아래 점, 한 페이지면 null), `pages[]`(페이지별 `side`·`quad`·글자 줄 `lines[]`의 기준선 점), `lines`(읽는 순서 텍스트), `fingers[]`(경계 상자, `coversText` 글자를 덮었나, `coveredLines`), `curve`(휨 비율·최대 변위 px)
- **OCR(ocr-ko)**: `lines[]`(줄 텍스트·언어·기준선 y·좌우 x), `text`(전체 정답)

## 다시 만들기

```bash
# 전부 다시 만든다 (npm run fixtures 와 같다). 이름을 주면 그것만 만든다
node tests/synthetic/generate.ts
node tests/synthetic/generate.ts spread-curved ocr-ko
```

```bash
# 펴기 기준값을 지금 결과로 새로 쓴다
UPDATE_DEWARP_METRICS=1 npx vitest run tests/dewarp.test.ts --maxWorkers=1
```

- `out/`은 테스트가 남기는 결과 이미지다. 눈으로 확인하는 용도이고 커밋하지 않는다(`.gitignore`).
- 실제 책 사진과 페이지 넘김 녹화는 나중에 사용자가 한 단계 위 `tests/fixtures/`에 넣는다.

## 변경 이력

- 2026-11-25 처음 작성 #claude-code
