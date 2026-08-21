import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const mockOverpassBody = JSON.stringify({
  elements: [
    { type: "node", id: 101, lat: 35.6835, lon: 139.764, tags: { amenity: "drinking_water", name: "和田倉噴水公園 水飲み場", opening_hours: "24/7", wheelchair: "yes" } },
    { type: "node", id: 102, lat: 35.6795, lon: 139.7705, tags: { man_made: "water_tap", name: "丸の内仲通り 給水スポット" } },
    { type: "node", id: 201, lat: 35.686, lon: 139.769, tags: { amenity: "toilets", name: "大手町駅前 公衆トイレ", wheelchair: "yes" } },
    { type: "way", id: 202, center: { lat: 35.6775, lon: 139.7645 }, tags: { amenity: "toilets", name: "日比谷公園 トイレ", opening_hours: "24/7" } },
  ],
});
const fulfillOverpass = (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: mockOverpassBody,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  geolocation: { latitude: 35.681236, longitude: 139.767125 },
  permissions: ["geolocation"],
  locale: "ja-JP",
});
const page = await context.newPage();
const consoleErrors = [];
const waitForMarkerCount = async (selector, count) => {
  try {
    await page.waitForFunction(
      ({ selector, count }) => document.querySelectorAll(selector).length === count,
      { selector, count },
      { timeout: 5_000 },
    );
  } catch {
    const actual = await page.locator(selector).count();
    throw new Error(`Expected ${count} markers for ${selector}, got ${actual}`);
  }
};
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

await page.route(/\/api\/interpreter(?:\?|$)/, fulfillOverpass);

await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
if ((await page.title()) !== "Water & Loo Map") throw new Error("Unexpected document title");
if ((await page.locator("html").getAttribute("lang")) !== "ja") throw new Error("Document language is not Japanese");
const screen = page.getByTestId("app-screen");
await screen.waitFor({ state: "visible" });
const box = await screen.boundingBox();
if (!box || Math.abs(box.width - 390) > 1 || Math.abs(box.height - 844) > 1) {
  throw new Error(`Expected 390 x 844 app viewport, got ${box?.width} x ${box?.height}`);
}
await page.locator(".spot-marker--water").first().click();
await page.locator(".spot-sheet").waitFor({ state: "visible" });
await screen.screenshot({ path: "implementation-mobile-screen.png" });

await page.getByRole("button", { name: "トイレ", exact: true }).click();
await waitForMarkerCount(".spot-marker--toilet", 2);
await waitForMarkerCount(".spot-marker--water", 0);
await page.locator(".spot-sheet").waitFor({ state: "hidden" });
await page.getByRole("button", { name: "水飲み場", exact: true }).click();
await waitForMarkerCount(".spot-marker--water", 2);
await page.getByRole("button", { name: "すべて", exact: true }).click();
await waitForMarkerCount(".spot-marker--water", 2);
await waitForMarkerCount(".spot-marker--toilet", 2);
await page.getByRole("button", { name: "現在地へ移動" }).click();
await page.waitForTimeout(800);
if ((await page.locator(".user-marker").count()) !== 1) throw new Error("Current location marker was not shown");
if (consoleErrors.length) throw new Error(`Browser console errors:\n${consoleErrors.join("\n")}`);

const noGeoContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP" });
const noGeoPage = await noGeoContext.newPage();
await noGeoPage.addInitScript(() => {
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
});
await noGeoPage.route(/\/api\/interpreter(?:\?|$)/, fulfillOverpass);
await noGeoPage.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
try {
  await noGeoPage.waitForFunction(() => document.querySelectorAll(".spot-marker").length === 4, undefined, { timeout: 5_000 });
} catch {
  const state = await noGeoPage.locator(".map-app").evaluate((app) => ({
    markers: app.querySelectorAll(".spot-marker").length,
    status: app.querySelector(".map-status")?.textContent,
    error: app.querySelector(".error-toast")?.textContent,
  }));
  throw new Error(`No-geolocation fallback did not load spots: ${JSON.stringify(state)}`);
}
await noGeoContext.close();

const fallbackContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  geolocation: { latitude: 35.681236, longitude: 139.767125 },
  permissions: ["geolocation"],
  locale: "ja-JP",
});
const fallbackPage = await fallbackContext.newPage();
let fallbackRequestUrl;
await fallbackPage.route(/\/api\/interpreter(?:\?|$)/, (route) => route.fulfill({ status: 503 }));
await fallbackPage.route(/\/api\/0\.6\/map\.json(?:\?|$)/, (route) => {
  fallbackRequestUrl = route.request().url();
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      elements: [
        { type: "node", id: 301, lat: 35.684, lon: 139.763, tags: { amenity: "drinking_water" } },
        { type: "node", id: 302, lat: 35.678, lon: 139.771, tags: { amenity: "toilets" } },
      ],
    }),
  });
});
await fallbackPage.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
await fallbackPage.waitForFunction(() => document.querySelectorAll(".spot-marker").length === 2);
if (!fallbackRequestUrl) throw new Error("OSM fallback request was not made");
const fallbackBbox = new URL(fallbackRequestUrl).searchParams.get("bbox")?.split(",").map(Number);
if (!fallbackBbox || fallbackBbox.length !== 4) throw new Error("OSM fallback bbox was missing");
const [west, south, east, north] = fallbackBbox;
if (east - west <= 0.006 || north - south <= 0.004) {
  throw new Error(`OSM fallback searched only the map center: ${fallbackBbox.join(",")}`);
}
await fallbackContext.close();

await browser.close();
console.log(JSON.stringify({
  screen: { width: box.width, height: box.height },
  interactions: ["spot detail", "toilet filter", "water filter", "all filter", "current location", "no-geolocation fallback", "full-viewport OSM fallback"],
  consoleErrors,
}, null, 2));
