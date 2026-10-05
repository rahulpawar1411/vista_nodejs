/**
 * WHAT: Dev script — builds Expo/iOS/Android launcher and splash icon PNGs from the logo.
 * WHY: Store builds require fixed-size icon assets in assets/.
 * HOW: Run: node scripts/generateAppIcon.js (see outputs listed in script comments).
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

async function loadJimp() {
  try {
    return require('jimp');
  } catch {
    console.log('Installing jimp…');
    execSync('npm install jimp --no-save', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    return require('jimp');
  }
}

/** White background behind logo */
const BG = { r: 255, g: 255, b: 255, a: 255 };

/** Soft brand-blue border around rounded icon */
const BORDER = { r: 0, g: 53, b: 128, a: 255 };
const BORDER_WIDTH_RATIO = 0.018; // ~18px at 1024
const CORNER_RADIUS_RATIO = 0.22; // iOS-like rounded square

async function contentBounds(image, alphaMin = 12) {
  const width = image.width;
  const height = image.height;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  image.scan(0, 0, width, height, function (x, y, idx) {
    const a = this.bitmap.data[idx + 3];
    if (a < alphaMin) return;
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    if (r < 20 && g < 20 && b < 20) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });

  if (maxX <= minX || maxY <= minY) {
    return { x: 0, y: 0, w: width, h: height };
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Squircle / rounded-rect distance for corner masking */
function roundedRectAlpha(x, y, size, radius) {
  const r = Math.max(0, Math.min(radius, size / 2));
  // Inside solid area
  const inX = x >= r && x < size - r;
  const inY = y >= r && y < size - r;
  if (inX || inY) {
    if (x >= 0 && x < size && y >= 0 && y < size) return 255;
    return 0;
  }
  // Corner circles
  let cx;
  let cy;
  if (x < r && y < r) {
    cx = r;
    cy = r;
  } else if (x >= size - r && y < r) {
    cx = size - r - 1;
    cy = r;
  } else if (x < r && y >= size - r) {
    cx = r;
    cy = size - r - 1;
  } else {
    cx = size - r - 1;
    cy = size - r - 1;
  }
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 255 : 0;
}

/**
 * Apply rounded corners + optional border stroke.
 * Outside the rounded rect becomes fully transparent.
 */
function applyRoundedBorder(Jimp, rgbaToInt, image, { radiusRatio = CORNER_RADIUS_RATIO, border = true } = {}) {
  const size = image.width;
  const radius = Math.round(size * radiusRatio);
  const borderW = border ? Math.max(2, Math.round(size * BORDER_WIDTH_RATIO)) : 0;

  image.scan(0, 0, size, size, function (x, y, idx) {
    const outerA = roundedRectAlpha(x, y, size, radius);
    if (outerA === 0) {
      this.bitmap.data[idx] = 0;
      this.bitmap.data[idx + 1] = 0;
      this.bitmap.data[idx + 2] = 0;
      this.bitmap.data[idx + 3] = 0;
      return;
    }
    if (borderW > 0) {
      const innerR = Math.max(0, radius - borderW);
      const inset = borderW;
      const ix = x - inset;
      const iy = y - inset;
      const innerSize = size - inset * 2;
      let inside = false;
      if (innerSize > 0 && ix >= 0 && iy >= 0 && ix < innerSize && iy < innerSize) {
        inside = roundedRectAlpha(ix, iy, innerSize, innerR) === 255;
      }
      if (!inside) {
        this.bitmap.data[idx] = BORDER.r;
        this.bitmap.data[idx + 1] = BORDER.g;
        this.bitmap.data[idx + 2] = BORDER.b;
        this.bitmap.data[idx + 3] = 255;
      }
    }
  });

  return image;
}

async function makeSquareIcon(
  Jimp,
  rgbaToInt,
  srcPath,
  destPath,
  { size = 1024, padRatio = 0.12, transparent = false, rounded = false, border = false } = {}
) {
  const src = await Jimp.read(srcPath);
  const box = await contentBounds(src);
  let cropped = src.clone().crop({ x: box.x, y: box.y, w: box.w, h: box.h });

  const bgColor = transparent ? 0x00000000 : rgbaToInt(BG.r, BG.g, BG.b, BG.a);
  const canvas = new Jimp({ width: size, height: size, color: bgColor });

  const maxSide = Math.floor(size * (1 - padRatio * 2));
  const scale = Math.min(maxSide / cropped.width, maxSide / cropped.height);
  const tw = Math.max(1, Math.round(cropped.width * scale));
  const th = Math.max(1, Math.round(cropped.height * scale));
  cropped = cropped.resize({ w: tw, h: th });

  const ox = Math.floor((size - tw) / 2);
  const oy = Math.floor((size - th) / 2);
  canvas.composite(cropped, ox, oy);

  if (rounded) {
    applyRoundedBorder(Jimp, rgbaToInt, canvas, { border });
  }

  await canvas.write(destPath);
  console.log(`✅ ${path.basename(destPath)} (${size}×${size}${rounded ? ', rounded' : ''})`);
}

async function main() {
  const { Jimp, rgbaToInt } = await loadJimp();
  const assets = path.join(__dirname, '..', 'assets');
  const srcCandidates = [
    path.join(assets, 'logo-transparent.png'),
    path.join(assets, 'logo.png')
  ];
  const src = srcCandidates.find((p) => fs.existsSync(p));
  if (!src) throw new Error('No logo found in assets/');

  console.log('Using source:', path.basename(src));

  // Main app icon: white bg + rounded corners + blue border
  await makeSquareIcon(Jimp, rgbaToInt, src, path.join(assets, 'icon.png'), {
    size: 1024,
    padRatio: 0.12,
    rounded: true,
    border: true
  });

  // Android adaptive foreground: logo on transparent (system masks shape)
  await makeSquareIcon(Jimp, rgbaToInt, src, path.join(assets, 'android-icon-foreground.png'), {
    size: 1024,
    padRatio: 0.22,
    transparent: true
  });

  // Android adaptive background: white
  const bg = new Jimp({
    width: 1024,
    height: 1024,
    color: rgbaToInt(BG.r, BG.g, BG.b, BG.a)
  });
  await bg.write(path.join(assets, 'android-icon-background.png'));
  console.log('✅ android-icon-background.png (white)');

  await makeSquareIcon(Jimp, rgbaToInt, src, path.join(assets, 'splash-icon.png'), {
    size: 512,
    padRatio: 0.15,
    rounded: true,
    border: true
  });

  await makeSquareIcon(Jimp, rgbaToInt, src, path.join(assets, 'favicon.png'), {
    size: 48,
    padRatio: 0.1,
    rounded: true,
    border: true
  });

  const test = path.join(assets, '_test-icon.png');
  if (fs.existsSync(test)) fs.unlinkSync(test);

  console.log('\nDone. White bg + rounded border applied.');
  console.log('Home-screen icon updates after a real build (APK/IPA).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
