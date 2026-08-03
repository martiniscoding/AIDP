/**
 * Screenshot the dashboard for visual review.
 *
 * Runs inside the Playwright container, pointed at the dev server on the host:
 *
 *   docker run --rm -v "$PWD":/w -w /w \
 *     mcr.microsoft.com/playwright:v1.49.0-noble \
 *     sh -c "mkdir -p /tmp/pw && cd /tmp/pw && npm i --no-save --silent playwright@1.49.0 \
 *            && cp /w/scripts/shoot.mjs . && node shoot.mjs"
 *
 * Signs in as an existing account (SHOOT_EMAIL / SHOOT_PASSWORD) so it can see
 * documents that are already ingested, rather than starting from an empty
 * library every time.
 */

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.SHOOT_BASE ?? "http://host.docker.internal:3000";
const OUT = process.env.SHOOT_OUT ?? "/w/.shots";
const EMAIL = process.env.SHOOT_EMAIL;
const PASSWORD = process.env.SHOOT_PASSWORD ?? "Northwind-7fa2!";

const shots = [];

async function shoot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  shots.push(name);
  console.log(`  captured ${name}`);
}

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("webpack-hmr") || t.includes("React DevTools")) return;
    if (m.type() === "error") console.log(`  [console error] ${t.slice(0, 240)}`);
  });
  page.on("pageerror", (e) => console.log(`  [page error] ${String(e).slice(0, 240)}`));

  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
  });
  console.log(`  sign-in → ${res.status()}`);

  await page.goto("/dashboard/documents", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shoot(page, "library");

  const link = page.locator('a[href^="/dashboard/documents/"]').first();
  if (await link.count()) {
    await link.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(900);
    await shoot(page, "detail");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await shoot(page, "detail-mobile");
  } else {
    console.log("  no documents in the library");
  }

  await browser.close();
  console.log(`\nWrote ${shots.length} screenshots to ${OUT}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
