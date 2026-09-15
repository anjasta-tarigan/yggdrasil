/**
 * Geolocation & Reverse Geocoding Service.
 *
 * Provides accurate device location resolution with multi-tier fallbacks:
 * 1. Client GPS / Device coordinates (highest precision, meter-level).
 * 2. Reverse geocoding via OpenStreetMap Nominatim with SSRF protection and caching.
 * 3. IP-based network geolocation fallback when GPS coordinates are unavailable.
 * 4. System timezone / locale fallback when network geolocation is unreachable.
 */

import { secureFetch } from "@/lib/security/ssrf";
import { syslog } from "@/lib/observability/log-store";

export interface Coordinates {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  altitudeMeters?: number | null;
  headingDegrees?: number | null;
  speedMps?: number | null;
}

export interface ResolvedAddress {
  formatted: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  postalCode?: string;
  neighbourhood?: string;
}

export interface ResolvedLocation {
  success: boolean;
  source: "device_gps" | "ip_network" | "cached" | "system_locale" | "manual_override";
  coordinates: Coordinates;
  address?: ResolvedAddress;
  timezone?: string;
  locale?: string;
  timestamp: string;
  note?: string;
}

// In-memory cache for reverse geocoding (~11 meter rounding key)
const reverseGeocodeCache = new Map<string, { address: ResolvedAddress; timestamp: number }>();
const REVERSE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_ENTRIES = 500;

// In-memory store of recent location per chat session
const recentChatLocations = new Map<string, ResolvedLocation>();
const MAX_CHAT_LOCATIONS = 200;
let latestClientLocation: { location: ResolvedLocation; timestamp: number } | null = null;
const LATEST_LOCATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Cache key rounded to 4 decimals (~11m resolution) */
function getGeoKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/** Store the latest known device location for a chat and globally */
export function setChatDeviceLocation(chatId: string, location: ResolvedLocation): void {
  if (recentChatLocations.size >= MAX_CHAT_LOCATIONS) {
    const firstKey = recentChatLocations.keys().next().value;
    if (firstKey) recentChatLocations.delete(firstKey);
  }
  recentChatLocations.set(chatId, location);
  latestClientLocation = { location, timestamp: Date.now() };
}

/** Store the latest client location globally */
export function setLatestClientLocation(location: ResolvedLocation): void {
  latestClientLocation = { location, timestamp: Date.now() };
}

/** Retrieve the latest known device location for a chat */
export function getChatDeviceLocation(chatId: string): ResolvedLocation | undefined {
  return recentChatLocations.get(chatId);
}

/** Retrieve the freshest known client location */
export function getLatestClientLocation(): ResolvedLocation | undefined {
  if (latestClientLocation && Date.now() - latestClientLocation.timestamp < LATEST_LOCATION_TTL_MS) {
    return latestClientLocation.location;
  }
  return undefined;
}

/**
 * Reverse-geocode latitude and longitude into human-readable address.
 * Uses Nominatim with SSRF-safe secureFetch and memory caching.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<ResolvedAddress | undefined> {
  const cacheKey = getGeoKey(latitude, longitude);
  const cached = reverseGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < REVERSE_CACHE_TTL_MS) {
    return cached.address;
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`;
    const res = await secureFetch(url, {
      headers: {
        "User-Agent": "Yggdrasil-Assistant/1.0",
        Accept: "application/json",
      },
      timeoutMs: 4000,
    });

    if (!res.ok) {
      syslog("warn", "location", `Nominatim reverse geocode failed with HTTP ${res.status}`);
      return undefined;
    }

    const data = (await res.json()) as {
      display_name?: string;
      address?: {
        city?: string;
        town?: string;
        village?: string;
        municipality?: string;
        county?: string;
        state?: string;
        region?: string;
        country?: string;
        country_code?: string;
        postcode?: string;
        neighbourhood?: string;
        suburb?: string;
      };
    };

    const addr = data.address ?? {};
    const resolved: ResolvedAddress = {
      formatted: data.display_name ?? "",
      city: addr.city || addr.town || addr.village || addr.municipality || addr.county,
      region: addr.state || addr.region,
      country: addr.country,
      countryCode: addr.country_code ? addr.country_code.toUpperCase() : undefined,
      postalCode: addr.postcode,
      neighbourhood: addr.neighbourhood || addr.suburb,
    };

    if (reverseGeocodeCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = reverseGeocodeCache.keys().next().value;
      if (oldestKey) reverseGeocodeCache.delete(oldestKey);
    }
    reverseGeocodeCache.set(cacheKey, { address: resolved, timestamp: Date.now() });

    return resolved;
  } catch (err) {
    syslog("warn", "location", `Reverse geocoding error: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Fallback to IP-based network geolocation when client GPS is unavailable.
 */
