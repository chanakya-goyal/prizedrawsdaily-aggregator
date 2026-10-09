import { expect, test, describe } from "bun:test";
import {
  cloudinaryConfig,
  cloudinaryPublicBase,
  cloudinarySignature,
  publicIdOf,
  sameObject,
  publicBases,
  objectPathFromUrl,
  PUBLIC_PREFIX,
} from "../lib/storage.mjs";

// Why this file exists: the Supabase Free bucket filled for the second time (994 MB of
// 1 GB on 2026-10-09) and the owner will not put a card on file, which rules out R2
// and Backblaze public buckets. Cloudinary's Free plan needs no card. These tests pin
// the parts of that provider that, if wrong, fail SILENTLY: a bad signature is a 401
// on every upload, a wrong base makes every Cloudinary image look "not ours", and a
// public_id collision deletes an image the ingest has just uploaded.

const CLOUD_ENV = ["CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "R2_PUBLIC_BASE"];

/** Run `fn` with exactly `vars` set among the provider env vars (Bun auto-loads .env into tests). */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(CLOUD_ENV.map((k) => [k, process.env[k]]));
  for (const k of CLOUD_ENV) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of CLOUD_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("cloudinaryConfig", () => {
  test("reads the single CLOUDINARY_URL the dashboard hands out", () => {
    const cfg = cloudinaryConfig({ CLOUDINARY_URL: "cloudinary://123456789012345:AbC-d_eF@pdd-images" });
    expect(cfg).toEqual({ cloudName: "pdd-images", apiKey: "123456789012345", apiSecret: "AbC-d_eF" });
  });

  test("falls back to the three separate variables", () => {
    const cfg = cloudinaryConfig({ CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" });
    expect(cfg).toEqual({ cloudName: "c", apiKey: "k", apiSecret: "s" });
  });

  test("CLOUDINARY_URL wins when both forms are present", () => {
    const cfg = cloudinaryConfig({
      CLOUDINARY_URL: "cloudinary://k1:s1@from-url",
      CLOUDINARY_CLOUD_NAME: "from-vars", CLOUDINARY_API_KEY: "k2", CLOUDINARY_API_SECRET: "s2",
    });
    expect(cfg.cloudName).toBe("from-url");
  });

  test("is null when nothing is configured", () => {
    expect(cloudinaryConfig({})).toBeNull();
  });

  test("a half-configured environment is an error, not a silent fallback to Supabase", () => {
    // A missing secret would otherwise mean "not configured" and the scraper would keep
    // writing to the full Supabase bucket — the exact failure this provider exists to end.
    expect(() => cloudinaryConfig({ CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k" })).toThrow(/CLOUDINARY_API_SECRET/);
    expect(() => cloudinaryConfig({ CLOUDINARY_URL: "cloudinary://only-a-cloud" })).toThrow(/CLOUDINARY_URL/);
  });
});

describe("cloudinarySignature", () => {
  // Vectors from https://cloudinary.com/documentation/authentication_signatures (secret "abcd").
  test("the documented single-parameter example", () => {
    expect(cloudinarySignature({ timestamp: 1315060510 }, "abcd")).toBe("a21ad0f63beb4de2e5575204b79ab90bffb02c10");
  });

  test("the documented multi-parameter example — keys sorted, joined with &", () => {
    const params = { timestamp: 1315060510, public_id: "sample_image", eager: "w_400,h_300,c_pad|w_260,h_200,c_crop" };
    expect(cloudinarySignature(params, "abcd")).toBe("bfd09f95f331f558cbd1320e67aa8d488770583e");
  });

  test("file, cloud_name, resource_type and api_key are never signed", () => {
    const base = { public_id: "sample_image", timestamp: 1315060510 };
    const noisy = { ...base, file: "<bytes>", cloud_name: "x", resource_type: "image", api_key: "123" };
    expect(cloudinarySignature(noisy, "abcd")).toBe(cloudinarySignature(base, "abcd"));
    expect(cloudinarySignature(base, "abcd")).toBe("b4ad47fb4e25c7bf5f92a20089f9db59bc302313");
  });

  test("empty values are left out, as the API does", () => {
    expect(cloudinarySignature({ timestamp: 1315060510, folder: "" }, "abcd"))
      .toBe(cloudinarySignature({ timestamp: 1315060510 }, "abcd"));
  });
});

describe("Cloudinary object identity", () => {
  test("public_id is the bucket key without its extension", () => {
    expect(publicIdOf("seven-days-perf/bmw-m2.webp")).toBe("seven-days-perf/bmw-m2");
    expect(publicIdOf("2026/3f2a.png")).toBe("2026/3f2a");
  });

  test("only the LAST segment's extension is stripped", () => {
    expect(publicIdOf("op.v2/draw")).toBe("op.v2/draw");
    expect(publicIdOf("op/win-1.5k-cash.webp")).toBe("op/win-1.5k-cash");
  });

  test("a .jpg and a .webp of the same draw are ONE Cloudinary asset", () => {
    // rehost uploads an interim `.jpg`, then the `.webp` re-encode, then deletes the
    // interim. On Cloudinary both map to the same public_id, so that delete would destroy
    // the webp it had just written. sameObject is what rehost asks before deleting.
    expect(sameObject("op/d.jpg", "op/d.webp", "cloudinary")).toBe(true);
    expect(sameObject("op/d.jpg", "op/d.webp", "supabase")).toBe(false);
    expect(sameObject("op/d.jpg", "op/d.webp", "r2")).toBe(false);
    expect(sameObject("op/a.webp", "op/b.webp", "cloudinary")).toBe(false);
  });
});

describe("Cloudinary as an image base", () => {
  const creds = { supabaseUrl: "https://proj.supabase.co", bucket: "draw-images" };
  const SB = PUBLIC_PREFIX(creds);
  const CDN = "https://res.cloudinary.com/pdd-images/image/upload/v1/";

  test("the public base carries the /v1/ placeholder Cloudinary's own SDKs use for folder paths", () => {
    // Without a version segment the first folder of a public_id can be parsed as a
    // transformation. /v1/ also keeps the path after the base identical to the bucket key.
    expect(cloudinaryPublicBase({ cloudName: "pdd-images" })).toBe(CDN);
  });

  test("publicBases adds Cloudinary once configured, Supabase still first", () => {
    withEnv({ CLOUDINARY_URL: "cloudinary://k:s@pdd-images" }, () => {
      expect(publicBases(creds)).toEqual([SB, CDN]);
    });
  });

  test("publicBases is Supabase alone when no provider is configured", () => {
    withEnv({}, () => expect(publicBases(creds)).toEqual([SB]));
  });

  test("a Cloudinary URL resolves to the SAME key as the Supabase object it was copied from", () => {
    // This is what lets referencedPaths/prune-orphans see a migrated image as still in
    // use, and what lets retention find the Supabase copy to fall back to.
    const bases = [SB, CDN];
    expect(objectPathFromUrl(`${CDN}seven-days-perf/bmw-m2.webp`, bases)).toBe("seven-days-perf/bmw-m2.webp");
    expect(objectPathFromUrl(`${SB}seven-days-perf/bmw-m2.webp`, bases)).toBe("seven-days-perf/bmw-m2.webp");
  });

  test("another Cloudinary account's URL is not ours", () => {
    expect(objectPathFromUrl("https://res.cloudinary.com/someone-else/image/upload/v1/op/d.webp", [SB, CDN])).toBeNull();
  });
});
