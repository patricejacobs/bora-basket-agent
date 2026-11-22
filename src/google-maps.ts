/**
 * The two Google Maps calls this shop has any use for, and nothing else.
 *
 * Both are asked ONCE, by hand, from a script a person runs — never from the
 * path a customer or a driver is waiting on. A delivery that cannot be
 * priced because somebody else's API is slow is a worse shop than one whose
 * prices are a little rough, and the answers these give are facts about
 * Guyana's roads: they do not change between Tuesday and Wednesday.
 *
 *   roadDistance()  how far it really is by road, round the river rather
 *                   than across it
 *   geocodePlace()  where a village is, for the ones OpenStreetMap had
 *                   never heard of
 *
 * No key, no calls. Every caller is a script that prints what it would
 * change and writes a file for a person to read, so a missing key is an
 * explanation rather than a failure.
 */
import { config } from './config.ts';

const KEY = process.env.GOOGLE_MAPS_KEY?.trim() ?? '';

export function mapsKeySet(): boolean {
  return KEY.length > 20;
}

export type Point = { latitude: number; longitude: number };

/** Metres and seconds by road, or null when Google cannot route it. */
export async function roadDistance(
  from: Point,
  to: Point,
): Promise<{ metres: number; seconds: number } | null> {
  if (!mapsKeySet()) return null;

  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      // Asking for two fields and no more. The bill and the payload are both
      // charged by what you ask for, and a route's geometry is a kilobyte of
      // polyline nobody here reads.
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({
      origin: { location: { latLng: from } },
      destination: { location: { latLng: to } },
      travelMode: 'DRIVE',
      // Not TRAFFIC_AWARE: Guyana has no live traffic worth the name, and
      // the mode costs more. What is wanted is the road, not the hour.
      routingPreference: 'TRAFFIC_UNAWARE',
      units: 'METRIC',
    }),
  });

  if (!res.ok) {
    console.error(`[maps] routes ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }

  const body = (await res.json()) as {
    routes?: { distanceMeters?: number; duration?: string }[];
  };
  const route = body.routes?.[0];
  if (!route?.distanceMeters) return null;

  return {
    metres: route.distanceMeters,
    seconds: Number(String(route.duration ?? '0s').replace(/[^0-9]/g, '')) || 0,
  };
}

/** Where a place is, asked by name, biased to this country. */
export async function geocodePlace(
  name: string,
): Promise<{ latitude: number; longitude: number; formatted: string; kind: string } | null> {
  if (!mapsKeySet()) return null;

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', `${name}, Guyana`);
  // Guyana only. Without it "Buxton" is in Norfolk and "Georgetown" is in
  // Washington DC, and both answer confidently.
  url.searchParams.set('components', 'country:GY');
  url.searchParams.set('key', KEY);

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[maps] geocode ${res.status}`);
    return null;
  }

  const body = (await res.json()) as {
    status?: string;
    results?: {
      geometry?: { location?: { lat: number; lng: number } };
      formatted_address?: string;
      types?: string[];
    }[];
  };
  const hit = body.results?.[0];
  const at = hit?.geometry?.location;
  if (!at) return null;

  return {
    latitude: at.lat,
    longitude: at.lng,
    formatted: hit?.formatted_address ?? '',
    kind: (hit?.types ?? []).join('/'),
  };
}

/** Where deliveries start from, for measuring against. */
export function shopCentre(): Point | null {
  const area = config.store.serviceArea;
  return area ? { latitude: area.latitude, longitude: area.longitude } : null;
}
