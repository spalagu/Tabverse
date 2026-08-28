import { describe, expect, it } from "vitest";
import { anyAudible, elAudible, type MediaLike } from "./mediaAudible";

const playing: MediaLike = { paused: false, ended: false, muted: false, volume: 1 };

describe("audible judgment", () => {
  it("a playing, unmuted, audible element makes sound", () => {
    expect(elAudible(playing)).toBe(true);
  });

  it("a paused element makes no sound", () => {
    expect(elAudible({ ...playing, paused: true })).toBe(false);
  });

  it("an ended element makes no sound", () => {
    expect(elAudible({ ...playing, ended: true })).toBe(false);
  });

  it("a muted element makes no sound", () => {
    expect(elAudible({ ...playing, muted: true })).toBe(false);
  });

  it("a zero-volume element makes no sound", () => {
    expect(elAudible({ ...playing, volume: 0 })).toBe(false);
  });

  it("a tab is audible when any one element is", () => {
    const silent: MediaLike = { ...playing, muted: true };
    expect(anyAudible([silent, silent])).toBe(false);
    expect(anyAudible([silent, playing])).toBe(true);
    expect(anyAudible([])).toBe(false);
  });
});
