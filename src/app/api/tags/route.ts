import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveTagOverride } from "@/lib/tags-store";

export const dynamic = "force-dynamic";

const Body = z.object({
  key: z.string().min(1),
  tags: z.object({
    valueProp: z.string().optional(),
    message: z.string().optional(),
    hook: z.string().optional(),
    visualTreatment: z.string().optional(),
    format: z.enum(["video", "static", "carousel", "unknown"]).optional(),
    creator: z.string().optional(),
    campaign: z.string().optional(),
  }),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.parse(await req.json());
    const saved = saveTagOverride(parsed.key, parsed.tags);
    return NextResponse.json({ ok: true, tags: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
