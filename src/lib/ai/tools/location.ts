// src/lib/ai/tools/location.ts
import { tool } from "ai";
import { z } from "zod";
import {
  getLatestClientLocation,
  resolveIpLocation,
  reverseGeocode,
} from "@/lib/location/geocoding";

export const get_device_location = tool({
  description:
    "Retrieve the physical device location of the user (GPS coordinates, street address, city, region, country, postal code, accuracy in meters, and timezone). Use this tool whenever the user asks about their current location, whereabouts, local weather, nearby places, navigation, local time, or location-dependent services.",
  inputSchema: z.object({
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
  }),
  execute: async ({ includeAddress = true }) => {
    // 1. Check for fresh device location sent from the client
    const recent = getLatestClientLocation();
    if (recent && recent.source === "device_gps") {
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
  },
});
