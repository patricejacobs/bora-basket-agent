/**
 * Everything about a delivery location pin.
 *
 * A pin is the one piece of delivery information a customer cannot get wrong.
 * Addresses in Georgetown are routinely "the blue house past the mosque, Lot 12
 * Non Pariel" — a driver can find that, eventually, by phone. Coordinates need
 * no interpretation, so once a customer shares them they become the delivery
 * point and anything they type is extra colour for the doorstep.
 *
 * Deliberately pure: no database, no network. The channel validates what Meta
 * sent with `parseCoordinates`, the rest of the app formats what it stored.
 */

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type LocationPin = Coordinates & {
  /**
   * What WhatsApp sent alongside the coordinates — a place name, a resolved
   * street address, or both. Often empty: a pin dropped on the map by hand
   * carries nothing but numbers.
   */
  label: string;
};

export type SavedPin = LocationPin & {
  /** ISO timestamp of when the customer shared it. */
  pinnedAt: string;
};

/** Accepts the number Meta sends, and the string some payload versions send. */
function toFinite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Validates a coordinate pair, returning null for anything undeliverable.
 *
 * Out-of-range values would otherwise be stored and handed to a driver as a
 * maps link that opens on nothing. Exactly 0,0 is rejected too: it is a real
 * point in the Gulf of Guinea, but as a delivery address in Guyana it is always
 * an uninitialised field rather than a customer standing in the Atlantic.
 */
export function parseCoordinates(rawLat: unknown, rawLng: unknown): Coordinates | null {
  const latitude = toFinite(rawLat);
  const longitude = toFinite(rawLng);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

/** Joins WhatsApp's place name and street address into one readable label. */
export function pinLabel(name: unknown, address: unknown): string {
  const parts = [
    ...new Set([name, address].map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)),
  ];
  // WhatsApp repeats the place name inside the address often enough to be worth
  // collapsing, or staff read "Stabroek Market — Stabroek Market, Water St".
  // The longer of the two survives, since it is the one that says more.
  const unique = parts.filter(
    (p, i) => !parts.some((other, j) => j !== i && other.length > p.length && other.includes(p)),
  );
  return unique.join(' — ').slice(0, 200);
}

/**
 * The area this shop delivers to: a centre and a radius in kilometres.
 *
 * A circle, not a polygon. A real delivery area is never circular — it follows
 * the river, the bridge and the road — but a radius needs two numbers off a map
 * and no GIS, and it catches what it is for: the pin in another region, or
 * another country. Someone 200m outside a sensibly drawn radius is a phone call
 * for staff to make, not a rule to encode.
 */
export type ServiceArea = Coordinates & { radiusKm: number };

/** Mean earth radius (WGS-84), in kilometres. */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * Great-circle distance between two points, in kilometres.
 *
 * Haversine: accurate to a few metres over a delivery area, and short enough to
 * read. Not road distance — a pin across a river is nearer than it can be
 * driven, which is exactly why the radius is a sanity check and not a quote.
 */
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  // asin is clamped because floating point can push h a hair above 1 for
  // antipodal points, which would otherwise come back NaN.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether a pin is somewhere this shop delivers.
 *
 * `unchecked` is a deliberate third state, not an error. A shop that has not
 * set a radius has not told us where it delivers, and refusing every order on
 * that basis would be a configuration mistake taking the shop off the air. No
 * radius means no opinion, exactly as before the fence existed.
 */
export type RangeCheck =
  | { state: 'unchecked' }
  | { state: 'inside'; distanceKm: number }
  | { state: 'outside'; distanceKm: number; radiusKm: number };

export function checkRange(pin: Coordinates, area: ServiceArea | null): RangeCheck {
  if (!area || !(area.radiusKm > 0)) return { state: 'unchecked' };
  const distance = distanceKm(pin, area);
  return distance <= area.radiusKm
    ? { state: 'inside', distanceKm: distance }
    : { state: 'outside', distanceKm: distance, radiusKm: area.radiusKm };
}

/**
 * A distance as someone would say it.
 *
 * Rounded hard on purpose: "about 2.3 km" is a fact a dispatcher can use, and
 * "2.3418 km" is false precision over a straight line that nobody drives.
 */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** Six decimal places is about 10cm — more than a doorstep needs, and all WhatsApp sends. */
export function formatCoordinates(c: Coordinates): string {
  const round = (n: number): string => String(Number(n.toFixed(6)));
  return `${round(c.latitude)}, ${round(c.longitude)}`;
}

/**
 * A link that opens the pin in the driver's own maps app.
 *
 * Google's documented URL form, which iOS and Android both hand to the
 * installed maps application rather than a browser.
 */
export function mapsLink(c: Coordinates): string {
  return `https://www.google.com/maps?q=${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`;
}

/**
 * One line for a staff message or dispatch list: label if there is one, then
 * the link, then how far out it is.
 *
 * The distance is for the dispatcher's benefit, not the fence's — it is the
 * difference between an order round the corner and one across the city when
 * deciding what the driver takes next.
 */
export function describePin(pin: LocationPin, range: RangeCheck = { state: 'unchecked' }): string {
  const where = pin.label ? `${pin.label}\n` : '';
  const how =
    range.state === 'outside'
      ? ` — ⚠️ ${formatDistance(range.distanceKm)} away, OUTSIDE the ${range.radiusKm} km delivery area`
      : range.state === 'inside'
        ? ` — ${formatDistance(range.distanceKm)} away`
        : '';
  return `${where}📍 ${mapsLink(pin)}${how}`;
}

/**
 * What the agent is told when a pin arrives.
 *
 * Written as a note from the system rather than words from the customer,
 * because the customer sent no words at all — a WhatsApp location message
 * carries no caption. It says plainly that the pin is already saved, so the
 * model does not try to record it again, and it tells the model not to read the
 * numbers out: "I have you at 6.80714, -58.15536" means nothing to anyone.
 */
export function locationNote(
  pin: LocationPin,
  range: RangeCheck = { state: 'unchecked' },
): string {
  const where = pin.label ? ` WhatsApp labels it: ${pin.label}.` : '';

  // Out of area is said at the moment the pin arrives, not held back until
  // checkout. Someone who has shopped for ten minutes and is then told the shop
  // cannot reach them has every right to be annoyed about the ten minutes.
  if (range.state === 'outside') {
    return [
      `[The customer shared their location pin: ${formatCoordinates(pin)}.${where}`,
      `It is ${formatDistance(range.distanceKm)} from the shop, outside the ${range.radiusKm} km delivery area, so an order cannot be placed to it.`,
      'Tell them now, warmly and plainly, that it looks outside the usual delivery area, and that a staff member will confirm on this chat whether a driver can reach them.',
      'Do not promise delivery, do not guess at a fee for going further, and do not ask them to re-send the pin as though it had failed. If they say the pin is wrong or they will be somewhere else, take a new one with request_location.]',
    ].join(' ');
  }

  return [
    `[The customer shared their location pin, and it is now saved as the delivery point for this order: ${formatCoordinates(pin)}.${where}`,
    range.state === 'inside'
      ? `It is ${formatDistance(range.distanceKm)} from the shop, inside the delivery area.`
      : '',
    'Confirm it warmly in words — name the area or the label if you have one, never read the coordinates out.',
    "Then ask for the detail a driver still needs at the door: the house or gate, a flat or floor, and anything that makes it easier to spot. Save that with save_customer_details as the address.]",
  ]
    .filter(Boolean)
    .join(' ');
}
