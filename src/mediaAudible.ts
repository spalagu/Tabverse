
/** The parts of an HTMLMediaElement the audible judgment reads. */
export interface MediaLike {
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
}

/** Whether one media element is making sound right now. */
export function elAudible(m: MediaLike): boolean {
  return !m.paused && !m.ended && !m.muted && m.volume > 0;
}

/** Whether any element in a page makes the tab audible. */
export function anyAudible(list: MediaLike[]): boolean {
  return list.some(elAudible);
}
