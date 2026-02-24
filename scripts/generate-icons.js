// Generate minimal tray icon PNGs for development
// Run: node scripts/generate-icons.js

const fs = require("fs");
const path = require("path");

// Minimal 22x22 PNG with a filled circle (template image for macOS)
// This is a hand-crafted minimal PNG file
function createMinimalPng(size) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 4; // color type: greyscale with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Create image data - circle in center
  const center = size / 2;
  const radius = size / 2 - 2;
  const rawData = [];

  for (let y = 0; y < size; y++) {
    rawData.push(0); // filter byte: None
    for (let x = 0; x < size; x++) {
      const dx = x - center + 0.5;
      const dy = y - center + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        rawData.push(0); // grey: black
        rawData.push(255); // alpha: opaque
      } else if (dist <= radius + 1) {
        // Anti-alias edge
        const alpha = Math.round(255 * Math.max(0, radius + 1 - dist));
        rawData.push(0);
        rawData.push(alpha);
      } else {
        rawData.push(0); // grey
        rawData.push(0); // alpha: transparent
      }
    }
  }

  const { deflateSync } = require("zlib");
  const compressed = deflateSync(Buffer.from(rawData));

  // Build chunks
  const chunks = [];

  // IHDR chunk
  chunks.push(createChunk("IHDR", ihdr));

  // IDAT chunk
  chunks.push(createChunk("IDAT", compressed));

  // IEND chunk
  chunks.push(createChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat([signature, ...chunks]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const assetsDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(assetsDir, { recursive: true });

// 22x22 standard tray icon (Template suffix for macOS dark/light auto-switch)
fs.writeFileSync(path.join(assetsDir, "tray-iconTemplate.png"), createMinimalPng(22));
// 44x44 retina
fs.writeFileSync(path.join(assetsDir, "tray-iconTemplate@2x.png"), createMinimalPng(44));

console.log("Tray icons generated in assets/");
