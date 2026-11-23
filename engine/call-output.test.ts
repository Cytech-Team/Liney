import { describe, expect, test } from "bun:test";
import { chooseCallOutput, isDisplayOutput } from "../src/lib/call-output";

const devices = [
  { id: "input:0", name: "default", description: "default", kind: "input" as const, isDefault: true },
  { id: "output:0", name: "default", description: "default", kind: "output" as const, isDefault: true },
  { id: "output:1", name: "pipewire", description: "pipewire", kind: "output" as const },
  { id: "output:4", name: "USB Audio Device", description: "USB Audio Device", kind: "output" as const },
];

describe("call output selection", () => {
  test("prefers a USB headset when the user has not chosen a speaker", () => {
    expect(chooseCallOutput(devices)).toBe("output:4");
  });

  test("keeps an explicit device choice", () => {
    expect(chooseCallOutput(devices, "output:1")).toBe("output:1");
  });

  test("honours an explicit system-default choice", () => {
    expect(chooseCallOutput(devices, "")).toBe("");
  });

  test("does not pair the generic default input with the generic default output", () => {
    expect(chooseCallOutput([
      { id: "input:0", name: "default", kind: "input", isDefault: true },
      { id: "output:0", name: "default", kind: "output", isDefault: true },
      { id: "output:1", name: "pipewire", kind: "output" },
    ])).toBe("");
  });

  test("falls back to the system default when no communication device exists", () => {
    expect(chooseCallOutput([
      { id: "output:0", name: "default", kind: "output", isDefault: true },
      { id: "output:1", name: "HDMI / DisplayPort 1", kind: "output" },
    ])).toBe("");
  });

  test("recognises display outputs", () => {
    expect(isDisplayOutput({ id: "output:1", name: "HDMI / DisplayPort 1" })).toBe(true);
    expect(isDisplayOutput({ id: "output:4", name: "USB Audio Device" })).toBe(false);
  });
});
