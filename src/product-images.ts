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
