import { describe, it, expect } from "vitest";
import { evaluateMessageQuality } from "@/lib/ai/pipeline/quality-scanner";

describe("Internal Quality & Anti-Slop Scanner — Indonesian Language", () => {
  it("evaluates clean factual Indonesian prose as clean with high signal", () => {
    const text = `Untuk mengonfigurasi SQLite dalam mode WAL pada Node.js dengan better-sqlite3:

1. Buka koneksi database Anda secara sinkron.
2. Jalankan perintah PRAGMA journal_mode = WAL segera setelah inisialisasi.
3. Ini memastikan operasi pembacaan konkuren tidak memblokir penulisan yang sedang berjalan.
4. Selalu pastikan foreign keys aktif dengan PRAGMA foreign_keys = ON.
5. Atur busy_timeout ke nilai 5000 untuk menangani antrean saat terjadi banyak transaksi bersamaan.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.tier).toBe("clean");
    expect(report.score).toBeLessThanOrEqual(15);
    expect(report.flaggedPatterns.length).toBe(0);
  });

  it("detects Indonesian Tier 1 AI slop words and buzzwords", () => {
    const text = `Dalam arsitektur perangkat lunak ini, kita harus menyelami secara mendalam berbagai rajutan konsep yang berdiri sebagai bukti nyata dari fondasi utama rekayasa kita. Dengan demikian, kita memupuk pertumbuhan dan melepaskan kekuatan sinergi untuk menavigasi kompleksitas sistem modern di era sekarang.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(30);
    expect(report.flaggedPatterns).toContain("menyelami");
    expect(report.flaggedPatterns).toContain("rajutan");
  });

  it("detects Indonesian structural clichés and sycophantic openers", () => {
    const text = `Pertanyaan yang sangat bagus! Tentu, dengan senang hati membantu Anda memahami hal ini. Ini bukan hanya sebuah sistem database, melainkan sebuah terobosan untuk skalabilitas aplikasi Anda. Di era yang serba cepat ini, penting untuk diingat bahwa efisiensi adalah kuncinya.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.flaggedPatterns).toContain("sycophantic opener (pertanyaan yang bagus)");
    expect(report.flaggedPatterns).toContain("kontras teatrikal (bukan hanya X, tapi Y)");
    expect(report.flaggedPatterns).toContain("di era yang serba cepat");
    expect(report.flaggedPatterns).toContain("throat-clearing hedge (penting untuk dicatat bahwa)");
  });

  it("detects Indonesian buzzword collocations", () => {
    const text = `Kami menyediakan solusi yang komprehensif dengan pendekatan yang holistik serta integrasi yang mulus untuk mendukung transformasi digital bisnis Anda. Seluruh strategi dirancang secara terarah untuk memberikan hasil yang bermakna dan peningkatan berkelanjutan bagi seluruh ekosistem organisasi Anda setiap saat.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.flaggedPatterns).toContain("solusi komprehensif");
    expect(report.flaggedPatterns).toContain("pendekatan holistik");
    expect(report.flaggedPatterns).toContain("integrasi mulus");
  });
});
