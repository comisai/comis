// SPDX-License-Identifier: Apache-2.0
/**
 * GPS Location Normalizer.
 *
 * Provides a shared location type and normalization function for converting
 * platform-specific GPS coordinates (Telegram, WhatsApp, LINE) into a standard
 * metadata.location format within NormalizedMessage.
 *
 * Note: GpsLocation is a plain TypeScript interface (not a Zod schema) because
 * the channels package does not depend on zod directly. Validation of coordinate
 * ranges is handled by the GpsLocationSchema re-export from @comis/core if
 * needed by consumers.
 *
 * @module
 */

/**
 * Standard GPS location object stored in NormalizedMessage.metadata.location.
 *
 * Latitude: -90 to 90 (decimal degrees)
 * Longitude: -180 to 180 (decimal degrees)
 */
export interface GpsLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  name?: string;
  address?: string;
}

/**
 * Normalize GPS coordinates into a standard location object with human-readable text.
 *
 * When no name or address is provided, the text fallback uses formatted lat/lng coordinates.
 *
 * @param lat - Latitude in decimal degrees (-90 to 90)
 * @param lng - Longitude in decimal degrees (-180 to 180)
 * @param opts - Optional name, address, and accuracy fields
 * @returns An object with `text` (human-readable) and `location` (GpsLocation)
 */
export function normalizeLocation(lat: number, lng: number, opts?: {
  accuracy?: number;
  name?: string;
  address?: string;
}): { text: string; location: GpsLocation } {
  const location: GpsLocation = {
    latitude: lat,
    longitude: lng,
    ...(opts?.accuracy != null ? { accuracy: opts.accuracy } : {}),
    ...(opts?.name ? { name: opts.name } : {}),
    ...(opts?.address ? { address: opts.address } : {}),
  };
  const label = opts?.name ?? opts?.address ?? `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const text = `[Location: ${label}]`;
  return { text, location };
}
