// Distances on the ground, for "near a point" and "nearest" questions. Ituran
// positions stay inside this process: they are never sent to a map service.

import { usage } from './errors.ts';

export interface Point {
  lat: number;
  lon: number;
}

/** "32.08,34.78" as a point, or a usage error naming the flag. */
export function parsePoint(text: string, flag: string): Point {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(
    text,
  );
  const lat = Number(m?.[1]);
  const lon = Number(m?.[2]);
  if (!m || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw usage(`--${flag} takes a point as lat,lon, such as 32.08,34.78.`);
  }
  return { lat, lon };
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A point from row values, or null when Ituran gave none (0,0 means no fix). */
export function pointOf(lat: unknown, lon: unknown): Point | null {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

export const roundKm = (km: number): number => Math.round(km * 10) / 10;
