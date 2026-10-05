/**
 * WHAT: Dev script — crops empty/black margins from assets/logo.png.
 * WHY: Splash and marketing assets look tighter without manual editing.
 * HOW: Run from mobile folder: node scripts/cropLogo.js (uses jimp).
 */
const fs = require('fs');
const path = require('path');

async function main() {
  let Jimp;
  try {
    Jimp = require('jimp');
  } catch {
    console.log('Installing jimp temporarily...');
    require('child_process').execSync('npm install jimp --no-save', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    Jimp = require('jimp');
  }

  const src = path.join(__dirname, '..', 'assets', 'logo.png');
  const dest = path.join(__dirname, '..', 'assets', 'logo-cropped.png');

  const image = await Jimp.read(src);
  const { width, height } = image.bitmap;

  // Find non-near-black bounding box
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  const threshold = 18; // treat near-black as padding

  image.scan(0, 0, width, height, function (x, y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const a = this.bitmap.data[idx + 3];
    if (a < 10) return;
    if (r <= threshold && g <= threshold && b <= threshold) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });

  if (maxX <= minX || maxY <= minY) {
    throw new Error('Could not detect logo content bounds.');
  }

  // Small padding so edges aren't clipped
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  console.log(`Original: ${width}x${height}`);
  console.log(`Crop: x=${minX} y=${minY} ${cropW}x${cropH}`);

  image.crop(minX, minY, cropW, cropH);
  await image.writeAsync(dest);
  console.log('Saved:', dest);
  console.log('Done. Header can use logo-cropped.png');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
