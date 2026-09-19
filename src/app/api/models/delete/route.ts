import { NextResponse } from "next/server";
import { syslog } from "@/lib/observability/log-store";

import { z } from "zod";
import { deleteModel } from "@/lib/models/store";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { releaseReranker, type RerankerDbSetting } from "@/lib/memory/reranker";
import { releaseOnnxSession } from "@/lib/memory/onnx-session";

const DeleteModelSchema = z.object({
  kind: z.enum(["embedding", "reranker"]),
  model: z.string().trim().min(1).max(256),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = DeleteModelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { kind, model } = parsed.data;

  try {
    const result = deleteModel(kind, model);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error ?? "Model not found" },
        { status: 404 }
      );
    }

    // If reranker was using this model, update database settings so it doesn't point to a ghost file
    if (kind === "reranker") {
      try {
        void releaseReranker();
        const currentSetting = getSettingDb("reranker") as RerankerDbSetting | undefined;
        if (
          currentSetting?.selectedModel &&
          (currentSetting.selectedModel === model ||
            model.includes(currentSetting.selectedModel) ||
            currentSetting.selectedModel.includes(model))
        ) {
          setSettingsDb({
            reranker: {
              ...currentSetting,
              selectedModel: undefined,
            },
          });
        }
      } catch (err) {
        syslog("debug", "route", `Error: ${err instanceof Error ? err.message : String(err)}`);
        // non-fatal
      }
    } else if (kind === "embedding") {
      try {
        void releaseOnnxSession("embedding");
      } catch (err) {
        syslog("debug", "route", `Error: ${err instanceof Error ? err.message : String(err)}`);
        // non-fatal
      }
    }

    return NextResponse.json({
      success: true,
      freedBytes: result.freedBytes ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