export async function resolveIpLocation(clientIp?: string | null): Promise<ResolvedLocation> {
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  // If clientIp is private or localhost, look up public IP info or fallback
  const ipParam =
    clientIp &&
    clientIp !== "127.0.0.1" &&
    clientIp !== "::1" &&
    !clientIp.startsWith("192.168.") &&
    !clientIp.startsWith("10.") &&
    !clientIp.startsWith("172.")
      ? clientIp
      : "";

  try {
    const url = ipParam ? `https://ipwho.is/${encodeURIComponent(ipParam)}` : "https://ipwho.is/";
    const res = await secureFetch(url, {
      headers: { Accept: "application/json" },
      timeoutMs: 4000,
    });

    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean;
        latitude?: number;
        longitude?: number;
        city?: string;
        region?: string;
        country?: string;
        country_code?: string;
        postal?: string;
        timezone?: { id?: string };
        message?: string;
      };

      if (data.success && typeof data.latitude === "number" && typeof data.longitude === "number") {
        return {
          success: true,
          source: "ip_network",
          coordinates: {
            latitude: data.latitude,
            longitude: data.longitude,
            accuracyMeters: 10000, // Coarse IP accuracy estimate (~10km)
          },
          address: {
            formatted: [data.city, data.region, data.country].filter(Boolean).join(", "),
            city: data.city,
            region: data.region,
            country: data.country,
            countryCode: data.country_code,
            postalCode: data.postal,
          },
          timezone: data.timezone?.id || systemTimezone,
          timestamp: new Date().toISOString(),
          note: "Location approximated via network IP geolocation (coarse accuracy)",
        };
      }
    }
  } catch (err) {
    syslog("warn", "location", `IP geolocation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Final fallback to system locale & timezone if IP lookup fails
  return {
    success: true,
    source: "system_locale",
    coordinates: {
      latitude: 0,
      longitude: 0,
      accuracyMeters: undefined,
    },
    timezone: systemTimezone,
    timestamp: new Date().toISOString(),
    note: "Coordinates unavailable; system timezone and locale fallback provided",
  };
}

/**
 * Search/forward-geocode a place name, city, or address into coordinates.
 * Allows users to set an accurate manual location override when device GPS is unavailable.
 */
export async function searchLocation(query: string): Promise<ResolvedLocation | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      trimmed
    )}&format=jsonv2&addressdetails=1&limit=1`;
    const res = await secureFetch(url, {
      headers: {
        "User-Agent": "Yggdrasil-Assistant/1.0",
        Accept: "application/json",
      },
      timeoutMs: 5000,
    });

    if (!res.ok) {
      syslog("warn", "location", `Nominatim search failed with HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      address?: {
        city?: string;
        town?: string;
        village?: string;
        municipality?: string;
        county?: string;
        state?: string;
        region?: string;
        country?: string;
        country_code?: string;
        postcode?: string;
        suburb?: string;
        neighbourhood?: string;
      };
    }>;

    if (!data || data.length === 0) return null;
    const item = data[0];
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    if (isNaN(lat) || isNaN(lon)) return null;

    const addr = item.address ?? {};
    const city =
      addr.city ||
      addr.town ||
      addr.village ||
      addr.municipality ||
      addr.suburb ||
      addr.county;
    const region = addr.state || addr.region;

    // Timezone mapping for common regions (e.g. Bali is WITA / Asia/Makassar)
    let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if (addr.country_code?.toLowerCase() === "id") {
      const isWita =
        region?.toLowerCase().includes("bali") ||
        region?.toLowerCase().includes("nusa tenggara") ||
        region?.toLowerCase().includes("sulawesi") ||
        region?.toLowerCase().includes("kalimantan selatan") ||
        region?.toLowerCase().includes("kalimantan timur");
      const isWit =
        region?.toLowerCase().includes("maluku") ||
        region?.toLowerCase().includes("papua");
      if (isWita) timezone = "Asia/Makassar";
      else if (isWit) timezone = "Asia/Jayapura";
      else timezone = "Asia/Jakarta";
    }

    return {
      success: true,
      source: "manual_override",
      coordinates: {
        latitude: lat,
        longitude: lon,
        accuracyMeters: 50,
      },
      address: {
        formatted: item.display_name,
        city,
        region,
        country: addr.country,
        countryCode: addr.country_code ? addr.country_code.toUpperCase() : undefined,
        postalCode: addr.postcode,
        neighbourhood: addr.neighbourhood || addr.suburb,
      },
      timezone,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    syslog("warn", "location", `Search location error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Resolve location given potential client coordinates and fallback IP.
 */
export async function resolveLocation(options: {
  clientCoordinates?: Coordinates | null;
  clientTimezone?: string;
  clientLocale?: string;
  clientIp?: string | null;
  includeAddress?: boolean;
}): Promise<ResolvedLocation> {
  const { clientCoordinates, clientTimezone, clientLocale, clientIp, includeAddress = true } = options;

  if (
    clientCoordinates &&
    typeof clientCoordinates.latitude === "number" &&
    typeof clientCoordinates.longitude === "number" &&
    !isNaN(clientCoordinates.latitude) &&
    !isNaN(clientCoordinates.longitude)
  ) {
    let address: ResolvedAddress | undefined;
    if (includeAddress) {
      address = await reverseGeocode(clientCoordinates.latitude, clientCoordinates.longitude);
    }

    return {
      success: true,
      source: "device_gps",
      coordinates: clientCoordinates,
      address,
      timezone: clientTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      locale: clientLocale || (typeof navigator !== "undefined" ? navigator.language : undefined),
      timestamp: new Date().toISOString(),
    };
  }

  // Fallback to IP geolocation
  return resolveIpLocation(clientIp);
}
