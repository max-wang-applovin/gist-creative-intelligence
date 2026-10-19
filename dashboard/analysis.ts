import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MetaAdMedia } from "../bot/lib/meta-media.js";

export type CreativeForAnalysis = {
  creativeId: string;
  creativeName: string;
  metaCreativeNames: string[];
  metaSpend: number;
  metaImpressions: number;
  metaClicks: number;
  metaCtr: number;
  metaCpc: number;
  metaCpm: number;
  adjustInstalls: number;
  cvr: number;
  cpi: number;
  adjustRetentionD1: number;
  adjustRetentionD7: number;
  media: MetaAdMedia[];
};

export type CreativeAnalysis = {
  schemaVersion: 2;
  creativeId: string;
  fingerprint: string;
  scannedAt: string;
  model: string;
  taxonomy: {
    theme: string;
    angle: string;
    format: string;
    presenter: string;
    awareness: string;
    mediaType: string;
    hookType: string;
    feeling: string;
  };
  productOnScreen: boolean;
  hasStrongHook: boolean;
  colorTheory: {
    primaryColors: string[];
    paletteTemperature: string;
    saturation: string;
    contrast: string;
    brightness: string;
    harmony: string;
    attentionColor: string;
    colorStrategy: string;
    brandColorUse: string;
    textLegibility: string;
  };
  composition: {
    focalPoint: string;
    subjectPlacement: string;
    visualHierarchy: string;
    productProminence: string;
    textDensity: string;
  };
  opening: string;
  cta: string;
  summary: string;
  strengths: string[];
  risks: string[];
  confidence: number;
};

type AnalysisStoreFile = {
  version: 1;
  records: Record<string, CreativeAnalysis>;
};

const taxonomy = {
  theme: [
    "earning rewards",
    "curated discovery",
    "self-expression",
    "creator opportunity",
    "local community",
    "product education",
    "other",
  ],
  angle: [
    "problem solved",
    "benefit-led",
    "how-to",
    "social proof",
    "curiosity",
    "aspiration",
    "offer",
    "other",
  ],
  format: [
    "ugc single",
    "mashup",
    "educational",
    "static",
    "social interface",
    "founder",
    "other",
  ],
  presenter: [
    "creator ugc",
    "founder",
    "no presenter",
    "product demo",
    "other",
  ],
  awareness: [
    "unaware",
    "problem aware",
    "solution aware",
    "product aware",
    "most aware",
  ],
  mediaType: ["video", "image", "mixed", "unknown"],
  hookType: [
    "visual surprise",
    "bold claim",
    "question",
    "problem statement",
    "offer",
    "social proof",
    "story",
    "none",
  ],
  feeling: [
    "hope",
    "curiosity",
    "urgency",
    "trust",
    "aspiration",
    "fear",
    "other",
  ],
} as const;

const analysisSchemaVersion = 2 as const;

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "taxonomy",
    "productOnScreen",
    "hasStrongHook",
    "colorTheory",
    "composition",
    "opening",
    "cta",
    "summary",
    "strengths",
    "risks",
    "confidence",
  ],
  properties: {
    taxonomy: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(taxonomy),
      properties: Object.fromEntries(
        Object.entries(taxonomy).map(([key, values]) => [
          key,
          { type: "string", enum: values },
        ]),
      ),
    },
    productOnScreen: { type: "boolean" },
    hasStrongHook: { type: "boolean" },
    colorTheory: {
      type: "object",
      additionalProperties: false,
      required: [
        "primaryColors",
        "paletteTemperature",
        "saturation",
        "contrast",
        "brightness",
        "harmony",
        "attentionColor",
        "colorStrategy",
        "brandColorUse",
        "textLegibility",
      ],
      properties: {
        primaryColors: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", maxLength: 30 },
        },
        paletteTemperature: {
          type: "string",
          enum: ["warm", "cool", "neutral", "mixed"],
        },
        saturation: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
        contrast: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
        brightness: {
          type: "string",
          enum: ["dark", "balanced", "bright"],
        },
        harmony: {
          type: "string",
          enum: [
            "complementary",
            "analogous",
            "monochromatic",
            "triadic",
            "neutral",
            "mixed",
          ],
        },
        attentionColor: { type: "string", maxLength: 80 },
        colorStrategy: { type: "string", maxLength: 220 },
        brandColorUse: { type: "string", maxLength: 160 },
        textLegibility: {
          type: "string",
          enum: ["strong", "mixed", "weak", "no text visible"],
        },
      },
    },
    composition: {
      type: "object",
      additionalProperties: false,
      required: [
        "focalPoint",
        "subjectPlacement",
        "visualHierarchy",
        "productProminence",
        "textDensity",
      ],
      properties: {
        focalPoint: { type: "string", maxLength: 120 },
        subjectPlacement: {
          type: "string",
          enum: ["center", "rule of thirds", "split screen", "full frame", "other"],
        },
        visualHierarchy: { type: "string", maxLength: 220 },
        productProminence: {
          type: "string",
          enum: ["none", "low", "medium", "high"],
        },
        textDensity: {
          type: "string",
          enum: ["none", "light", "medium", "heavy"],
        },
      },
    },
    opening: { type: "string", maxLength: 160 },
    cta: { type: "string", maxLength: 100 },
    summary: { type: "string", maxLength: 300 },
    strengths: {
      type: "array",
      maxItems: 3,
      items: { type: "string", maxLength: 160 },
    },
    risks: {
      type: "array",
      maxItems: 3,
      items: { type: "string", maxLength: 160 },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export function creativeFingerprint(creative: CreativeForAnalysis): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        analysisSchemaVersion,
        creativeName: creative.creativeName,
        metaCreativeNames: creative.metaCreativeNames,
        media: creative.media.map((item) => ({
          adId: item.adId,
          creativeId: item.creativeId,
          primaryText: item.primaryText,
          headline: item.headline,
          description: item.description,
        })),
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

export class CreativeAnalysisStore {
  private loaded = false;
  private records = new Map<string, CreativeAnalysis>();
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as
        | AnalysisStoreFile
        | undefined;
      for (const [key, record] of Object.entries(parsed?.records ?? {})) {
        this.records.set(key, record);
      }
    } catch {
      // First run or a stale cache starts empty.
    }
  }

  async list(): Promise<CreativeAnalysis[]> {
    await this.load();
    return [...this.records.values()];
  }

  async get(creativeId: string): Promise<CreativeAnalysis | undefined> {
    await this.load();
    return this.records.get(creativeId);
  }

  async put(record: CreativeAnalysis): Promise<void> {
    await this.load();
    this.records.set(record.creativeId, record);
    this.saveQueue = this.saveQueue.then(() => this.persist());
    await this.saveQueue;
  }

  private async persist(): Promise<void> {
    const value: AnalysisStoreFile = {
      version: 1,
      records: Object.fromEntries(this.records),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }
}

