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
  cloudinaryUpload,
  cloudinaryAssetOf,
  cloudinaryRawUrl,
  planCloudinaryDeletes,
  deleteObjects,
  cloudinaryInventory,
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

  test("new uploads are RAW: the extension is part of the public_id, so .jpg and .webp are two assets", () => {
    // Image uploads cost transformation credits (measured 2026-10-09: 18,639 for ~8,870
    // uploads, 1 derived asset); raw uploads cost none. A raw public_id keeps its
    // extension, so rehost's interim `.jpg` and final `.webp` are different assets and the
    // interim must be deleted after the webp lands — sameObject says so.
    expect(sameObject("op/d.jpg", "op/d.webp", "cloudinary")).toBe(false);
    expect(sameObject("op/d.webp", "op/d.webp", "cloudinary")).toBe(true);
    expect(sameObject("op/d.jpg", "op/d.webp", "supabase")).toBe(false);
    expect(sameObject("op/d.jpg", "op/d.webp", "r2")).toBe(false);
  });

  test("sameObject compares Cloudinary URLs of BOTH forms by asset", () => {
    const IMG = "https://res.cloudinary.com/pdd/image/upload/v1/";
    const RAW = "https://res.cloudinary.com/pdd/raw/upload/v1/";
    // The 8,760 migrated photos are image assets: there the extension is only a delivery
    // format, so these two URLs are ONE asset.
    expect(sameObject(`${IMG}op/d.jpg`, `${IMG}op/d.webp`, "cloudinary")).toBe(true);
    // Raw assets keep the extension in the public_id: two assets.
    expect(sameObject(`${RAW}op/d.jpg`, `${RAW}op/d.webp`, "cloudinary")).toBe(false);
    // Same key, different resource type: two assets.
    expect(sameObject(`${IMG}op/d.webp`, `${RAW}op/d.webp`, "cloudinary")).toBe(false);
    expect(sameObject(`${RAW}op/d.webp`, `${RAW}op/d.webp`, "cloudinary")).toBe(true);
  });
});

describe("cloudinaryAssetOf — which asset a stored URL names", () => {
  const cfg = { cloudName: "pdd" };
  const IMG = "https://res.cloudinary.com/pdd/image/upload/v1/";
  const RAW = "https://res.cloudinary.com/pdd/raw/upload/v1/";

  test("a migrated (image) URL: public_id has no extension", () => {
    expect(cloudinaryAssetOf(`${IMG}op/d.webp`, cfg)).toEqual({ resourceType: "image", publicId: "op/d", path: "op/d.webp" });
  });

  test("a new (raw) URL: public_id IS the key, extension included", () => {
    expect(cloudinaryAssetOf(`${RAW}op/d.webp`, cfg)).toEqual({ resourceType: "raw", publicId: "op/d.webp", path: "op/d.webp" });
  });

  test("percent-encoding and a weserv wrapper resolve to the same asset", () => {
    expect(cloudinaryAssetOf(`${RAW}op/a%20b.webp?x=1`, cfg)).toEqual({ resourceType: "raw", publicId: "op/a b.webp", path: "op/a b.webp" });
    const wrapped = `https://images.weserv.nl/?url=${encodeURIComponent(`${RAW}op/d.webp`)}&w=400`;
    expect(cloudinaryAssetOf(wrapped, cfg)?.publicId).toBe("op/d.webp");
  });

  test("Supabase, another Cloudinary account, or junk is not one of ours", () => {
    expect(cloudinaryAssetOf("https://proj.supabase.co/storage/v1/object/public/draw-images/op/d.webp", cfg)).toBeNull();
    expect(cloudinaryAssetOf("https://res.cloudinary.com/someone-else/raw/upload/v1/op/d.webp", cfg)).toBeNull();
    expect(cloudinaryAssetOf(null, cfg)).toBeNull();
    expect(cloudinaryAssetOf("", cfg)).toBeNull();
  });
});

