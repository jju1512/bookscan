/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** vite.config.ts 의 define 으로 빌드 시 주입 */
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  /** Phase 2에서 사용. 구글 OAuth 웹 클라이언트 ID */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
