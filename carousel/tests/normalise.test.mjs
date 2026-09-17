import { test, expect, describe } from "bun:test";
import { sniff, classifyGround, tonePlan, edgeGuard, posterRisk, BYTE_FLOOR, MIN_DISTINCT_COLOURS, MASTER, MASTER_AR } from "../normalise.mjs";

// The measurements come from a browser; every JUDGEMENT is a pure function of them and is
// tested here without one. That split is deliberate: the thresholds are the part that decides
// whether a prize photograph ships, and they should be checkable in milliseconds.

describe("magic-byte sniff", () => {
  const b = (...bytes) => new Uint8Array([...bytes, ...Array(16).fill(0)]);
  test("jpeg", () => expect(sniff(b(0xff, 0xd8, 0xff))).toBe("image/jpeg"));
  test("png", () => expect(sniff(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png"));
  test("gif", () => expect(sniff(b(0x47, 0x49, 0x46, 0x38))).toBe("image/gif"));
  test("webp needs BOTH RIFF and WEBP", () => {
    expect(sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0]))).toBe("image/webp");
    // RIFF alone is also WAV and AVI, so it must not be enough on its own.
    expect(sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 0, 0]))).toBeNull();
  });
  test("avif, ftyp at offset 4", () => expect(sniff(b(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70))).toBe("image/avif"));
  // The whole reason the sniff exists: operators serve JPEGs as text/html and denial pages as
  // image/jpeg, so the declared content type is not evidence of anything.
  test("an HTML denial page is refused whatever it claims to be", () => {
    expect(sniff(new TextEncoder().encode("<!doctype html><html><body>Access denied</body></html>"))).toBeNull();
  });
  test("a truncated file is refused rather than guessed at", () => expect(sniff(new Uint8Array([0xff, 0xd8]))).toBeNull());
});

describe("ground classification", () => {
  test("a uniform LIGHT ring is a product on a studio ground", () => {
    expect(classifyGround({ ringSigma: 2.1, ringMeanL: 96 })).toBe("product-on-light");
  });
  test("a busy ring is a photograph of a real scene, and stays one", () => {
    // Cutting a real scene out produces a floating object on paper, which reads as a graphic.
    expect(classifyGround({ ringSigma: 31, ringMeanL: 54 })).toBe("photograph");
  });
  test("a uniform DARK ring is a plate, never a keyout", () => {
    expect(classifyGround({ ringSigma: 1.4, ringMeanL: 11 })).toBe("product-on-dark");
  });
  test("the light threshold is on the mean, not just the sigma", () => {
    expect(classifyGround({ ringSigma: 1, ringMeanL: 88 })).not.toBe("product-on-light");
  });
});

describe("tone plan", () => {
  const base = { meanL: 55, p5L: 20, p95L: 80, meanC: 30, ringMeanL: 40 };
  test("a well-exposed photograph is left alone", () => {
    const p = tonePlan(base);
    expect(p.gain).toBe(1);
    expect(p.saturation).toBe(1);
    expect(p.notes).toEqual([]);
  });
  test("a dark PHOTOGRAPH is not lifted to a mid grey", () => {
    // A black car at night must stay a black car at night. The L* 62 target is for a cutout
    // that will sit on paper, not for a photograph that is allowed to be dark.
    expect(tonePlan({ ...base, meanL: 22 }).gain).toBe(1);
  });
  test("a dark CUTOUT is lifted toward the paper target", () => {
    const p = tonePlan({ ...base, meanL: 30 }, { isCutout: true });
    expect(p.gain).toBeGreaterThan(1);
    expect(p.gain).toBeLessThanOrEqual(1.45);
  });
  test("the highlight pull is gated on a DARK ground", () => {
    // Most of this inventory is a product on white, where pure-white pixels are the GROUND.
    // Pulling them dulls the paper the product sits on and fixes nothing. Ungated, this fired
    // on essentially every live asset.
    expect(tonePlan({ ...base, p95L: 100, ringMeanL: 96 }).notes.join()).not.toContain("highlight");
    expect(tonePlan({ ...base, p95L: 100, ringMeanL: 30 }).notes.join()).toContain("highlight");
  });
  test("a flat image is stretched, but never by more than 1.25x", () => {
    expect(tonePlan({ ...base, p5L: 45, p95L: 60 }).contrast).toBeLessThanOrEqual(1.25);
    expect(tonePlan(base).contrast).toBeUndefined();
  });
  test("only a genuinely oversaturated asset is desaturated, and never below 0.8x", () => {
    expect(tonePlan({ ...base, meanC: 40 }).saturation).toBe(1);
    const p = tonePlan({ ...base, meanC: 70 });
    expect(p.saturation).toBeLessThan(1);
    expect(p.saturation).toBeGreaterThanOrEqual(0.8);
  });
});

describe("edge guard", () => {
  test("a blown edge on a CROP fails — it would dissolve into the paper", () => {
    expect(edgeGuard({ edgeP95L: 99, padded: false }).pass).toBe(false);
  });
  test("a normal edge passes", () => expect(edgeGuard({ edgeP95L: 70, padded: false }).pass).toBe(true));
  test("a PADDED master is exempt, because the band measured is the pad", () => {
    // The pad is the photo well's own background, so measuring it always returns pure white.
    // Without this the guard was testing its own pad and failing every padded asset.
    const g = edgeGuard({ edgeP95L: 100, padded: true });
    expect(g.pass).toBe(true);
    expect(g.skipped).toContain("padded");
  });
});

describe("poster risk is advisory, and says so by never being binary", () => {
  test("a product photograph reads low", () => expect(posterRisk({ edgeDensity: 0.06, distinctColours: 900 })).toBe("low"));
  test("a text-heavy promo tile reads high", () => expect(posterRisk({ edgeDensity: 0.3, distinctColours: 1200 })).toBe("high"));
  test("dense structure with FEW colours is only medium, not high", () => {
    // A line drawing or a mono graphic is busy but is not a marketing collage.
    expect(posterRisk({ edgeDensity: 0.3, distinctColours: 120 })).toBe("medium");
  });
});

describe("the master", () => {
  test("is the widest and tallest rect any surface takes", () => {
    // §5.7's photo well is 1015 x 615 CSS at deviceScaleFactor 2.
    expect(MASTER).toEqual({ w: 2030, h: 1230 });
    expect(MASTER_AR).toBeCloseTo(1.65, 2);
  });
  test("the admissibility floors are the raised ones", () => {
    expect(BYTE_FLOOR).toBe(8192);            // 3000 let flat colours and denial graphics through
    expect(MIN_DISTINCT_COLOURS).toBe(48);
  });
});
