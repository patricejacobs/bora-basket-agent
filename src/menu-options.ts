/**
 * Menu options: size, spice, sides, "no onions".
 *
 * Groceries have none of this — a bag of rice is a bag of rice — but almost
 * nothing on a food menu can be ordered without a choice, and the choices move
 * the price. So an item carries a spec, the customer's picks are validated
 * against it, and the surcharge is computed here rather than anywhere a language
 * model might do the arithmetic.
 *
 * The spec is written in the menu CSV as compact text, because the person
 * maintaining a menu works in a spreadsheet and will not hand-write JSON:
 *
 *   Size:Regular|Large+200;Extras*:Extra cheese+150|Bacon+250;Spice:Mild|Hot
 *
 *   Name:   exactly one must be chosen
 *   Name?:  at most one, may be skipped
 *   Name*:  any number, may be skipped
 *   +200    adds 200 to the price, in display currency
 */
import { toMinorUnits, money } from './config.ts';

export type OptionChoice = { label: string; surcharge: number };

export type OptionGroup = {
  name: string;
  /** 'one' must be answered; 'upToOne' and 'any' may be skipped. */
  mode: 'one' | 'upToOne' | 'any';
  choices: OptionChoice[];
};

/* ------------------------------------------------------------------ parsing */

/** Reads the CSV spec. Anything malformed is dropped rather than guessed at. */
export function parseOptionSpec(spec: string): OptionGroup[] {
  const groups: OptionGroup[] = [];

  for (const raw of spec.split(';')) {
    const fragment = raw.trim();
    if (!fragment) continue;

    const split = fragment.indexOf(':');
    if (split < 1) continue;

    let name = fragment.slice(0, split).trim();
    const choicesText = fragment.slice(split + 1);

    let mode: OptionGroup['mode'] = 'one';
    if (name.endsWith('*')) {
      mode = 'any';
      name = name.slice(0, -1).trim();
    } else if (name.endsWith('?')) {
      mode = 'upToOne';
      name = name.slice(0, -1).trim();
    }
    if (!name) continue;

    const choices: OptionChoice[] = [];
    for (const choiceText of choicesText.split('|')) {
      const trimmed = choiceText.trim();
      if (!trimmed) continue;

      // "Large+200" — the surcharge is the trailing +number, if any.
      const priced = trimmed.match(/^(.*?)\s*\+\s*([0-9]+(?:\.[0-9]+)?)$/);
      const label = (priced ? priced[1] : trimmed)?.trim() ?? '';
      if (!label) continue;

      const surcharge = priced ? toMinorUnits(priced[2] ?? '0') : 0;
      // Case-insensitive duplicate labels inside one group would make a pick
      // ambiguous, so the first wins.
      if (choices.some((c) => c.label.toLowerCase() === label.toLowerCase())) continue;
      choices.push({ label, surcharge });
    }

    if (choices.length > 0) groups.push({ name, mode, choices });
  }

  return groups;
}

/** The spec as a line a customer can read, for the agent to offer. */
export function describeOptions(groups: OptionGroup[]): string[] {
  return groups.map((group) => {
    const choices = group.choices
      .map((c) => (c.surcharge > 0 ? `${c.label} (+${money(c.surcharge)})` : c.label))
      .join(', ');
    const hint =
      group.mode === 'one' ? 'pick one' : group.mode === 'upToOne' ? 'optional' : 'any number';
    return `${group.name} (${hint}): ${choices}`;
  });
}

/* --------------------------------------------------------------- selection */

export type SelectionResult =
  | { ok: true; normalized: string; surcharge: number; summary: string }
  | { ok: false; error: string };

/**
 * Resolves what the customer picked against what the item offers.
 *
 * Takes a flat list of labels — `["Large", "Extra cheese", "Hot"]` — because
 * that is what a model reliably produces, and works out which group each
 * belongs to. `Group: Choice` is accepted too, for when a label alone is
 * ambiguous.
 */
export function applySelection(groups: OptionGroup[], picked: string[]): SelectionResult {
  if (groups.length === 0) {
    return picked.length === 0
      ? { ok: true, normalized: '', surcharge: 0, summary: '' }
      : { ok: false, error: 'This item has no options to choose.' };
  }

  const chosen = new Map<string, OptionChoice[]>();
  for (const group of groups) chosen.set(group.name, []);

  for (const entry of picked) {
    const text = entry.trim();
    if (!text) continue;

    // "Size: Large" names its own group; a bare "Large" has to be looked up.
    const qualified = text.match(/^([^:]+):\s*(.+)$/);
    const wantGroup = qualified?.[1]?.trim().toLowerCase();
    const wantLabel = (qualified?.[2] ?? text).trim().toLowerCase();

    const matches = groups.flatMap((group) => {
      if (wantGroup && group.name.toLowerCase() !== wantGroup) return [];
      const choice = group.choices.find((c) => c.label.toLowerCase() === wantLabel);
      return choice ? [{ group, choice }] : [];
    });

    if (matches.length === 0) {
      const offered = groups.map((g) => `${g.name}: ${g.choices.map((c) => c.label).join('/')}`);
      return { ok: false, error: `"${text}" is not an option here. Offered — ${offered.join('; ')}.` };
    }
    if (matches.length > 1) {
      const where = matches.map((m) => m.group.name).join(' or ');
      return { ok: false, error: `"${text}" could be ${where}. Ask which one they mean.` };
    }

    const { group, choice } = matches[0]!;
    const already = chosen.get(group.name)!;
    if (already.some((c) => c.label === choice.label)) continue;
    already.push(choice);
  }

  for (const group of groups) {
    const count = chosen.get(group.name)!.length;
    if (group.mode === 'one' && count !== 1) {
      const choices = group.choices.map((c) => c.label).join(', ');
      return {
        ok: false,
        error:
          count === 0
            ? `${group.name} has to be chosen: ${choices}. Ask them.`
            : `Only one ${group.name} can be chosen.`,
      };
    }
    if (group.mode === 'upToOne' && count > 1) {
      return { ok: false, error: `Only one ${group.name} can be chosen.` };
    }
  }

  // Canonical, so two identical burgers land on one cart line and two different
  // ones do not. Group order follows the spec; labels within a group sorted.
  const parts: string[] = [];
  let surcharge = 0;
  for (const group of groups) {
    const picks = chosen.get(group.name)!;
    if (picks.length === 0) continue;
    for (const pick of picks) surcharge += pick.surcharge;
    const labels = [...picks].map((p) => p.label).sort((a, b) => a.localeCompare(b));
    parts.push(`${group.name}=${labels.join(',')}`);
  }

  const normalized = parts.join('; ');
  return {
    ok: true,
    normalized,
    surcharge,
    // What a kitchen ticket and a cart line show: the choices without the
    // group names, which read as noise on a receipt.
    summary: parts.map((p) => p.slice(p.indexOf('=') + 1)).join(', '),
  };
}

/** Turns a stored normalized string back into something readable. */
export function summariseStored(normalized: string): string {
  if (!normalized) return '';
  return normalized
    .split(';')
    .map((part) => part.slice(part.indexOf('=') + 1).trim())
    .filter(Boolean)
    .join(', ');
}
