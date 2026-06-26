import { describe, expect, test } from "bun:test";
import { encodeSixel } from "./image";
import {
  buildKittyPlaceholder,
  buildKittyTransmit,
  detectImageProtocol,
  imageIdFor,
  PLACEHOLDER,
} from "./image-protocol";

describe("detectImageProtocol", () => {
  test("honors explicit override", () => {
    const prev = Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL;
    Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL = "sixel";
    expect(detectImageProtocol()).toBe("sixel");
    Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL = "kitty";
    expect(detectImageProtocol()).toBe("kitty");
    Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL = prev;
  });

  test("screenshot mode forces half-block", () => {
    const prevProto = Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL;
    const prevShot = Bun.env.WORKBENCH_UI_SCREENSHOT;
    delete Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL;
    Bun.env.WORKBENCH_UI_SCREENSHOT = "1";
    expect(detectImageProtocol()).toBe("halfblock");
    Bun.env.WORKBENCH_UI_IMAGE_PROTOCOL = prevProto;
    Bun.env.WORKBENCH_UI_SCREENSHOT = prevShot;
  });
});

describe("imageIdFor", () => {
  test("stable per path, distinct across paths, within 24 bits", () => {
    const a = imageIdFor("/tmp/a.png");
    const b = imageIdFor("/tmp/b.png");
    expect(a).toBe(imageIdFor("/tmp/a.png"));
    expect(a).not.toBe(b);
    expect(a).toBeLessThanOrEqual(0xff_ff_ff);
  });
});

describe("buildKittyTransmit", () => {
  test("single chunk wraps base64 with control keys", () => {
    const out = buildKittyTransmit("QUJD", 7, 10, 5);
    expect(out).toBe("\x1b_Ga=T,U=1,i=7,c=10,r=5,f=100,q=2;QUJD\x1b\\");
  });

  test("long payload is chunked with m=1 ... m=0", () => {
    const payload = "A".repeat(4096 + 100);
    const out = buildKittyTransmit(payload, 1, 8, 4);
    const frames = out.split("\x1b\\").filter(Boolean);
    expect(frames.length).toBe(2);
    expect(frames[0]).toContain("a=T,U=1,i=1");
    expect(frames[0]).toContain(",m=1;");
    expect(frames[1]).toContain("\x1b_Gm=0;");
  });
});

describe("buildKittyPlaceholder", () => {
  test("emits rows of placeholders with the id in the foreground", () => {
    const styled = buildKittyPlaceholder(42, 3, 2);
    const lines = styled.split("\n");
    expect(lines.length).toBe(2);
    // 1 placeholder + 1 diacritic + (cols-1) placeholders = 3 placeholder glyphs.
    const placeholders = [...lines[0]].filter(
      (ch) => ch === PLACEHOLDER
    ).length;
    expect(placeholders).toBe(3);
    expect(lines[0]).toContain("\x1b[38;2;0;0;42m");
  });
});

describe("encodeSixel", () => {
  test("wraps payload in DCS q ... ST and defines a palette", () => {
    const w = 2;
    const h = 2;
    const data = new Uint8Array(w * h * 4);
    data.fill(255); // solid white
    const out = encodeSixel(data, w, h);
    expect(out.startsWith("\x1bPq")).toBe(true);
    expect(out.endsWith("\x1b\\")).toBe(true);
    expect(out).toContain('"1;1;2;2');
    expect(out).toContain("#0;2;");
  });
});
