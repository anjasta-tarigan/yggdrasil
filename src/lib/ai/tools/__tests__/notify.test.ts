// src/lib/ai/tools/__tests__/notify.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { notify_user, resetNotificationRateLimit } from "../notify";

describe("notify_user Tool", () => {
  beforeEach(() => {
    resetNotificationRateLimit();
  });

  it("successfully accepts and delivers valid notifications", async () => {
    const res = (await notify_user.execute!(
      { title: "Task Done", message: "Build completed successfully", level: "success", sound: true },
      {} as never
    )) as { delivered: boolean; title?: string };

    expect(res.delivered).toBe(true);
    expect(res.title).toBe("Task Done");
  });

  it("suppresses duplicate notifications within 10 seconds", async () => {
    const res1 = (await notify_user.execute!(
      { title: "Alert", message: "Notice", level: "info", sound: false },
      {} as never
    )) as { delivered: boolean };
    expect(res1.delivered).toBe(true);

    const res2 = (await notify_user.execute!(
      { title: "Alert", message: "Notice", level: "info", sound: false },
      {} as never
    )) as { delivered: boolean; reason?: string };
    expect(res2.delivered).toBe(false);
    expect(res2.reason).toContain("Duplicate suppressed");
  });

  it("enforces rate limit of maximum 5 notifications per 60 seconds", async () => {
    for (let i = 0; i < 5; i++) {
      const res = (await notify_user.execute!(
        { title: `Notice ${i}`, message: `Content ${i}`, level: "info", sound: false },
        {} as never
      )) as { delivered: boolean };
      expect(res.delivered).toBe(true);
    }

    const res6 = (await notify_user.execute!(
      { title: "Notice 6", message: "Content 6", level: "info", sound: false },
      {} as never
    )) as { delivered: boolean; reason?: string };
    expect(res6.delivered).toBe(false);
    expect(res6.reason).toContain("Rate limit exceeded");
  });
});