describe("Cloudinary as an image base", () => {
  const creds = { supabaseUrl: "https://proj.supabase.co", bucket: "draw-images" };
  const SB = PUBLIC_PREFIX(creds);
  const CDN = "https://res.cloudinary.com/pdd-images/image/upload/v1/";
  const RAW = "https://res.cloudinary.com/pdd-images/raw/upload/v1/";
  const PAGES = "https://prizedrawsdaily-images.pages.dev/i/"; // lib/pages.mjs, served since 2026-10-10

  test("the public base new uploads land on is the RAW one, with the /v1/ placeholder", () => {
    // /v1/ is the placeholder Cloudinary's own SDKs use for folder paths (without a
    // version segment the first folder can be parsed as a transformation), and it keeps
    // the path after the base identical to the bucket key.
    expect(cloudinaryPublicBase({ cloudName: "pdd-images" })).toBe(RAW);
    expect(cloudinaryPublicBase({ cloudName: "pdd-images" }, "raw")).toBe(RAW);
  });

  test("the migrated photos' image base is still available by name", () => {
    expect(cloudinaryPublicBase({ cloudName: "pdd-images" }, "image")).toBe(CDN);
  });

  test("a new upload's URL is the raw base + the bucket key, percent-encoded per segment", () => {
    expect(cloudinaryRawUrl({ cloudName: "pdd-images" }, "seven-days-perf/bmw-m2.webp")).toBe(`${RAW}seven-days-perf/bmw-m2.webp`);
    expect(cloudinaryRawUrl({ cloudName: "pdd-images" }, "op/a b#1.jpg")).toBe(`${RAW}op/a%20b%231.jpg`);
  });

  test("publicBases lists BOTH Cloudinary forms once configured, Supabase still first", () => {
    // The database now holds a mix: 8,760 migrated rows on /image/upload/ and every new
    // row on /raw/upload/. A base missing here makes those images look "not ours" —
    // rehost would re-download them on every pass and the tripwire's cache check would
    // go blind.
    withEnv({ CLOUDINARY_URL: "cloudinary://k:s@pdd-images" }, () => {
      expect(publicBases(creds)).toEqual([SB, CDN, RAW, PAGES]);
    });
  });

  test("publicBases is Supabase and the Pages site when no provider is configured", () => {
    // Pages is always listed: it is where public photos are served (lib/pages.mjs).
    withEnv({}, () => expect(publicBases(creds)).toEqual([SB, PAGES]));
  });

  test("a Cloudinary URL of either form resolves to the SAME key as the Supabase object", () => {
    // This is what lets referencedPaths/prune-orphans see a migrated image as still in
    // use, and what lets retention find the Supabase copy to fall back to.
    const bases = [SB, CDN, RAW];
    expect(objectPathFromUrl(`${CDN}seven-days-perf/bmw-m2.webp`, bases)).toBe("seven-days-perf/bmw-m2.webp");
    expect(objectPathFromUrl(`${RAW}seven-days-perf/bmw-m2.webp`, bases)).toBe("seven-days-perf/bmw-m2.webp");
    expect(objectPathFromUrl(`${SB}seven-days-perf/bmw-m2.webp`, bases)).toBe("seven-days-perf/bmw-m2.webp");
  });

  test("another Cloudinary account's URL is not ours", () => {
    expect(objectPathFromUrl("https://res.cloudinary.com/someone-else/image/upload/v1/op/d.webp", [SB, CDN, RAW])).toBeNull();
    expect(objectPathFromUrl("https://res.cloudinary.com/someone-else/raw/upload/v1/op/d.webp", [SB, CDN, RAW])).toBeNull();
  });
});

