/** 플래시(torch). 기기가 지원할 때만 켜고 끌 수 있게 한다 (SPEC 6장). */

export function torchSupported(track: MediaStreamTrack): boolean {
  if (typeof track.getCapabilities !== 'function') return false;
  const caps = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
  return caps.torch === true;
}

export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
}
