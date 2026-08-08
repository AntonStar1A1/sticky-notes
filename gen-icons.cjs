const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'src-tauri', 'icons');

const svg = `<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" fill="#f5e663" rx="6"/>
</svg>`;

async function main() {
  const buf = Buffer.from(svg);

  await sharp(buf).resize(32, 32).png().toFile(path.join(iconsDir, '32x32.png'));
  await sharp(buf).resize(128, 128).png().toFile(path.join(iconsDir, '128x128.png'));
  await sharp(buf).resize(256, 256).png().toFile(path.join(iconsDir, '128x128@2x.png'));

  // Create ICO from 32x32 PNG
  const png32 = await sharp(buf).resize(32, 32).png().toBuffer();
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const dir = Buffer.alloc(16);
  dir[0] = 32;
  dir[1] = 32;
  dir.writeUInt16LE(1, 4);
  dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(png32.length, 8);
  dir.writeUInt32LE(22, 12);
  fs.writeFileSync(path.join(iconsDir, 'icon.ico'), Buffer.concat([header, dir, png32]));

  console.log('Icons generated successfully');
}

main().catch(e => console.error(e));
