import { launchBrowser, signIn, sleep } from "./helpers.mjs";

const out = process.argv[2] || (await import("node:os")).tmpdir();

const browser = await launchBrowser();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => ["error", "warn", "warning"].includes(m.type()) && logs.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/") || u.includes("generateToken") || u.includes("community/self") || u.includes("/sharing/rest?") || r.status() >= 400)
    logs.push(`[http ${r.status()}] ${r.request().method()} ${u.replace(/token=[^&]+/, "token=***").slice(0, 160)}`);
});

try {
  await signIn(page);
} catch {
  await page.screenshot({ path: `${out}/ws-fail.png` });
  console.log("FAIL PAGE TEXT:", (await page.evaluate(() => document.body.innerText)).slice(0, 800));
  console.log("LOGS:\n" + logs.join("\n"));
  await browser.close();
  process.exit(1);
}
console.log("SIGNED IN. Header:", await page.evaluate(() => document.querySelector(".ps-user-meta")?.textContent));
// The Version Manager opens first after sign-in; confirm it, then close it before the map checks.
await page.waitForFunction(() => window.__ps?.editing.getState().versionDialogOpen === true, { timeout: 90000 }).catch(() => undefined);
console.log("VERSION MANAGER OPENED FIRST:", await page.evaluate(() => window.__ps.editing.getState().versionDialogOpen));
await page.evaluate(() => window.__ps.editing.getState().patch({ versionDialogOpen: false }));
await new Promise((r) => setTimeout(r, 800));

// Wait for layers + idle map.
await page.waitForFunction(() => document.querySelector(".ps-status")?.textContent?.includes("Ready"), { timeout: 90000 });
await sleep(6000);
await page.screenshot({ path: `${out}/ws-1-map.png` });
console.log("STATUS BAR:", await page.evaluate(() => document.querySelector(".ps-status")?.textContent));
console.log("VERSION CHIP:", await page.evaluate(() => document.querySelector(".ps-version-chip")?.textContent));

// Identify: click the map centre with the Explore tool.
const box = await (await page.$(".ps-map")).boundingBox();
let found = false;
for (const [dx, dy] of [[0, 0], [40, 30], [-60, 20], [80, -50], [-30, -70], [120, 60]]) {
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await sleep(3500);
  const txt = await page.evaluate(() => document.querySelector(".ps-side.right")?.innerText ?? "");
  if (txt.includes("OBJECTID")) {
    found = true;
    break;
  }
}
await sleep(2500);
await page.screenshot({ path: `${out}/ws-2-identify.png` });
console.log("IDENTIFY:", found, (await page.evaluate(() => document.querySelector(".ps-side.right")?.innerText ?? "")).slice(0, 700).replace(/\n+/g, " | "));

// Attribute table via Alt+3.
await page.keyboard.down("Alt");
await page.keyboard.press("Digit3");
await page.keyboard.up("Alt");
await sleep(7000);
await page.screenshot({ path: `${out}/ws-3-table.png` });

// Logs tab text.
await page.evaluate(() => [...document.querySelectorAll(".ps-tab")].find((b) => b.textContent.includes("Logs"))?.click());
await sleep(800);
console.log("APP LOGS:\n" + (await page.evaluate(() => document.querySelector(".ps-log")?.innerText ?? "")).slice(0, 2500));

// The GIS Services panel was removed from the left bar.
console.log("GIS SERVICES BUTTON PRESENT:", await page.evaluate(() => [...document.querySelectorAll(".ps-actionbar calcite-action")].some((x) => x.text === "GIS Services")));
console.log("LEFT BAR:", await page.evaluate(() => [...document.querySelectorAll(".ps-actionbar calcite-action")].map((x) => x.text).join(", ")));

console.log("BROWSER ERRORS/WARNINGS:\n" + logs.join("\n"));
await browser.close();
