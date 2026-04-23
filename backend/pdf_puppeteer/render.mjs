/**
 * Renders a self-contained HTML file to PDF (Chromium via Puppeteer).
 * Usage: node render.mjs <input.html> <output.pdf>
 * Expects all assets inlined (data: URLs); no network fetches required.
 */
import fs from "node:fs";
import puppeteer from "puppeteer";

const [, , htmlPath, pdfPath] = process.argv;
if (!htmlPath || !pdfPath) {
  console.error("Usage: node render.mjs <input.html> <output.pdf>");
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");
if (!html.trim()) {
  console.error("Empty HTML input.");
  process.exit(1);
}

if (process.env.INSPECTION_PDF_LOG_HTML === "1") {
  console.error(`[inspection-pdf] HTML length=${html.length}`);
  console.error(html.slice(0, 120000));
}

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
});

try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });

  await page.evaluate(() => {
    return Promise.all(
      Array.from(document.images).map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete && img.naturalWidth > 0) {
              resolve();
              return;
            }
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          }),
      ),
    );
  });

  await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", right: "12mm", bottom: "14mm", left: "12mm" },
  });
} finally {
  await browser.close();
}
