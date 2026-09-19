import { describe, it, expect } from "vitest";
import {
  cpuFallbackLadder,
  isExcludedVariant,
  pickBestVariant,
  rankOnnxVariants,
  variantRank,
} from "../variant-ladder";

describe("variant-ladder", () => {
  describe("rankOnnxVariants", () => {
    it("orders the standard model_* ladder best-first, with q4/bnb4 last", () => {
      // Spec §4.1: the auto-pick ladder is int8|quantized → uint8 → fp32;
      // q4/q4f16/bnb4 are excluded from auto-pick (advanced override only) and
      // sort after fp32 so they can never outrank a smaller int8/fp32 graph.
      expect(
        rankOnnxVariants([
          "onnx/model.onnx",
          "onnx/model_uint8.onnx",
          "onnx/model_q4.onnx",
          "onnx/model_bnb4.onnx",
          "onnx/model_quantized.onnx",
          "onnx/model_int8.onnx",
        ]),
      ).toEqual([
        "onnx/model_int8.onnx",
        "onnx/model_quantized.onnx",
        "onnx/model_uint8.onnx",
        "onnx/model.onnx",
        "onnx/model_bnb4.onnx",
        "onnx/model_q4.onnx",
      ]);
    });

    it("ranks prefixed variant names by suffix, not exact filename", () => {
      // Regression: jinaai/jina-clip-v1 names graphs `text_model_int8.onnx`.
      // Exact-filename matching missed these and fell back to alphabetical
      // order, choosing bnb4 (397 MB) over int8 (118 MB).
      const ranked = rankOnnxVariants([
        "onnx/text_model.onnx",
        "onnx/text_model_bnb4.onnx",
        "onnx/text_model_q4.onnx",
        "onnx/text_model_quantized.onnx",
        "onnx/text_model_int8.onnx",
        "onnx/text_model_uint8.onnx",
      ]);
      expect(ranked[0]).toBe("onnx/text_model_int8.onnx");
      expect(ranked[1]).toBe("onnx/text_model_quantized.onnx");
      // fp32 outranks the auto-pick-excluded q4/bnb4 classes.
      expect(ranked.indexOf("onnx/text_model.onnx")).toBeLessThan(
        ranked.indexOf("onnx/text_model_q4.onnx"),
      );
    });

    it("drops fp16 graphs entirely (native CPU abort)", () => {
      const ranked = rankOnnxVariants([
        "onnx/model_fp16.onnx",
        "onnx/model_int8.onnx",
      ]);
      expect(ranked).toEqual(["onnx/model_int8.onnx"]);
      expect(ranked.some((p) => p.includes("fp16"))).toBe(false);
    });

    it("drops Optimum `_O4` graphs, which are fp16", () => {
      // Verified by parsing initializer dtypes: `_O1`/`_O2`/`_O3` are FLOAT,
      // `_O4` is FLOAT16 (exactly half the size). It was reachable by accident
      // because `localeCompare` ignores punctuation, so `model_O4.onnx` sorted
      // ahead of `model.onnx`.
      const ranked = rankOnnxVariants([
        "onnx/model.onnx",
        "onnx/model_O1.onnx",
        "onnx/model_O2.onnx",
        "onnx/model_O3.onnx",
        "onnx/model_O4.onnx",
      ]);
      expect(ranked.some((p) => p.endsWith("_O4.onnx"))).toBe(false);
      expect(ranked).toHaveLength(4);
    });

    it("ranks Optimum ISA-suffixed int8 graphs as the int8 class", () => {
      // `sentence-transformers/*` and `intfloat/*` export int8 as
      // `model_qint8_avx512_vnni.onnx` / `model_quint8_avx2.onnx`. Unrecognized,
      // these fell through to the fp32 rank and the 470 MB `model.onnx` was
      // advertised while a 118 MB int8 graph sat unused.
      const ranked = rankOnnxVariants([
        "onnx/model.onnx",
        "onnx/model_O1.onnx",
        "onnx/model_O2.onnx",
        "onnx/model_O3.onnx",
        "onnx/model_O4.onnx",
        "onnx/model_qint8_arm64.onnx",
        "onnx/model_qint8_avx512.onnx",
        "onnx/model_qint8_avx512_vnni.onnx",
        "onnx/model_quint8_avx2.onnx",
      ]);
      expect(ranked[0]).toBe("onnx/model_quint8_avx2.onnx");
      for (const p of ranked.slice(0, 4)) {
        expect(variantRank(p)).toBeLessThan(variantRank("onnx/model.onnx"));
      }
    });

    it("prefers a quantized graph over an fp16 _O4 in the same repo", () => {
      // Regression: intfloat/multilingual-e5-small ships exactly these three
      // and the ladder used to pick the 235 MB fp16 `_O4` over the 118 MB int8.
      const ranked = rankOnnxVariants([
        "onnx/model.onnx",
        "onnx/model_O4.onnx",
        "onnx/model_qint8_avx512_vnni.onnx",
      ]);
      expect(ranked[0]).toBe("onnx/model_qint8_avx512_vnni.onnx");
    });

    it("prefers the generic int8 name over ISA-tuned variants", () => {
      // Portability preference: `_int8` is the transformers.js name and carries
      // no ISA assumption, so it wins over the Optimum x86/arm64 exports.
      const ranked = rankOnnxVariants([
        "onnx/model_quint8_avx2.onnx",
        "onnx/model_qint8_arm64.onnx",
        "onnx/model_int8.onnx",
      ]);
      expect(ranked[0]).toBe("onnx/model_int8.onnx");
    });

    it("prefers the x86 AVX2 export over the arm64 one", () => {
      // The tie-break is `localeCompare`, which would otherwise prefer
      // `_qint8_arm64` on an x86 host.
      const ranked = rankOnnxVariants([
        "onnx/model_qint8_arm64.onnx",
        "onnx/model_quint8_avx2.onnx",
      ]);
      expect(ranked[0]).toBe("onnx/model_quint8_avx2.onnx");
    });

    it("prefers the text tower over the vision tower for multi-graph repos", () => {
      const ranked = rankOnnxVariants([
        "onnx/vision_model_int8.onnx",
        "onnx/text_model_int8.onnx",
      ]);
      expect(ranked[0]).toBe("onnx/text_model_int8.onnx");
    });

    it("keeps unknown quantization classes rather than dropping them", () => {
      const ranked = rankOnnxVariants([
        "onnx/model_int8.onnx",
        "onnx/model_exotic.onnx",
      ]);
      expect(ranked).toEqual(["onnx/model_int8.onnx", "onnx/model_exotic.onnx"]);
    });

    it("ignores non-ONNX files and empty input", () => {
      expect(rankOnnxVariants(["tokenizer.json", "config.json"])).toEqual([]);
      expect(rankOnnxVariants([])).toEqual([]);
    });

    it("is deterministic across equal ranks", () => {
      const a = rankOnnxVariants(["onnx/b_int8.onnx", "onnx/a_int8.onnx"]);
      const b = rankOnnxVariants(["onnx/a_int8.onnx", "onnx/b_int8.onnx"]);
      expect(a).toEqual(b);
      expect(a).toEqual(["onnx/a_int8.onnx", "onnx/b_int8.onnx"]);
    });
  });

  describe("variantRank", () => {
    it("ranks quantized classes ahead of fp32", () => {
      expect(variantRank("onnx/model_int8.onnx")).toBeLessThan(
        variantRank("onnx/model.onnx"),
      );
    });

    it("ranks int8 ahead of bnb4", () => {
      expect(variantRank("onnx/model_int8.onnx")).toBeLessThan(
        variantRank("onnx/model_bnb4.onnx"),
      );
    });

    it("ranks fp32 ahead of auto-pick-excluded q4/bnb4 classes", () => {
      // Auto-pick-excluded classes sort *after* fp32 so the ladder never
      // prefers a larger q4/bnb4 graph (spec §4.1).
      expect(variantRank("onnx/model.onnx")).toBeLessThan(
        variantRank("onnx/model_q4.onnx"),
      );
      expect(variantRank("onnx/model.onnx")).toBeLessThan(
        variantRank("onnx/model_bnb4.onnx"),
      );
      expect(variantRank("onnx/model.onnx")).toBeLessThan(
        variantRank("onnx/model_q4f16.onnx"),
      );
    });
  });

  describe("isExcludedVariant", () => {
    it("flags fp16 graphs including prefixed names", () => {
      expect(isExcludedVariant("onnx/model_fp16.onnx")).toBe(true);
      expect(isExcludedVariant("onnx/text_model_fp16.onnx")).toBe(true);
      expect(isExcludedVariant("onnx/model_int8.onnx")).toBe(false);
      expect(isExcludedVariant("onnx/model.onnx")).toBe(false);
      expect(isExcludedVariant("tokenizer.json")).toBe(false);
    });

    it("flags the fp16 `_O4` export but keeps `_O1`/`_O2`/`_O3`", () => {
      expect(isExcludedVariant("onnx/model_O4.onnx")).toBe(true);
      expect(isExcludedVariant("onnx/model_O1.onnx")).toBe(false);
      expect(isExcludedVariant("onnx/model_O2.onnx")).toBe(false);
      expect(isExcludedVariant("onnx/model_O3.onnx")).toBe(false);
    });

    it("does not treat a variant merely containing fp16 or _O4 as excluded", () => {
      expect(isExcludedVariant("onnx/model_fp16_backup.onnx")).toBe(false);
      expect(isExcludedVariant("onnx/model_O40.onnx")).toBe(false);
      expect(isExcludedVariant("onnx/model_O4_quantized.onnx")).toBe(false);
    });
  });

  describe("pickBestVariant", () => {
    it("returns the single best variant", () => {
      expect(
        pickBestVariant(["onnx/model.onnx", "onnx/model_int8.onnx"]),
      ).toBe("onnx/model_int8.onnx");
    });

    it("returns undefined when nothing is usable", () => {
      expect(pickBestVariant(["onnx/model_fp16.onnx"])).toBeUndefined();
      expect(pickBestVariant([])).toBeUndefined();
    });

    it("never auto-picks q4/bnb4 even when they are the only graphs", () => {
      // Spec §4.1: q4/q4f16/bnb4 are advanced-override only.
      expect(pickBestVariant(["onnx/model_q4.onnx"])).toBeUndefined();
      expect(pickBestVariant(["onnx/model_bnb4.onnx"])).toBeUndefined();
      expect(pickBestVariant(["onnx/model_q4f16.onnx"])).toBeUndefined();
    });

    it("prefers a smaller int8 over a q4 sibling", () => {
      expect(
        pickBestVariant(["onnx/model_q4.onnx", "onnx/model_int8.onnx"]),
      ).toBe("onnx/model_int8.onnx");
    });
  });

  describe("cpuFallbackLadder", () => {
    it("returns at most the three canonical rungs (int8 → uint8 → fp32)", () => {
      const ladder = cpuFallbackLadder([
        { path: "onnx/model_int8.onnx" },
        { path: "onnx/model_uint8.onnx" },
        { path: "onnx/model.onnx" },
        { path: "onnx/model_q4.onnx" },
        { path: "onnx/model_bnb4.onnx" },
      ]);
      expect(ladder).toEqual([
        "onnx/model_int8.onnx",
        "onnx/model_uint8.onnx",
        "onnx/model.onnx",
      ]);
    });

    it("always includes fp32 as the final rung when present", () => {
      const ladder = cpuFallbackLadder([
        { path: "onnx/model_int8.onnx" },
        { path: "onnx/model.onnx" },
      ]);
      expect(ladder.at(-1)).toBe("onnx/model.onnx");
    });

    it("skips absent rungs and never includes q4/bnb4/fp16", () => {
      const ladder = cpuFallbackLadder([
        { path: "onnx/model_uint8.onnx" },
        { path: "onnx/model_q4.onnx" },
        { path: "onnx/model_fp16.onnx" },
      ]);
      expect(ladder).toEqual(["onnx/model_uint8.onnx"]);
    });
  });
});
