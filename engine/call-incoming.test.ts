import { describe, expect, test } from "bun:test";
import { normalizeIncomingCallKind } from "./call-incoming";

describe("incoming call notification normalization", () => {
  test("keeps legacy explicit call kinds", () => {
    expect(normalizeIncomingCallKind("AUDIO")).toEqual({ kind: "AUDIO" });
    expect(normalizeIncomingCallKind("VIDEO")).toEqual({ kind: "VIDEO" });
    expect(normalizeIncomingCallKind("0")).toEqual({ kind: "0" });
  });

  test("treats compact route metadata in param3 as an audio call", () => {
    const raw = JSON.stringify({
      RS: false,
      STNPK: "synthetic-key",
      H: "147.92.169.33,147.92.169.105",
      P: 18042,
      VP: 10006,
      VC: JSON.stringify({ MPKEY: "synthetic-mpkey", ICT: 6000 }),
      VFZ: "sgv",
      VTZ: "sgv",
      STV: true,
    });
    const result = normalizeIncomingCallKind(raw);
    expect(result.kind).toBe("AUDIO");
    expect(result.routeMetadata?.STNPK).toBe("synthetic-key");
    expect(result.routeMetadata?.STV).toBe(true);
  });

  test("accepts LINE's uppercase TRUE/FALSE route literals", () => {
    const raw = '{"RS":FALSE,"STNPK":"synthetic-key","H":"127.0.0.1,127.0.0.2","P":12345,"VC":"nested","STV":TRUE,"VP":10000}';
    const result = normalizeIncomingCallKind(raw);
    expect(result.kind).toBe("AUDIO");
    expect(result.routeMetadata).toBeDefined();
  });

  test("recognizes route metadata even when quotes are escaped one extra layer", () => {
    const normal = '{"RS":FALSE,"STNPK":"synthetic-key","H":"127.0.0.1,127.0.0.2","P":24437,"VC":"nested","STV":TRUE,"VP":10004}';
    const escaped = normal.replaceAll(String.fromCharCode(34), String.fromCharCode(92, 34));
    expect(normalizeIncomingCallKind(escaped).kind).toBe("AUDIO");
  });

  test("does not silently reinterpret arbitrary JSON as audio", () => {
    expect(normalizeIncomingCallKind('{"foo":"bar"}').kind).toBe('{"FOO":"BAR"}');
  });
});
