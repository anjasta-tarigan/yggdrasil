import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Safely extracts an `error` string from a failed Response's JSON body.
 * DRYs up the repeated `res.json().catch(() => ({}))` pattern across
 * project components and prevents silent swallowing of parse failures.
 */
export async function parseErrorResponse(
  res: Response,
  fallback: string = "Request failed"
): Promise<string> {
  try {
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (typeof data?.error === "string" && data.error.trim()) {
      return data.error;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
