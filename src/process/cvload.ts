/**
 * OpenCV.js 불러오기 (worker 안). 단일 스레드 WASM 빌드(@techstark/opencv-js, WASM 이 JS 안에 들어 있음)를
 * 같은 출처의 vendor/opencv/opencv.js 에서 받아 전역 스크립트로 실행한다.
 * - module worker 에서는 importScripts 를 못 쓰므로 fetch + 간접 eval 로 실행한다.
 * - 서비스 워커가 이 파일을 설치 때 캐시하므로 오프라인에서도 열린다 (SPEC 9장).
 * - Emscripten 모듈은 then() 을 가진 "thenable" 이라 await 하면 끝없이 기다린다. 초기화 뒤 then 을 지운다.
 */
import type { CV } from './raster';

let loading: Promise<CV> | null = null;

export function opencvUrl(base: string): string {
  return `${base.replace(/\/?$/, '/')}vendor/opencv/opencv.js`;
}

export function loadOpenCv(url: string): Promise<CV> {
  loading ??= (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenCV.js 를 받지 못했습니다 (${res.status})`);
    const code = await res.text();
    const g = globalThis as unknown as { cv?: CV };
    // 간접 eval: 전역 스코프에서 실행되어 UMD 가 globalThis.cv 를 만든다
    (0, eval)(code);
    const cv = g.cv;
    if (!cv) throw new Error('OpenCV.js 를 실행하지 못했습니다');
    return waitReady(cv);
  })();
  return loading;
}

export function waitReady(cv: CV): Promise<CV> {
  return new Promise((resolve, reject) => {
    const done = () => {
      try {
        delete cv.then;
      } catch {
        // 지울 수 없으면 그대로
      }
      resolve(cv);
    };
    if (cv.Mat) return done();
    const timer = setTimeout(() => reject(new Error('OpenCV.js 초기화 시간 초과')), 60_000);
    cv.onRuntimeInitialized = () => {
      clearTimeout(timer);
      done();
    };
  });
}
