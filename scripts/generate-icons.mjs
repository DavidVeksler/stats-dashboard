// Generates every icon/splash asset for "Add to Home Screen" support (public/) plus the
// matching <link rel="apple-touch-startup-image"> tag list (src/appleSplashLinks.js).
// Re-run with `npm run icons` after changing the brand mark, colors, or device table below.
import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SPLASH_DIR = path.join(PUBLIC_DIR, "splash");

// Brand colors (kept in sync with the --traffic / --paper custom properties in src/render.js).
const LIGHT_BG = "#f5f7fa";
const DARK_BG = "#0e131a";
const LIGHT_ICON_BG = "#256cad";
const LIGHT_FG = "#70afe5";

// Reference bar-chart glyph, defined in a 512x512 box centered at (0,0) i.e. local
// coordinates run -256..256. Scaled/translated at render time for each output size.
const BARS = (() => {
  const bw = 58, gap = 24, n = 4, rx = 18;
  const totalW = n * bw + (n - 1) * gap;
  const startX = -totalW / 2;
  const heights = [100, 160, 224, 296];
  const baseline = 140;
  return heights.map((h, i) => ({ x: startX + i * (bw + gap), y: baseline - h, w: bw, h, rx }));
})();

function barsMarkup(fill) {
  return BARS.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.rx}" fill="${fill}"/>`).join("");
}

// Square app icon: opaque full-bleed background (required for apple-touch-icon and
// maskable manifest icons — iOS/Android render transparency as black otherwise).
function iconSvg(size, { bg, fg, glyphScale = 1 }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
<rect width="512" height="512" fill="${bg}"/>
<g transform="translate(256 256) scale(${glyphScale})">${barsMarkup(fg)}</g>
</svg>`;
}

// Splash screen: solid background sized to the exact device resolution, glyph centered
// and scaled to a fraction of the shorter edge.
function splashSvg(w, h, { bg, fg }) {
  const glyph = Math.round(Math.min(w, h) * 0.22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${bg}"/>
<g transform="translate(${w / 2} ${h / 2}) scale(${glyph / 512})">${barsMarkup(fg)}</g>
</svg>`;
}

async function svgToPng(svg) {
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

// Minimal PNG-in-ICO container (Vista+ format, universally supported today).
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  const images = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit depth
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
    images.push(data);
  }
  return Buffer.concat([header, ...entries, ...images]);
}

// iOS device point-size buckets (CSS px) and device pixel ratio. Point sizes are reused
// across generations that share a physical screen, so this table stays valid until Apple
// ships a genuinely new screen size. Skips any recent model whose exact figures aren't
// independently verifiable — those devices fall back to iOS's built-in plain splash
// (background + icon) instead of a pixel-matched image, which is a silent, harmless
// degradation, not a broken state.
const IPHONE_DEVICES = [
  { name: "iphone-se1", w: 320, h: 568, dpr: 2 },
  { name: "iphone-8", w: 375, h: 667, dpr: 2 },
  { name: "iphone-8plus", w: 414, h: 736, dpr: 3 },
  { name: "iphone-x", w: 375, h: 812, dpr: 3 }, // also X/XS/11 Pro/12 mini/13 mini
  { name: "iphone-xr", w: 414, h: 896, dpr: 2 }, // also 11
  { name: "iphone-xsmax", w: 414, h: 896, dpr: 3 }, // also 11 Pro Max
  { name: "iphone-12", w: 390, h: 844, dpr: 3 }, // also 12 Pro/13/13 Pro/14
  { name: "iphone-12promax", w: 428, h: 926, dpr: 3 }, // also 13 Pro Max/14 Plus
  { name: "iphone-14pro", w: 393, h: 852, dpr: 3 }, // also 15/15 Pro/16
  { name: "iphone-14promax", w: 430, h: 932, dpr: 3 }, // also 15 Plus/15 Pro Max/16 Plus
  { name: "iphone-16pro", w: 402, h: 874, dpr: 3 },
  { name: "iphone-16promax", w: 440, h: 956, dpr: 3 },
];
const IPAD_DEVICES = [
  { name: "ipad-9.7", w: 768, h: 1024, dpr: 2 }, // mini 1-5, 9.7", 5th/6th gen
  { name: "ipad-mini6", w: 744, h: 1133, dpr: 2 },
  { name: "ipad-10.2", w: 810, h: 1080, dpr: 2 },
  { name: "ipad-10.9", w: 820, h: 1180, dpr: 2 }, // 10th gen, Air 4/5
  { name: "ipad-10.5", w: 834, h: 1112, dpr: 2 }, // Air 3, Pro 10.5"
  { name: "ipad-pro11", w: 834, h: 1194, dpr: 2 },
  { name: "ipad-pro12.9", w: 1024, h: 1366, dpr: 2 },
];
const DEVICES = [...IPHONE_DEVICES, ...IPAD_DEVICES];

