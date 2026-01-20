// Run this script in your browser's console or use the generate-icons.html file
// This creates simple placeholder icons

const fs = require('fs');
const path = require('path');

// Simple 1x1 blue PNG as absolute minimal placeholder
// These are tiny valid PNGs that will display as blue squares
const icon16Base64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVQ4T2NkoBAwUqifYdQAhthgMILYEPwfA/4DwWAwhDAMBiMGQwjDYDCCMAQzDAYjCEMww2AwAgBVZgkRRjjzjQAAAABJRU5ErkJggg==';

const icon48Base64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAdklEQVRoQ+3WwQkAIAwEwej+O7cGC/B5H8gQdoYkS7Kr0nleN/b3GJAeANETiF4A0YsT0Asguv4EdAPiEYhuINELIHoC0QugN5DoBdAbSPQC6A0kegH0BhK9AHoDiV4AvYFEL4DeQKIXQG8g0QugN5DoBegNbH7ABRRJMDFaZHfmAAAAAElFTkSuQmCC';

const icon128Base64 = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAA1klEQVR4Xu3TsREAIAwDsOz/09wFCgrg8pKb5t7uMX3PewFMAygPQA+gB1APYA+oD0D3oB5AD0A9gD2gPgDdg3oAPQD1APaA+gB0D+oB9ADUA9gD6gPQPagH0ANQD2APqA9A96AeQA9APYA9oD4A3YN6AD0A9QD2gPoAdA/qAfQA1APYA+oD0D2oB9ADUA9gD6gPQPegHkAPQD2APaA+AN2DegA9APUA9oD6AHQPwwNIL0B6AfQAhgfQPegB6AH0AGqAeAD1AMYD6B7UA0gvQHoBegD/CvACk4MIMU8HK+QAAAAASUVORK5CYII=';

// Write the placeholder icons
// Note: These are simplified blue squares - use generate-icons.html for proper icons

console.log('To create proper icons:');
console.log('1. Open generate-icons.html in your browser');
console.log('2. Click "Download All" to get the PNG files');
console.log('3. Save them to the icons/ folder');
console.log('');
console.log('For now, creating simple placeholder icons...');

// Simple approach: create a minimal valid PNG
function createSimplePng(size) {
  // This creates a simple blue square PNG
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const width = size;
  const height = size;
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);  // bit depth
  ihdrData.writeUInt8(2, 9);  // color type (RGB)
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);

  // IDAT chunk (compressed image data)
  const zlib = require('zlib');
  const rawData = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rawData[y * (width * 3 + 1)] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      rawData[offset] = 0x00;     // R
      rawData[offset + 1] = 0x78; // G
      rawData[offset + 2] = 0xD4; // B (ServiceNow blue)
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type);
  const crc = crc32(Buffer.concat([typeBuffer, data]));
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

try {
  const iconsDir = path.join(__dirname, 'icons');

  [16, 48, 128].forEach(size => {
    const png = createSimplePng(size);
    const filename = path.join(iconsDir, `icon${size}.png`);
    fs.writeFileSync(filename, png);
    console.log(`Created ${filename}`);
  });

  console.log('\\nPlaceholder icons created! For better icons, use generate-icons.html');
} catch (error) {
  console.error('Error:', error.message);
  console.log('\\nPlease use generate-icons.html in your browser to create the icons.');
}
