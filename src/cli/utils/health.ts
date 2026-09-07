export async function waitForHealth(url: string, timeoutMs = 30000, pollIntervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body?.status === "ok") {
          return true;
        }
      }
    } catch {
      // In-flight connection failure, retry
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

export async function waitForProcessExit(pid: number, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // Throws if process doesn't exist
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return true; // Process exited
    }
  }
  return false;
}
