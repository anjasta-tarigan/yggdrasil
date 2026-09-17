import type { TopicDriftReport } from "./topic-drift-detector";

export async function detectTopicDrift(
  text: string,
  options?: { threshold?: number; signal?: AbortSignal }
): Promise<TopicDriftReport | null> {
  if (options?.signal?.aborted) return null;
  try {
    const res = await fetch("/api/chat/topic-drift", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, threshold: options?.threshold }),
      signal: options?.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { report: TopicDriftReport | null };
    return data.report ?? null;
  } catch (err: unknown) {
    if (options?.signal?.aborted) return null;
    return null;
  }
}
