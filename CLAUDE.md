
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Docs

- **This file** — how the system works *today*.
- **[`PAGES.md`](PAGES.md)** — where draw photos are SERVED since 2026-10-10: a Cloudflare Pages site (no bandwidth meter). `publish-images.mjs` copies every public photo there after each scrape and moves the row; Cloudinary only receives uploads.
- **[`CLOUDINARY.md`](CLOUDINARY.md)** — where draw photos live (Cloudinary, no card needed), why a photo is now kept only while its draw is live (`RETENTION_DAYS=0`), why the Supabase bucket is emptied, and the storage alarm. `R2.md` is the built-but-unused alternative.
- **Supabase egress alarm** — `usage-watch.mjs` (daily, `usage-alarm` label) projects a month of database egress from the API request counter; it needs `sql/2026-10-09-usage-snapshots.sql` applied once in the SQL editor, and `lib/usage-watch.mjs` says how to recalibrate its bytes-per-request figure.
- **[`DECISIONS.md`](DECISIONS.md)** — the standing laws this pipeline may not break (a past date never ends a draw; absence from a feed is not evidence; `total_entries` is required), each with what would reverse it. **Read before changing anything in `lib/verify.mjs` or `ended-sweep.mjs`.**
- **[`../pdd-seo-tools/docs/LESSONS.md`](../pdd-seo-tools/docs/LESSONS.md)** — the fleet-wide mistakes log. Every entry names the mechanical check that now catches the trap.
- `tripwire.md` is **generated** — edit `manager/tripwire.mjs`, not the file.


## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