function analysisPrompt(creative: CreativeForAnalysis): string {
  const media = creative.media.slice(0, 3);
  return [
    "Analyze this paid social creative group for a growth marketing team.",
    "Classify what is visibly present. Do not invent dialogue, claims, or frames not shown.",
    "Analyze color theory deeply: palette, temperature, saturation, contrast, brightness, harmony, attention color, brand-color use, text legibility, and how color directs visual hierarchy.",
    "Analyze composition from the supplied thumbnails. A thumbnail cannot prove editing pace or unseen video frames; state only visible evidence.",
    "Use performance only as context; do not claim the creative caused the result.",
    "",
    `Adjust group: ${creative.creativeName}`,
    `Current Meta names: ${creative.metaCreativeNames.join(" | ") || "same"}`,
    `Spend: ${creative.metaSpend.toFixed(2)}`,
    `CTR: ${creative.metaCtr.toFixed(2)}%; CPC: ${creative.metaCpc.toFixed(2)}; CPI: ${creative.cpi.toFixed(2)}`,
    `CVR: ${creative.cvr.toFixed(2)}%; D1: ${creative.adjustRetentionD1.toFixed(1)}%; D7: ${creative.adjustRetentionD7.toFixed(1)}%`,
    `Media variants: ${media.length}`,
    ...media.map(
      (item, index) =>
        `Variant ${index + 1}: type=${item.mediaType}; headline=${item.headline ?? ""}; primary_text=${item.primaryText ?? ""}; description=${item.description ?? ""}`,
    ),
    "",
    "Return concise classifications and observations useful for cross-creative aggregation.",
  ].join("\n");
}

async function imageDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CreativeIntelligence/1.0; +https://cursor.com)",
      },
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) return null;
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function analyzeCreative(
  creative: CreativeForAnalysis,
): Promise<CreativeAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for creative scans.");
  const model =
    process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-4.1-mini";
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: analysisPrompt(creative) },
  ];
  for (const media of creative.media.slice(0, 3)) {
    if (!media.thumbnailUrl?.startsWith("https://")) continue;
    const dataUrl = await imageDataUrl(media.thumbnailUrl);
    if (!dataUrl) continue;
    content.push({
      type: "image_url",
      image_url: { url: dataUrl, detail: "low" },
    });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a careful creative strategist. Classify only supported evidence and return valid JSON.",
        },
        { role: "user", content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "creative_analysis",
          strict: true,
          schema: analysisSchema,
        },
      },
      temperature: 0.2,
      max_tokens: 900,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI creative scan ${response.status}: ${body.slice(0, 400)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Creative scan returned no analysis.");
  const parsed = JSON.parse(raw) as Omit<
    CreativeAnalysis,
    "schemaVersion" | "creativeId" | "fingerprint" | "scannedAt" | "model"
  >;
  return {
    schemaVersion: analysisSchemaVersion,
    creativeId: creative.creativeId,
    fingerprint: creativeFingerprint(creative),
    scannedAt: new Date().toISOString(),
    model,
    ...parsed,
  };
}
