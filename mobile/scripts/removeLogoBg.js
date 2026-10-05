/**
 * WHAT: Dev script — removes black background and crops transparent logo PNG.
 * WHY: Icons and splash look better on non-black backgrounds.
 * HOW: Run: node scripts/removeLogoBg.js → assets/logo-transparent.png
 */
const path = require('path');
const fs = require('fs');

function resolveJimp() {
  try {
    return require(path.join(__dirname, '..', 'node_modules', 'jimp'));
  } catch {
    require('child_process').execSync('npm install jimp@0.22.12 --no-save', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    return require(path.join(__dirname, '..', 'node_modules', 'jimp'));
  }
}

function isNearBlack(data, idx, threshold) {
  return (
    data[idx] <= threshold &&
    data[idx + 1] <= threshold &&
    data[idx + 2] <= threshold &&
    data[idx + 3] > 0
  );
}

async function main() {
  const JimpMod = resolveJimp();
  const Jimp = JimpMod.Jimp || JimpMod;
  const read = Jimp.read ? Jimp.read.bind(Jimp) : JimpMod.read;

  const fromOriginal = path.join(__dirname, '..', 'assets', 'logo.png');
  const input = fs.existsSync(fromOriginal)
    ? fromOriginal
    : path.join(__dirname, '..', 'assets', 'logo-transparent.png');

  const image = await read(input);
  let width = image.bitmap.width;
  let height = image.bitmap.height;
  let data = image.bitmap.data;
  const threshold = 35;
  const visited = new Uint8Array(width * height);
  const queue = [];

  const pushIfBg = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (visited[i]) return;
    const idx = i * 4;
    if (!isNearBlack(data, idx, threshold)) return;
    visited[i] = 1;
    queue.push(i);
  };

  for (let x = 0; x < width; x++) {
    pushIfBg(x, 0);
    pushIfBg(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushIfBg(0, y);
    pushIfBg(width - 1, y);
  }

  while (queue.length) {
    const i = queue.pop();
    const x = i % width;
    const y = (i / width) | 0;
    data[i * 4 + 3] = 0;
    pushIfBg(x + 1, y);
    pushIfBg(x - 1, y);
    pushIfBg(x, y + 1);
    pushIfBg(x, y - 1);
  }

  // Crop to opaque content
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a < 10) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  if (typeof image.crop === 'function') {
    try {
      // jimp v1
      image.crop({ x: minX, y: minY, w: cropW, h: cropH });
    } catch {
      // jimp 0.x
      image.crop(minX, minY, cropW, cropH);
    }
  }

  const dest = path.join(__dirname, '..', 'assets', 'logo-transparent.png');
  if (typeof image.writeAsync === 'function') await image.writeAsync(dest);
  else await image.write(dest);

  data = image.bitmap.data;
  width = image.bitmap.width;
  height = image.bitmap.height;
  console.log(`Saved ${dest} ${width}x${height} (cropped from ${minX},${minY})`);
  console.log(`cornerA=${data[3]} centerA=${data[(((height / 2) | 0) * width + ((width / 2) | 0)) * 4 + 3]}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
