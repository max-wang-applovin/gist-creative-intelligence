import { NextRequest, NextResponse } from "next/server";
import { getPerformance } from "@/lib/performance";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const since = searchParams.get("since") || undefined;
    const until = searchParams.get("until") || undefined;
    const top = searchParams.get("top")
      ? Number(searchParams.get("top"))
      : undefined;
    const data = await getPerformance({ since, until, top });
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
