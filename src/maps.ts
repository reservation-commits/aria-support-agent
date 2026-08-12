import axios from "axios";
import { config } from "./config.js";

/**
 * Google Maps Platform integration.
 *
 * Uses three APIs:
 *  - Geocoding API     → address → { lat, lng }
 *  - Distance Matrix   → origin coords + destination coords → distance + duration
 *  - URL only (free)   → maps_link for the client to open in their phone
 *
 * Geocoding results are cached in memory for the lifetime of the process.
 * For multi-replica deploys you'd want to write the resolved lat/lng back
 * to db_restaurants.latitude/longitude.
 */

const GEO_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const DIST_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";

type LatLng = { lat: number; lng: number };

const geocodeCache = new Map<string, LatLng>();

export function buildMapsLink(input: { address?: string; lat?: number; lng?: number; name?: string }): string {
  if (typeof input.lat === "number" && typeof input.lng === "number") {
    const q = encodeURIComponent(`${input.lat},${input.lng}`);
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }
  const q = encodeURIComponent([input.name, input.address].filter(Boolean).join(", "));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export async function geocodeAddress(address: string): Promise<LatLng | null> {
  if (!config.googleMapsKey) {
    console.warn("[maps] GOOGLE_MAPS_API_KEY not set — geocoding skipped");
    return null;
  }
  const key = address.trim().toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  try {
    const { data } = await axios.get(GEO_URL, {
      params: { address, key: config.googleMapsKey },
      timeout: 8_000,
    });
    if (data?.status !== "OK") {
      console.warn("[maps.geocode]", data?.status, data?.error_message);
      return null;
    }
    const loc = data.results?.[0]?.geometry?.location;
    if (typeof loc?.lat !== "number" || typeof loc?.lng !== "number") return null;
    const result: LatLng = { lat: loc.lat, lng: loc.lng };
    geocodeCache.set(key, result);
    return result;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error("[maps.geocode]", err.response?.status, err.response?.data);
    } else {
      console.error("[maps.geocode]", err);
    }
    return null;
  }
}

export type ResolvedPlace = {
  formattedAddress: string;
  lat: number;
  lng: number;
};

/**
 * Resolve a free-text query (e.g. "Jardin des Sens, Montpellier, France") to a
 * formatted street address + coordinates via Google Geocoding. This is the
 * "search the internet for the address" path used when the database has no
 * address stored for a restaurant.
 */
export async function lookupAddress(query: string): Promise<ResolvedPlace | null> {
  if (!config.googleMapsKey) {
    console.warn("[maps] GOOGLE_MAPS_API_KEY not set — address lookup skipped");
    return null;
  }
  const q = query.trim();
  if (!q) return null;

  try {
    const { data } = await axios.get(GEO_URL, {
      params: { address: q, key: config.googleMapsKey },
      timeout: 8_000,
    });
    if (data?.status !== "OK") {
      console.warn("[maps.lookupAddress]", data?.status, data?.error_message);
      return null;
    }
    const top = data.results?.[0];
    const loc = top?.geometry?.location;
    if (
      !top?.formatted_address ||
      typeof loc?.lat !== "number" ||
      typeof loc?.lng !== "number"
    ) {
      return null;
    }
    return { formattedAddress: top.formatted_address, lat: loc.lat, lng: loc.lng };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error("[maps.lookupAddress]", err.response?.status, err.response?.data);
    } else {
      console.error("[maps.lookupAddress]", err);
    }
    return null;
  }
}

export type TravelMode = "driving" | "walking" | "bicycling" | "transit";

export type RouteResult = {
  distance_text: string;
  distance_meters: number;
  duration_text: string;
  duration_seconds: number;
  mode: TravelMode;
};

export async function computeRoute(params: {
  origin: LatLng;
  destination: LatLng;
  mode?: TravelMode;
  language?: string;
}): Promise<RouteResult | null> {
  if (!config.googleMapsKey) {
    console.warn("[maps] GOOGLE_MAPS_API_KEY not set — distance skipped");
    return null;
  }
  const mode = params.mode ?? "driving";
  try {
    const { data } = await axios.get(DIST_URL, {
      params: {
        origins: `${params.origin.lat},${params.origin.lng}`,
        destinations: `${params.destination.lat},${params.destination.lng}`,
        mode,
        language: params.language ?? "pt-BR",
        units: "metric",
        key: config.googleMapsKey,
      },
      timeout: 8_000,
    });
    if (data?.status !== "OK") {
      console.warn("[maps.distance]", data?.status, data?.error_message);
      return null;
    }
    const element = data.rows?.[0]?.elements?.[0];
    if (element?.status !== "OK") {
      console.warn("[maps.distance] element", element?.status);
      return null;
    }
    return {
      distance_text: element.distance.text,
      distance_meters: element.distance.value,
      duration_text: element.duration.text,
      duration_seconds: element.duration.value,
      mode,
    };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error("[maps.distance]", err.response?.status, err.response?.data);
    } else {
      console.error("[maps.distance]", err);
    }
    return null;
  }
}
