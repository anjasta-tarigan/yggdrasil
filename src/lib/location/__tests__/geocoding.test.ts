import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveLocation,
  searchLocation,
  setChatDeviceLocation,
  getChatDeviceLocation,
  setLatestClientLocation,
  getLatestClientLocation,
  reverseGeocode,
} from "../geocoding";
import { get_device_location } from "@/lib/ai/tools/location";

// Mock secureFetch
vi.mock("@/lib/security/ssrf", () => ({
  secureFetch: vi.fn(),
}));

import { secureFetch } from "@/lib/security/ssrf";
const mockSecureFetch = vi.mocked(secureFetch);

describe("geocoding service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves location accurately with provided GPS coordinates and reverse geocodes", async () => {
    mockSecureFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        display_name: "123 Market St, San Francisco, California, 94105, United States",
        address: {
          city: "San Francisco",
          state: "California",
          country: "United States",
          country_code: "us",
          postcode: "94105",
          neighbourhood: "Financial District",
        },
      }),
    } as unknown as Response);

    const result = await resolveLocation({
      clientCoordinates: {
        latitude: 37.7749,
        longitude: -122.4194,
        accuracyMeters: 10,
      },
      clientTimezone: "America/Los_Angeles",
      includeAddress: true,
    });

    expect(result.success).toBe(true);
    expect(result.source).toBe("device_gps");
    expect(result.coordinates.latitude).toBe(37.7749);
    expect(result.coordinates.longitude).toBe(-122.4194);
    expect(result.coordinates.accuracyMeters).toBe(10);
    expect(result.address?.city).toBe("San Francisco");
    expect(result.address?.region).toBe("California");
    expect(result.address?.country).toBe("United States");
    expect(result.address?.postalCode).toBe("94105");
    expect(result.timezone).toBe("America/Los_Angeles");
  });

  it("falls back to IP geolocation when coordinates are absent", async () => {
    mockSecureFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        latitude: 40.7128,
        longitude: -74.006,
        city: "New York",
        region: "New York",
        country: "United States",
        country_code: "US",
        postal: "10001",
        timezone: { id: "America/New_York" },
      }),
    } as unknown as Response);

    const result = await resolveLocation({
      clientCoordinates: null,
      clientIp: "8.8.8.8",
    });

    expect(result.success).toBe(true);
    expect(result.source).toBe("ip_network");
    expect(result.coordinates.latitude).toBe(40.7128);
    expect(result.coordinates.longitude).toBe(-74.006);
    expect(result.address?.city).toBe("New York");
    expect(result.timezone).toBe("America/New_York");
  });

  it("falls back to system locale when network and IP geolocations are unreachable", async () => {
    mockSecureFetch.mockRejectedValueOnce(new Error("Network offline"));

    const result = await resolveLocation({
      clientCoordinates: null,
      clientIp: null,
    });

    expect(result.success).toBe(true);
    expect(result.source).toBe("system_locale");
    expect(result.timezone).toBeDefined();
    expect(result.note).toContain("fallback");
  });

  it("stores and retrieves per-chat device location", () => {
    const mockLoc = {
      success: true,
      source: "device_gps" as const,
      coordinates: { latitude: 51.5074, longitude: -0.1278, accuracyMeters: 5 },
      timezone: "Europe/London",
      timestamp: new Date().toISOString(),
    };

    setChatDeviceLocation("chat-xyz", mockLoc);
    const retrieved = getChatDeviceLocation("chat-xyz");
    expect(retrieved).toEqual(mockLoc);
  });

  it("searches forward location query and returns exact coordinates with manual_override", async () => {
    mockSecureFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-8.1103",
          lon: "115.1016",
          display_name: "Banyuning, Buleleng, Bali, Indonesia",
          address: {
            suburb: "Banyuning",
            town: "Buleleng",
            state: "Bali",
            country: "Indonesia",
            country_code: "id",
          },
        },
      ],
    } as unknown as Response);

    const result = await searchLocation("Banyuning, Bali");
    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.source).toBe("manual_override");
    expect(result?.coordinates.latitude).toBeCloseTo(-8.1103);
    expect(result?.coordinates.longitude).toBeCloseTo(115.1016);
    expect(result?.address?.city).toBe("Buleleng");
    expect(result?.address?.neighbourhood).toBe("Banyuning");
    expect(result?.address?.region).toBe("Bali");
    expect(result?.timezone).toBe("Asia/Makassar");
  });
});

describe("get_device_location tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes and returns latest client location if fresh", async () => {
    const mockLoc = {
      success: true,
      source: "device_gps" as const,
      coordinates: { latitude: -6.2088, longitude: 106.8456, accuracyMeters: 12 },
      address: {
        formatted: "Jakarta, Indonesia",
        city: "Jakarta",
        country: "Indonesia",
      },
      timezone: "Asia/Jakarta",
      timestamp: new Date().toISOString(),
    };

    setLatestClientLocation(mockLoc);

    const result = (await get_device_location.execute!(
      { highAccuracy: true, includeAddress: true },
      { messages: [], toolCallId: "call-1", context: {} as never }
    )) as typeof mockLoc;

    expect(result.success).toBe(true);
    expect(result.source).toBe("device_gps");
    expect(result.coordinates.latitude).toBe(-6.2088);
    expect(result.address?.city).toBe("Jakarta");
    expect(result.timezone).toBe("Asia/Jakarta");
  });
});
