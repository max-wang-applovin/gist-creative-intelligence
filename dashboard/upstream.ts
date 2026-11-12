export type UpstreamLane = "adjust" | "meta" | "admanage" | "adscan";

type LaneStats = {
  queued: number;
  running: boolean;
  completed: number;
  failures: number;
  lastLabel: string | null;
  lastDurationMs: number | null;
  lastQueueMs: number | null;
  lastFinishedAt: string | null;
};

type LaneState = LaneStats & {
  tail: Promise<void>;
};

const lanes = new Map<UpstreamLane, LaneState>();

function laneState(lane: UpstreamLane): LaneState {
  let state = lanes.get(lane);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      queued: 0,
      running: false,
      completed: 0,
      failures: 0,
      lastLabel: null,
      lastDurationMs: null,
      lastQueueMs: null,
      lastFinishedAt: null,
    };
    lanes.set(lane, state);
  }
  return state;
}

export function runUpstreamTask<T>(
  lane: UpstreamLane,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const state = laneState(lane);
  const queuedAt = Date.now();
  state.queued += 1;
  const run = state.tail
    .catch(() => undefined)
    .then(async () => {
      state.queued -= 1;
      state.running = true;
      const startedAt = Date.now();
      const queueMs = startedAt - queuedAt;
      try {
        const value = await task();
        state.completed += 1;
        return value;
      } catch (error) {
        state.failures += 1;
        throw error;
      } finally {
        const durationMs = Date.now() - startedAt;
        state.running = false;
        state.lastLabel = label;
        state.lastDurationMs = durationMs;
        state.lastQueueMs = queueMs;
        state.lastFinishedAt = new Date().toISOString();
        if (durationMs >= 1_000 || queueMs >= 1_000) {
          process.stdout.write(
            `Upstream ${lane} · ${label} · ${durationMs}ms run · ${queueMs}ms queued\n`,
          );
        }
      }
    });
  state.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function upstreamTimingSnapshot(): Record<UpstreamLane, LaneStats> {
  return Object.fromEntries(
    (["adjust", "meta", "admanage", "adscan"] as const).map((lane) => {
      const { tail: _tail, ...stats } = laneState(lane);
      return [lane, { ...stats }];
    }),
  ) as Record<UpstreamLane, LaneStats>;
}

