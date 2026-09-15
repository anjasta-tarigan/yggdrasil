import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET } from "../route";

vi.mock("@/lib/security/ssrf", () => ({
  secureFetch: vi.fn(),
}));

import { secureFetch } from "@/lib/security/ssrf";
const mockSecureFetch = vi.mocked(secureFetch);

describe("/api/location API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST resolves location when coordinates are posted", async () => {
    mockSecureFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        display_name: "Sydney NSW, Australia",
        address: {
          city: "Sydney",
          state: "New South Wales",
          country: "Australia",
        },
      }),
    } as unknown as Response);

    const req = new Request("http://localhost/api/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: -33.8688,
        longitude: 151.2093,
        accuracy: 15,
        timezone: "Australia/Sydney",
        chatId: "chat-syd",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.source).toBe("device_gps");
    expect(data.coordinates.latitude).toBe(-33.8688);
    expect(data.coordinates.longitude).toBe(151.2093);
    expect(data.address.city).toBe("Sydney");
    expect(data.timezone).toBe("Australia/Sydney");
  });

  it("POST rejects invalid coordinate range", async () => {
    const req = new Request("http://localhost/api/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: 100, // invalid > 90
        longitude: 200, // invalid > 180
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("GET retrieves cached chat location if chatId provided", async () => {
    const req = new Request("http://localhost/api/location?chatId=chat-syd", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("device_gps");
    expect(data.coordinates.latitude).toBe(-33.8688);
  });

  it("POST resolves query and sets manual location", async () => {
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

    const req = new Request("http://localhost/api/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "Banyuning, Bali",
        chatId: "chat-bali",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("manual_override");
    expect(data.address.city).toBe("Buleleng");
    expect(data.address.neighbourhood).toBe("Banyuning");
    expect(data.timezone).toBe("Asia/Makassar");
  });
});
