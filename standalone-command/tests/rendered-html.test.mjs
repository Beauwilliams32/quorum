import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the Trident Command portfolio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Trident Command — Studio Portfolio<\/title>/i);
  assert.match(html, /Everything in motion/);
  assert.match(html, /Project landscape/);
  assert.match(html, /Quorum/);
  assert.match(html, /Project landscape/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview|react-loading-skeleton/i);
});

test("the local operator bridge and downloader path are documented", async () => {
  const [route, readme, packageJson, page] = await Promise.all([
    readFile(new URL("../app/api/quorum/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /127\.0\.0\.1:4747/);
  assert.match(route, /\/api\/state/);
  assert.match(route, /method:\"POST\"/);
  assert.match(readme, /npm run local/);
  assert.match(readme, /Quorum/);
  assert.match(packageJson, /"local": "npm run build && npm start"/);
  assert.match(page, /Unified AI Operator/);
  assert.match(page, /fetch\("\/api\/quorum"\)/);
  assert.match(page, /Preview launch/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
