"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Coordinates, ResolvedAddress, ResolvedLocation } from "@/lib/location/geocoding";

export interface DeviceLocationState {
  enabled: boolean;
  mode: "gps" | "manual";
  status: "idle" | "requesting" | "granted" | "denied" | "unavailable";
  coordinates: Coordinates | null;
  address: ResolvedAddress | null;
  timezone: string;
  source: ResolvedLocation["source"] | null;
  error: string | null;
}

const STORAGE_KEY_ENABLED = "yggdrasil:device-location-enabled";
const STORAGE_KEY_MODE = "yggdrasil:device-location-mode";
const STORAGE_KEY_CUSTOM = "yggdrasil:custom-device-location";

function safeLocalStorageGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch (err) {
    console.warn(`[useDeviceLocation] Failed to read ${key} from localStorage:`, err);
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[useDeviceLocation] Failed to write ${key} to localStorage:`, err);
  }
}

function safeLocalStorageRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch (err) {
    console.warn(`[useDeviceLocation] Failed to remove ${key} from localStorage:`, err);
  }
}

export function useDeviceLocation(chatId?: string) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    return safeLocalStorageGet(STORAGE_KEY_ENABLED) === "true";
  });

  const [mode, setModeState] = useState<"gps" | "manual">(() => {
    const saved = safeLocalStorageGet(STORAGE_KEY_MODE);
    return saved === "manual" ? "manual" : "gps";
  });

  const [customLocation, setCustomLocation] = useState<ResolvedLocation | null>(() => {
    const saved = safeLocalStorageGet(STORAGE_KEY_CUSTOM);
    if (!saved) return null;
    try {
      return JSON.parse(saved) as ResolvedLocation;
    } catch (err) {
      console.warn("[useDeviceLocation] Failed to parse custom location JSON:", err);
      return null;
    }
  });

  const [status, setStatus] = useState<DeviceLocationState["status"]>("idle");
  const [coordinates, setCoordinates] = useState<Coordinates | null>(
    () => customLocation?.coordinates ?? null
  );
  const [address, setAddress] = useState<ResolvedAddress | null>(
    () => customLocation?.address ?? null
  );
  const [source, setSource] = useState<ResolvedLocation["source"] | null>(
    () => customLocation?.source ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const requestingRef = useRef(false);

  const timezone =
    customLocation?.timezone ||
    (typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      : "UTC");

  const refreshLocation = useCallback(
    async (silent = false) => {
      // If manual mode is active and we have customLocation, ensure server is primed
      if (mode === "manual" && customLocation) {
        setCoordinates(customLocation.coordinates);
        setAddress(customLocation.address ?? null);
        setSource("manual_override");
        setStatus("granted");
        setError(null);

        try {
          await fetch("/api/location", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              latitude: customLocation.coordinates.latitude,
              longitude: customLocation.coordinates.longitude,
              accuracy: customLocation.coordinates.accuracyMeters,
              timezone: customLocation.timezone,
              chatId,
              manual: true,
            }),
          });
        } catch (err) {
          console.warn("[useDeviceLocation] Failed to sync manual location:", err);
        }
        return;
      }

      if (typeof navigator === "undefined" || !navigator.geolocation) {
        setStatus("unavailable");
        if (!silent) setError("Geolocation is not supported by this browser/device.");
        return;
      }

      if (requestingRef.current) return;
      requestingRef.current = true;
      setStatus("requesting");
      setError(null);

      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0, // Force fresh hardware reading, no cached ISP gateway
          });
        });

        const coords: Coordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          altitudeMeters: position.coords.altitude,
          headingDegrees: position.coords.heading,
          speedMps: position.coords.speed,
        };

        setCoordinates(coords);
        setSource("device_gps");
        setStatus("granted");

        // Prime the server-side cache and resolve address components
        try {
          const res = await fetch("/api/location", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              latitude: coords.latitude,
              longitude: coords.longitude,
              accuracy: coords.accuracyMeters,
              altitude: coords.altitudeMeters,
              heading: coords.headingDegrees,
              speed: coords.speedMps,
              timezone,
              chatId,
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as ResolvedLocation;
            if (data.address) {
              setAddress(data.address);
            }
          }
        } catch (err) {
          // Network or server geocoding offline, coordinates are still valid
          console.warn("[useDeviceLocation] Geocoding prime failed:", err);
        }
      } catch (err) {
        const geoErr = err as GeolocationPositionError;
        if (geoErr.code === geoErr.PERMISSION_DENIED) {
          setStatus("denied");
          if (!silent) setError("Location permission denied. Enable location in browser settings or set a manual location below.");
        } else if (geoErr.code === geoErr.TIMEOUT) {
          setStatus("unavailable");
          if (!silent) setError("Location request timed out. You can set a manual location below.");
        } else {
          setStatus("unavailable");
          if (!silent) setError(geoErr.message || "Failed to retrieve device location.");
        }
      } finally {
        requestingRef.current = false;
      }
    },
    [chatId, customLocation, mode, timezone]
  );

  // Auto-fetch if enabled on mount
  useEffect(() => {
    if (!enabled) return;

    if (mode === "manual" && customLocation) {
      void refreshLocation(true);
      return;
    }

    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "geolocation" as PermissionName })
        .then((perm) => {
          if (perm.state === "granted") {
            void refreshLocation(true);
          } else if (perm.state === "denied") {
            setStatus("denied");
          }
        })
        .catch(() => {
          void refreshLocation(true);
        });
    } else {
      void refreshLocation(true);
    }
  }, [enabled, mode, customLocation, refreshLocation]);

  const toggleLocation = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      safeLocalStorageSet(STORAGE_KEY_ENABLED, String(next));
      if (next && !coordinates) {
        void refreshLocation(false);
      }
      return next;
    });
  }, [coordinates, refreshLocation]);

  const setMode = useCallback(
    (newMode: "gps" | "manual") => {
      setModeState(newMode);
      safeLocalStorageSet(STORAGE_KEY_MODE, newMode);

      if (newMode === "manual" && customLocation) {
        setCoordinates(customLocation.coordinates);
        setAddress(customLocation.address ?? null);
        setSource("manual_override");
        setStatus("granted");
      } else if (newMode === "gps") {
        void refreshLocation(false);
      }
    },
    [customLocation, refreshLocation]
  );

  const setManualLocation = useCallback(
    async (query: string): Promise<boolean> => {
      setError(null);
      try {
        const res = await fetch("/api/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, chatId }),
        });

        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          setError(errData.error || `Could not find location for "${query}"`);
          return false;
        }

        const data = (await res.json()) as ResolvedLocation;
        setCustomLocation(data);
        setCoordinates(data.coordinates);
        setAddress(data.address ?? null);
        setSource("manual_override");
        setStatus("granted");
        setModeState("manual");

        safeLocalStorageSet(STORAGE_KEY_CUSTOM, JSON.stringify(data));
        safeLocalStorageSet(STORAGE_KEY_MODE, "manual");
        safeLocalStorageSet(STORAGE_KEY_ENABLED, "true");

        setEnabled(true);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to search location");
        return false;
      }
    },
    [chatId]
  );

  const clearManualLocation = useCallback(() => {
    setCustomLocation(null);
    setModeState("gps");
    safeLocalStorageRemove(STORAGE_KEY_CUSTOM);
    safeLocalStorageSet(STORAGE_KEY_MODE, "gps");
    void refreshLocation(false);
  }, [refreshLocation]);

  return {
    enabled,
    mode,
    status,
    coordinates,
    address,
    timezone,
    source,
    error,
    refreshLocation,
    toggleLocation,
    setMode,
    setManualLocation,
    clearManualLocation,
  };
}
