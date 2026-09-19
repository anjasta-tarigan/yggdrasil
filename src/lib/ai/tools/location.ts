// src/lib/ai/tools/location.ts
import { tool } from "ai";
import { z } from "zod";
import {
  getChatDeviceLocation,
  resolveIpLocation,
  reverseGeocode,
} from "@/lib/location/geocoding";

const locationInputSchema = z.object({
  highAccuracy: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to prefer high accuracy GPS positioning if available"),
  includeAddress: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to reverse-geocode coordinates into a human-readable street/city address"),
});

type LocationInput = z.infer<typeof locationInputSchema>;

async function resolveDeviceLocation(
  chatId: string | undefined,
  { includeAddress = true }: LocationInput
) {
  // 1. Check for a fresh device location reported by THIS chat.
  //    Keyed by chatId on purpose: a module-global "latest" location would
  //    hand chat B the GPS coordinates chat A last sent, which breaks the
  //    per-chat isolation invariant.
  const recent = chatId ? getChatDeviceLocation(chatId) : undefined;
  if (recent && recent.source === "device_gps" && recent.coordinates) {
    if (includeAddress && !recent.address) {
      const address = await reverseGeocode(
        recent.coordinates.latitude,
        recent.coordinates.longitude
      );
      return {
        ...recent,
        address,
      };
    }
    return recent;
  }

  // 2. Fall back to network IP geolocation
  const fallback = await resolveIpLocation();
  return fallback;
}

/**
 * Default export used by the static built-in registry (no chat binding).
 * Prefer {@link createGetDeviceLocationTool} in request paths so the lookup
 * is scoped to the calling chat.
 */
export const get_device_location = tool({
  description:
    "Retrieve the physical device location of the user (GPS coordinates, street address, city, region, country, postal code, accuracy in meters, and timezone). Use this tool whenever the user asks about their current location, whereabouts, local weather, nearby places, navigation, local time, or location-dependent services.",
  inputSchema: locationInputSchema,
  execute: async (input: LocationInput) => resolveDeviceLocation(undefined, input),
});

/**
 * Builds the device-location tool bound to a single chat, so the GPS fix it
 * reads is the one that chat reported.
 */
export function createGetDeviceLocationTool(chatId: string | undefined) {
  return tool({
    description:
      "Retrieve the physical device location of the user (GPS coordinates, street address, city, region, country, postal code, accuracy in meters, and timezone). Use this tool whenever the user asks about their current location, whereabouts, local weather, nearby places, navigation, local time, or location-dependent services.",
    inputSchema: locationInputSchema,
    execute: async (input: LocationInput) => resolveDeviceLocation(chatId, input),
  });
}
