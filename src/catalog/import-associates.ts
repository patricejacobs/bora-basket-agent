/**
 * The delivery associates, from a committed CSV.
 *
 * Same principle as the outlets and the menu: a hosted deploy has no shell, so
 * a file in the repository is how a list gets corrected. It answers the one
 * thing a phone number cannot - which of them is that, and what are they
 * driving.
 *
 *   phone,name,vehicle,active
 *   5926001111,Rider One,GSS 1234,1
 *
 * Only `phone` and `name` are required. A row with no vehicle is fine; a shop
 * running motorbikes nobody plates has nothing to put there.
 */
import { parseCsv } from './import-csv.ts';
import * as repo from '../db/repo.ts';

const HEADERS: Record<string, string> = {
  phone: 'phone',
  number: 'phone',
  whatsapp: 'phone',
  name: 'name',
  associate: 'name',
  driver: 'name',
  vehicle: 'vehicle',
  van: 'vehicle',
  bike: 'vehicle',
  plate: 'vehicle',
  registration: 'vehicle',
  active: 'active',
};

export type AssociateImport = {
  imported: number;
  skipped: { line: number; reason: string }[];
};

export function importAssociatesText(text: string): AssociateImport {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error('Associates CSV is empty.');

  const columns = header.map((h) => HEADERS[h.trim().toLowerCase()] ?? '');
  for (const required of ['phone', 'name'] as const) {
    if (!columns.includes(required)) {
      throw new Error(`Associates CSV needs a "${required}" column. Found: ${header.join(', ')}`);
    }
  }

  const skipped: AssociateImport['skipped'] = [];
  let imported = 0;

  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    if (row.every((cell) => cell.trim() === '')) return;

    const get = (name: string): string => {
      const at = columns.indexOf(name);
      return at === -1 ? '' : (row[at] ?? '').trim();
    };

    // Digits only, because that is how a number arrives on a webhook: a
    // directory keyed on "+592 600 1111" would never match the sender.
    const phone = get('phone').replace(/[^0-9]/g, '');
    const name = get('name');
    if (!phone) return void skipped.push({ line, reason: 'no phone number' });
    if (!name) return void skipped.push({ line, reason: `no name for ${phone}` });

    const active = get('active').toLowerCase();
    repo.upsertAssociate({
      phone,
      name,
      vehicle: get('vehicle'),
      active: !(active === '0' || active === 'false' || active === 'no'),
    });
    imported++;
  });

  return { imported, skipped };
}