function splashMediaQuery({ w, h, dpr }, orientation, scheme) {
  const [dw, dh] = orientation === "portrait" ? [w, h] : [h, w];
  const parts = [
    `(device-width: ${dw}px)`,
    `(device-height: ${dh}px)`,
    `(-webkit-device-pixel-ratio: ${dpr})`,
    `(orientation: ${orientation})`,
  ];
  if (scheme) parts.push(`(prefers-color-scheme: ${scheme})`);
  return parts.join(" and ");
}

async function main() {
  await rm(SPLASH_DIR, { recursive: true, force: true });
  await mkdir(SPLASH_DIR, { recursive: true });

  // --- Favicons ---
  const faviconSvg = iconSvg(512, { bg: LIGHT_ICON_BG, fg: "#fff" });
  await writeFile(path.join(PUBLIC_DIR, "favicon.svg"), faviconSvg);

  const fav16 = await svgToPng(iconSvg(16, { bg: LIGHT_ICON_BG, fg: "#fff" }));
  const fav32 = await svgToPng(iconSvg(32, { bg: LIGHT_ICON_BG, fg: "#fff" }));
  await writeFile(path.join(PUBLIC_DIR, "favicon-16x16.png"), fav16);
  await writeFile(path.join(PUBLIC_DIR, "favicon-32x32.png"), fav32);
  await writeFile(
    path.join(PUBLIC_DIR, "favicon.ico"),
    buildIco([{ size: 16, data: fav16 }, { size: 32, data: fav32 }]),
  );

  // Safari pinned-tab mask icon: monochrome silhouette, transparent background.
  const maskIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><g transform="translate(256 256)">${barsMarkup("#000")}</g></svg>`;
  await writeFile(path.join(PUBLIC_DIR, "mask-icon.svg"), maskIconSvg);

  // --- Apple touch icons (opaque, full-bleed; iOS applies its own corner mask) ---
  for (const size of [120, 152, 167, 180]) {
    const png = await svgToPng(iconSvg(size, { bg: LIGHT_ICON_BG, fg: "#fff" }));
    const name = size === 180 ? "apple-touch-icon.png" : `apple-touch-icon-${size}x${size}.png`;
    await writeFile(path.join(PUBLIC_DIR, name), png);
  }

  // --- Manifest icons ("any" full-bleed + "maskable" with safe-zone padding) ---
  for (const size of [192, 512]) {
    const any = await svgToPng(iconSvg(size, { bg: LIGHT_ICON_BG, fg: "#fff" }));
    await writeFile(path.join(PUBLIC_DIR, `icon-${size}.png`), any);
    const maskable = await svgToPng(iconSvg(size, { bg: LIGHT_ICON_BG, fg: "#fff", glyphScale: 0.62 }));
    await writeFile(path.join(PUBLIC_DIR, `icon-${size}-maskable.png`), maskable);
  }

  // --- Manifest ---
  const manifest = {
    name: "Traffic & Search — Daily Brief",
    short_name: "Stats",
    description: "Daily per-domain traffic and search keyword dashboard.",
    id: "/",
    start_url: "/?source=homescreen",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "browser"],
    orientation: "portrait-primary",
    background_color: LIGHT_BG,
    theme_color: LIGHT_ICON_BG,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  await writeFile(path.join(PUBLIC_DIR, "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");

  // --- Splash screens: light + dark, portrait + landscape, per device bucket ---
  const links = [];
  for (const device of DEVICES) {
    for (const orientation of ["portrait", "landscape"]) {
      const [pw, ph] = orientation === "portrait" ? [device.w, device.h] : [device.h, device.w];
      const w = pw * device.dpr;
      const h = ph * device.dpr;
      for (const scheme of ["light", "dark"]) {
        const bg = scheme === "dark" ? DARK_BG : LIGHT_BG;
        const fg = scheme === "dark" ? LIGHT_FG : LIGHT_ICON_BG;
        const png = await svgToPng(splashSvg(w, h, { bg, fg }));
        const file = `${device.name}-${orientation}-${scheme}.png`;
        await writeFile(path.join(SPLASH_DIR, file), png);
        links.push(
          `<link rel="apple-touch-startup-image" href="/splash/${file}" media="${splashMediaQuery(device, orientation, scheme)}">`,
        );
      }
    }
  }

  const moduleSrc = `// Generated by scripts/generate-icons.mjs — do not edit by hand.
export const APPLE_SPLASH_LINKS = ${JSON.stringify(links.join("\n"))};
`;
  await writeFile(path.join(ROOT, "src", "appleSplashLinks.js"), moduleSrc);

  const files = await readdir(PUBLIC_DIR, { recursive: true });
  console.log(`Generated ${files.length} files under public/ (${links.length / 2} splash device/orientation buckets).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
