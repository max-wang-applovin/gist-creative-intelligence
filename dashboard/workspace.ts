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
  creativeIds: string[];
  testBriefId: string | null;
  status: "Planned" | "Running" | "Decided";
  decision: string | null;
  decidedAt: string | null;
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

export type PerformanceTarget = {
  id: string;
  dimension: "Global" | "OS" | "Source" | "Format";
  segment: string;
  cpi: number | null;
  cpsu: number | null;
  d1: number | null;
  d3: number | null;
  d7: number | null;
  updatedAt: string;
};

export type DecisionRecord = {
  id: string;
  creativeId: string;
  creativeName: string;
  decision: "Increase" | "Hold" | "Reduce" | "Scale" | "Pause" | "Iterate";
  reason: string;
  owner: string;
  source: string;
  metrics: Record<string, number | null>;
  createdAt: string;
};

export type WeeklyBriefArchive = {
  id: string;
  title: string;
  range: { since: string; until: string };
  metrics: {
    spend: number;
    installs: number;
    cpi: number | null;
    d7Ready: number;
    scaleOpportunities: number;
    fatiguing: number | null;
  };
  highlights: {
    working: string[];
    increase: string[];
    reduce: string[];
    fatigue: string[];
  };
  createdAt: string;
};

type WorkspaceState = {
  version: 1;
  experiments: Experiment[];
  savedReports: SavedReport[];
  testBriefs: TestBrief[];
  targets: PerformanceTarget[];
  decisions: DecisionRecord[];
  weeklyBriefs: WeeklyBriefArchive[];
};

const emptyState = (): WorkspaceState => ({
  version: 1,
  experiments: [],
  savedReports: [],
  testBriefs: [],
  targets: [],
  decisions: [],
  weeklyBriefs: [],
});

export class WorkspaceStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async read(): Promise<WorkspaceState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as WorkspaceState;
      if (value.version !== 1) return emptyState();
      return {
        version: 1,
        experiments: (value.experiments ?? []).map((experiment) => ({
          ...experiment,
          creativeIds: experiment.creativeIds ?? [],
          testBriefId: experiment.testBriefId ?? null,
          decision: experiment.decision ?? null,
          decidedAt: experiment.decidedAt ?? null,
        })),
        savedReports: value.savedReports ?? [],
        testBriefs: value.testBriefs ?? [],
        targets: value.targets ?? [],
        decisions: value.decisions ?? [],
        weeklyBriefs: value.weeklyBriefs ?? [],
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

  private mutate<T>(
    mutation: (state: WorkspaceState) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      const state = await this.read();
      const result = await mutation(state);
      await this.write(state);
      return result;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async listExperiments(): Promise<Experiment[]> {
    return (await this.read()).experiments.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async upsertExperiment(
    input: Omit<Experiment, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<Experiment> {
    return this.mutate((state) => {
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
      return value;
    });
  }

  async deleteExperiment(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const next = state.experiments.filter((item) => item.id !== id);
      if (next.length === state.experiments.length) return false;
      state.experiments = next;
      return true;
    });
  }

  async listSavedReports(): Promise<SavedReport[]> {
    return (await this.read()).savedReports;
  }

  async saveReport(name: string, url: string): Promise<SavedReport> {
    return this.mutate((state) => {
      const value = {
        id: randomUUID(),
        name,
        url,
        createdAt: new Date().toISOString(),
      };
      state.savedReports = [value, ...state.savedReports].slice(0, 50);
      return value;
    });
  }

  async deleteSavedReport(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const next = state.savedReports.filter((item) => item.id !== id);
      if (next.length === state.savedReports.length) return false;
      state.savedReports = next;
      return true;
    });
  }

  async listTestBriefs(): Promise<TestBrief[]> {
    return (await this.read()).testBriefs.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async upsertTestBrief(
    input: Omit<TestBrief, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<TestBrief> {
    return this.mutate((state) => {
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
      return value;
    });
  }

  async listTargets(): Promise<PerformanceTarget[]> {
    return (await this.read()).targets.sort((a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      a.segment.localeCompare(b.segment),
    );
  }

  async upsertTarget(
    input: Omit<PerformanceTarget, "id" | "updatedAt"> & { id?: string },
  ): Promise<PerformanceTarget> {
    return this.mutate((state) => {
      const existing = state.targets.find(
        (item) =>
          item.id === input.id ||
          (item.dimension === input.dimension &&
            item.segment.toLowerCase() === input.segment.toLowerCase()),
      );
      const value: PerformanceTarget = {
        ...input,
        id: existing?.id ?? randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      state.targets = [
        value,
        ...state.targets.filter(
          (item) =>
            item.id !== value.id &&
            !(
              item.dimension === value.dimension &&
              item.segment.toLowerCase() === value.segment.toLowerCase()
            ),
        ),
      ];
      return value;
    });
  }

  async deleteTarget(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const next = state.targets.filter((item) => item.id !== id);
      if (next.length === state.targets.length) return false;
      state.targets = next;
      return true;
    });
  }

  async listDecisions(): Promise<DecisionRecord[]> {
    return (await this.read()).decisions.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async addDecision(
    input: Omit<DecisionRecord, "id" | "createdAt">,
  ): Promise<DecisionRecord> {
    return this.mutate((state) => {
      const value: DecisionRecord = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      state.decisions = [value, ...state.decisions].slice(0, 500);
      return value;
    });
  }

  async listWeeklyBriefs(): Promise<WeeklyBriefArchive[]> {
    return (await this.read()).weeklyBriefs.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async addWeeklyBrief(
    input: Omit<WeeklyBriefArchive, "id" | "createdAt">,
  ): Promise<WeeklyBriefArchive> {
    return this.mutate((state) => {
      const value: WeeklyBriefArchive = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      state.weeklyBriefs = [value, ...state.weeklyBriefs].slice(0, 104);
      return value;
    });
  }

  async deleteWeeklyBrief(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const next = state.weeklyBriefs.filter((item) => item.id !== id);
      if (next.length === state.weeklyBriefs.length) return false;
      state.weeklyBriefs = next;
      return true;
    });
  }
}
