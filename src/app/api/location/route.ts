import { NextResponse } from "next/server";
import { syslog } from "@/lib/observability/log-store";

import { z } from "zod";
import {
  resolveLocation,
  searchLocation,
  setChatDeviceLocation,
  setLatestClientLocation,
  getChatDeviceLocation,
} from "@/lib/location/geocoding";

const LocationPostSchema = z.object({
  query: z.string().max(200).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracy: z.number().min(0).optional(),
  altitude: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
  timezone: z.string().max(100).optional(),
  locale: z.string().max(30).optional(),
  chatId: z.string().max(100).optional(),
  manual: z.boolean().optional(),
});

function getClientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return null;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    syslog("debug", "route", `Error: ${err instanceof Error ? err.message : String(err)}`);
    body = {};
  }

  const parsed = LocationPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid location parameters", details: parsed.error.format() },
      { status: 400 }
    );
  }

  if (parsed.data.query) {
    const found = await searchLocation(parsed.data.query);
    if (!found) {
      return NextResponse.json(
        { error: `Location not found for "${parsed.data.query}"` },
        { status: 404 }
      );
    }
    if (parsed.data.chatId) {
      setChatDeviceLocation(parsed.data.chatId, found);
    }
    setLatestClientLocation(found);
    return NextResponse.json(found);
  }

  const {
    latitude,
    longitude,
    accuracy,
    altitude,
    heading,
    speed,
    timezone,
    locale,
    chatId,
    manual,
  } = parsed.data;

  const clientCoordinates =
    typeof latitude === "number" && typeof longitude === "number"
      ? {
          latitude,
          longitude,
          accuracyMeters: accuracy,
          altitudeMeters: altitude,
          headingDegrees: heading,
          speedMps: speed,
        }
      : null;

  const clientIp = getClientIp(req);
  const resolved = await resolveLocation({
    clientCoordinates,
    clientTimezone: timezone,
    clientLocale: locale,
    clientIp,
    includeAddress: true,
  });

  if (manual) {
    resolved.source = "manual_override";
  }

  if (chatId) {
    setChatDeviceLocation(chatId, resolved);
  }
  setLatestClientLocation(resolved);

  return NextResponse.json(resolved);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chatId = url.searchParams.get("chatId");

  if (chatId) {
    const cached = getChatDeviceLocation(chatId);
    if (cached) {
      return NextResponse.json(cached);
    }
  }

  const clientIp = getClientIp(req);
  const resolved = await resolveLocation({
    clientIp,
    includeAddress: true,
  });

  return NextResponse.json(resolved);
}
