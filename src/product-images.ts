/**
 * Product photos served from disk.
 *
 * WhatsApp fetches image URLs itself, so a photo has to live somewhere publicly
 * reachable over HTTPS. Requiring a CDN or image host for that is a lot of
 * ceremony for a shop that just wants to photograph its own shelf — so the
 * server hosts them: drop `RIC-001.jpg` into the images folder and it is live.
 *
 * A URL set explicitly in the catalogue CSV always wins; the folder is the
 * fallback. That way a supplier-provided URL and your own photograph can coexist
 * without either having to know about the other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/** Formats WhatsApp will fetch and Claude can read. */
const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * The folder is re-scanned rather than watched: photos are added in batches by a
 * person, not continuously, and a short TTL means a newly dropped file appears
 * within seconds without a restart or a filesystem watcher to leak.
 */
const INDEX_TTL_MS = 20_000;

let index = new Map<string, string>();
let indexedAt = 0;

export function imagesDirectory(): string {
  return path.resolve(config.productImagesDir);
}

/** Creates the folder on first use so the path is obvious even when it is empty. */
export function ensureImagesDirectory(): void {
  try {
    fs.mkdirSync(imagesDirectory(), { recursive: true });
  } catch (err) {
    console.warn(`[images] could not create ${imagesDirectory()}:`, err);
  }
}

function rebuildIndex(): void {
  const dir = imagesDirectory();
  const next = new Map<string, string>();
  try {
    for (const file of fs.readdirSync(dir)) {
      const ext = path.extname(file).toLowerCase();
      if (!EXTENSIONS.includes(ext)) continue;
      // Keyed by SKU, case-insensitively: someone naming a file ric-001.jpg
      // should not have to discover why it silently did not work.
      const sku = path.basename(file, path.extname(file)).toLowerCase();
      if (!next.has(sku)) next.set(sku, file);
    }
  } catch {
    // A missing folder simply means no photos yet.
  }
  index = next;
  indexedAt = Date.now();
}

function currentIndex(): Map<string, string> {
  if (Date.now() - indexedAt > INDEX_TTL_MS) rebuildIndex();
  return index;
}

/** Forces a re-scan, for tests and for the startup banner. */
export function refreshImages(): number {
  rebuildIndex();
  return index.size;
}

export function imageCount(): number {
  return currentIndex().size;
}

/**
 * The URL to send for a product, or empty when it has no photo.
 *
 * Returns an absolute URL because WhatsApp fetches it from its own servers — a
 * relative path would resolve against Meta, not against us.
 */
export function productImageUrl(sku: string, storedUrl: string): string {
  if (storedUrl) return storedUrl;

  const file = currentIndex().get(sku.toLowerCase());
  if (!file) return '';

  const base = config.publicBaseUrl.replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/images/${encodeURIComponent(file)}`;
}

/** Which SKUs have a photo on disk — used to report coverage honestly. */
export function skusWithLocalImages(): string[] {
  return [...currentIndex().keys()];
}

/* ------------------------------------------------ putting one on the shelf */

/** What WhatsApp sends, and what each becomes on disk. */
const FROM_MEDIA_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export type PhotoSaved =
  | { saved: true; file: string; replaced: boolean }
  | { saved: false; reason: string };

/**
 * Saves a photograph sent in by the shop, named after the product.
 *
 * The folder lives on the host's persistent disk, which deploys cannot reach
 * and git cannot write to - so without a way in, "drop RIC-001.jpg in the
 * folder" meant nothing to anybody who did not have a shell on the server.
 * Nobody is going to SSH into a host to upload a picture of callaloo.
 *
 * Replacing one is deliberate and is reported. A shopkeeper who photographs
 * the tomatoes twice means the second one, and any other behaviour leaves
 * them wondering which the customer is seeing.
 */
export function savePhotoFor(sku: string, image: { base64: string; mediaType: string }): PhotoSaved {
  const clean = sku.trim();
  if (!clean) return { saved: false, reason: 'no SKU given' };

  const ext = FROM_MEDIA_TYPE[image.mediaType.toLowerCase()];
  if (!ext) {
    return { saved: false, reason: `${image.mediaType} is not a picture this can store` };
  }

  const bytes = Buffer.from(image.base64, 'base64');
  if (bytes.length === 0) return { saved: false, reason: 'the photo arrived empty' };

  ensureImagesDirectory();
  const dir = imagesDirectory();

  // Any other extension for the same SKU goes, or the folder ends up holding
  // VEG-001.jpg and VEG-001.png and the index picks whichever it meets first.
  let replaced = false;
  for (const other of EXTENSIONS) {
    const previous = path.join(dir, `${clean}${other}`);
    if (fs.existsSync(previous)) {
      fs.rmSync(previous);
      replaced = true;
    }
  }

  const file = `${clean}${ext}`;
  fs.writeFileSync(path.join(dir, file), bytes);
  // The index is rescanned on a timer; a photo somebody just sent should be
  // live in the next message, not in twenty seconds.
  refreshImages();
  return { saved: true, file, replaced };
}
