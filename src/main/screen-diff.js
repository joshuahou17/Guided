const sharp = require('sharp');

/**
 * Compute a perceptual average hash of an image.
 *
 * Downscales to 64x64 grayscale, computes mean brightness,
 * then produces a binary hash: 1 if pixel >= mean, 0 otherwise.
 * Returns a Buffer of 512 bytes (4096 bits, one per pixel).
 *
 * This is tolerant of minor changes (cursor movement, clock updates)
 * but catches real UI state changes.
 */
async function computeImageHash(imagePath) {
  const { data } = await sharp(imagePath)
    .resize(64, 64, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Compute mean brightness
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  const mean = sum / data.length;

  // Build binary hash: 1 if pixel >= mean, 0 otherwise
  const hash = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    hash[i] = data[i] >= mean ? 1 : 0;
  }

  return hash;
}

/**
 * Compute hamming distance between two perceptual hashes.
 * Returns the number of differing bits.
 */
function hammingDistance(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return Infinity;
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) diff++;
  }
  return diff;
}

/**
 * Returns true if two image hashes differ enough to indicate
 * a real screen change (not just cursor movement or clock update).
 *
 * Threshold: 50 differing pixels out of 4096 (~1.2% of the image).
 * This filters out minor cursor/clock changes but catches menu opens,
 * page transitions, dialog appearances, etc.
 */
function hasScreenChanged(hashA, hashB) {
  const dist = hammingDistance(hashA, hashB);
  return dist >= 50;
}

module.exports = {
  computeImageHash,
  hasScreenChanged,
};
