import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Experiment = {
  id: string;
  name: string;
  hypothesis: string;
  control: string;
  variants: string;
  owner: string;
  primaryMetric: string;
  guardrails: string;
  status: "Planned" | "Running" | "Decided";
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type SavedReport = {
  id: string;
  name: string;
  url: string;
  createdAt: string;
};

export type TestBrief = {
  id: string;
  title: string;
  sourceBrand: string;
  sourceCreative: string;
  hypothesis: string;
  valueProposition: string;
  audience: string;
  variants: string;
  status: "Draft" | "Ready" | "Launched";
  createdAt: string;
  updatedAt: string;
};

type WorkspaceState = {
  version: 1;
  experiments: Experiment[];
  savedReports: SavedReport[];
  testBriefs: TestBrief[];
};

const emptyState = (): WorkspaceState => ({
  version: 1,
  experiments: [],
  savedReports: [],
  testBriefs: [],
});

export class WorkspaceStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<WorkspaceState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as WorkspaceState;
      if (value.version !== 1) return emptyState();
      return {
        version: 1,
        experiments: value.experiments ?? [],
        savedReports: value.savedReports ?? [],
        testBriefs: value.testBriefs ?? [],
      };
    } catch {
      return emptyState();
    }
  }

  private async write(value: WorkspaceState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }

  async listExperiments(): Promise<Experiment[]> {
    return (await this.read()).experiments.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async upsertExperiment(
    input: Omit<Experiment, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<Experiment> {
    const state = await this.read();
    const now = new Date().toISOString();
    const existing = input.id
      ? state.experiments.find((item) => item.id === input.id)
      : undefined;
    const value: Experiment = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    state.experiments = [
      value,
      ...state.experiments.filter((item) => item.id !== value.id),
    ];
    await this.write(state);
    return value;
  }

  async deleteExperiment(id: string): Promise<boolean> {
    const state = await this.read();
    const next = state.experiments.filter((item) => item.id !== id);
    if (next.length === state.experiments.length) return false;
    state.experiments = next;
    await this.write(state);
    return true;
  }

  async listSavedReports(): Promise<SavedReport[]> {
    return (await this.read()).savedReports;
  }

  async saveReport(name: string, url: string): Promise<SavedReport> {
    const state = await this.read();
    const value = {
      id: randomUUID(),
      name,
      url,
      createdAt: new Date().toISOString(),
    };
    state.savedReports = [value, ...state.savedReports].slice(0, 50);
    await this.write(state);
    return value;
  }

  async deleteSavedReport(id: string): Promise<boolean> {
    const state = await this.read();
    const next = state.savedReports.filter((item) => item.id !== id);
    if (next.length === state.savedReports.length) return false;
    state.savedReports = next;
    await this.write(state);
    return true;
  }

  async listTestBriefs(): Promise<TestBrief[]> {
    return (await this.read()).testBriefs.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async upsertTestBrief(
    input: Omit<TestBrief, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<TestBrief> {
    const state = await this.read();
    const now = new Date().toISOString();
    const existing = input.id
      ? state.testBriefs.find((item) => item.id === input.id)
      : undefined;
    const value: TestBrief = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    state.testBriefs = [
      value,
      ...state.testBriefs.filter((item) => item.id !== value.id),
    ];
    await this.write(state);
    return value;
  }
}
