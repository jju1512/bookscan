/**
 * 카메라 열기·닫기와 정보 수집. 브라우저 API 를 직접 부르는 얇은 층이다.
 * Phase 1 에서 takePhoto / 스트림 프레임 캡처, torch 가 여기에 붙는다.
 */
import type { Params } from '../config';
import { buildVideoConstraints, checkCameraEnvironment, type CameraErrorInfo } from './constraints';
import type { CameraSnapshot } from './info';

export interface OpenCamera {
  stream: MediaStream;
  track: MediaStreamTrack;
  requested: { width: number; height: number };
}

export function cameraEnvironmentProblem(): CameraErrorInfo | null {
  return checkCameraEnvironment({
    isSecureContext: window.isSecureContext,
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
  });
}

/** 카메라 권한 상태. Permissions API 가 없거나 'camera' 이름을 모르면 'unknown'. */
export async function cameraPermissionState(): Promise<PermissionState | 'unknown'> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

export async function openRearCamera(params: Params): Promise<OpenCamera> {
  const stream = await navigator.mediaDevices.getUserMedia(buildVideoConstraints(params));
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new DOMException('비디오 트랙이 없습니다', 'NotFoundError');
  }
  return {
    stream,
    track,
    requested: { width: params.CAMERA_IDEAL_WIDTH, height: params.CAMERA_IDEAL_HEIGHT },
  };
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** 실제로 받은 해상도와 지원 범위를 모은다. 지원하지 않는 API 는 건너뛴다. */
export async function snapshotCamera(cam: OpenCamera, video?: HTMLVideoElement): Promise<CameraSnapshot> {
  const settings = cam.track.getSettings();
  const snap: CameraSnapshot = {
    label: cam.track.label,
    requested: cam.requested,
    settings: {
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      facingMode: settings.facingMode,
    },
  };

  if (typeof cam.track.getCapabilities === 'function') {
    const caps = cam.track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    snap.capabilities = {
      maxWidth: caps.width?.max,
      maxHeight: caps.height?.max,
      maxFrameRate: caps.frameRate?.max,
      torch: caps.torch === true,
    };
  }

  if (video && video.videoWidth > 0) {
    snap.video = { width: video.videoWidth, height: video.videoHeight };
  }

  const ImageCaptureCtor = (globalThis as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
  if (ImageCaptureCtor) {
    try {
      const pc = await new ImageCaptureCtor(cam.track).getPhotoCapabilities();
      snap.photo = { maxWidth: pc.imageWidth?.max, maxHeight: pc.imageHeight?.max };
    } catch {
      // 일부 기기는 getPhotoCapabilities 를 거부한다. 표시만 생략한다.
    }
  }
  return snap;
}

/** lib.dom 에 아직 없는 ImageCapture 의 최소 타입 */
interface ImageCaptureLike {
  getPhotoCapabilities(): Promise<{ imageWidth?: { max?: number }; imageHeight?: { max?: number } }>;
}