describe("cloudinaryUpload multipart body", () => {
  // Found by the first live probe, 2026-10-09: Bun's FormData encodes a Blob appended
  // WITHOUT a filename as a plain text field, so Cloudinary answered 400 "Missing
  // required parameter - file" for every upload while all the unit tests above passed.
  // Inspect the bytes that actually go over the wire, not the FormData object.
  test("sends the image as a FILE part (with a filename), not a text field", async () => {
    const realFetch = globalThis.fetch;
    let body = "";
    globalThis.fetch = async (_url, init) => {
      body = await new Response(init.body).text();
      return new Response(JSON.stringify({ public_id: "op/draw", format: "webp", bytes: 3 }), { status: 200 });
    };
    try {
      await withEnv({ CLOUDINARY_URL: "cloudinary://123:secret@demo" }, () =>
        cloudinaryUpload({ path: "op/draw.webp", bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp" }));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(body).toMatch(/Content-Disposition: form-data; name="file"; filename="[^"]+"/i);
    expect(body).toMatch(/Content-Type: image\/webp/i);
  });
});

/** Capture every fetch made inside `fn`, answering each with `respond(url, init)`. */
async function capturingFetch(respond, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? await new Response(init.body).text() : "";
    calls.push({ url: String(url), method: init.method || "GET", body });
    return respond(String(url), init);
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  return calls;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });

describe("cloudinaryUpload goes to the RAW endpoint", () => {
  // Measured 2026-10-09: an image upload costs transformation credits (18,639 counted for
  // ~8,870 uploads, with 1 derived asset), and the Free plan meters them over a rolling
  // 30 days. A raw upload costs none and is served byte-for-byte with the same CDN cache.
  test("posts to /raw/upload with the public_id INCLUDING the extension", async () => {
    const calls = await capturingFetch(
      () => json({ public_id: "op/draw.webp", resource_type: "raw", bytes: 3 }),
      () => withEnv({ CLOUDINARY_URL: "cloudinary://123:secret@demo" }, () =>
        cloudinaryUpload({ path: "op/draw.webp", bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp" })),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.cloudinary.com/v1_1/demo/raw/upload");
    expect(calls[0].body).toMatch(/name="public_id"\r\n\r\nop\/draw\.webp\r\n/);
  });

  test("the legacy image endpoint is still reachable on request, extension stripped", async () => {
    const calls = await capturingFetch(
      () => json({ public_id: "op/draw", format: "webp", bytes: 3 }),
      () => withEnv({ CLOUDINARY_URL: "cloudinary://123:secret@demo" }, () =>
        cloudinaryUpload({ path: "op/draw.webp", bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp", resourceType: "image" })),
    );
    expect(calls[0].url).toBe("https://api.cloudinary.com/v1_1/demo/image/upload");
    expect(calls[0].body).toMatch(/name="public_id"\r\n\r\nop\/draw\r\n/);
  });
});

describe("deleting from a mixed inventory", () => {
  test("a bucket key is a RAW asset (what we write now); an explicit image asset stays image", () => {
    const plan = planCloudinaryDeletes([
      "op/new.webp",
      { resourceType: "image", publicId: "op/old" },
      { resourceType: "raw", publicId: "op/other.jpg" },
      "op/new.webp", // duplicates collapse
    ]);
    expect(plan).toEqual([
      { resourceType: "raw", publicIds: ["op/new.webp", "op/other.jpg"] },
      { resourceType: "image", publicIds: ["op/old"] },
    ]);
  });

  test("batches never exceed the Admin API's 100 public_ids", () => {
    const keys = Array.from({ length: 250 }, (_, i) => `op/d${i}.webp`);
    const plan = planCloudinaryDeletes(keys);
    expect(plan.map((b) => b.publicIds.length)).toEqual([100, 100, 50]);
    expect(plan.every((b) => b.resourceType === "raw")).toBe(true);
  });

  test("deleteObjects sends each asset to its own resource type's endpoint", async () => {
    const calls = await capturingFetch((url) => {
      const ids = [...new URL(url).searchParams.getAll("public_ids[]")];
      return json({ deleted: Object.fromEntries(ids.map((id) => [id, "deleted"])) });
    }, async () => {
      const out = await withEnv({ CLOUDINARY_URL: "cloudinary://123:secret@demo" }, () =>
        deleteObjects(["op/new.webp", { resourceType: "image", publicId: "op/old" }], { provider: "cloudinary" }));
      expect(out).toEqual({ deleted: 2, notFound: 0, failed: [] });
    });
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
    const byType = Object.fromEntries(calls.map((c) => [new URL(c.url).pathname, new URL(c.url).searchParams.getAll("public_ids[]")]));
    expect(byType).toEqual({
      "/v1_1/demo/resources/raw/upload": ["op/new.webp"],
      "/v1_1/demo/resources/image/upload": ["op/old"],
    });
  });
});

describe("cloudinaryInventory lists both resource types", () => {
  test("pages through image AND raw, keyed by asset, each with its bucket-key path", async () => {
    let inv;
    const calls = await capturingFetch((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/resources/image/upload") && !u.searchParams.get("next_cursor"))
        return json({ resources: [{ public_id: "op/a", format: "webp", bytes: 10 }], next_cursor: "c2" });
      if (u.pathname.endsWith("/resources/image/upload"))
        return json({ resources: [{ public_id: "op/b", format: "png", bytes: 20 }] });
      if (u.pathname.endsWith("/resources/raw/upload"))
        return json({ resources: [{ public_id: "op/a.webp", bytes: 30 }] });
      return json({}, 404);
    }, async () => {
      inv = await withEnv({ CLOUDINARY_URL: "cloudinary://123:secret@demo" }, () => cloudinaryInventory());
    });
    expect(calls).toHaveLength(3);
    // op/a (image) and op/a.webp (raw) share a bucket-key path but are different assets.
    expect([...inv.values()]).toEqual([
      { resourceType: "image", publicId: "op/a", format: "webp", bytes: 10, path: "op/a.webp" },
      { resourceType: "image", publicId: "op/b", format: "png", bytes: 20, path: "op/b.png" },
      { resourceType: "raw", publicId: "op/a.webp", format: "webp", bytes: 30, path: "op/a.webp" },
    ]);
  });

  test("can be limited to one resource type", async () => {
    const calls = await capturingFetch(() => json({ resources: [] }), () =>
      withEnv({ CLOUDINARY_URL: "cloudinary://123:secret@demo" }, () => cloudinaryInventory({ resourceTypes: ["image"] })));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1_1/demo/resources/image/upload"]);
  });
});
