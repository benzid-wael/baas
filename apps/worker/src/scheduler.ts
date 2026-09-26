import type { Clock, Duration, Instant } from "@baas/domain";
import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";

/**
 * One scheduler, whose only job is to run periodic work.
 *
 * Finding A8: the incumbent has several independent crons behind
 * `ORCHESTRATION_TRANSACTION_RECOVERY_ENABLED`,
 * `ORCHESTRATION_ORDER_RECOVERY_ENABLED` and
 * `ORCHESTRATION_HISTORY_REFRESH_ENABLED`, all defaulting to false — so a
 * correctly deployed service was silently inert. There is no flag here.
 * Recovery is not a feature.
 *
 * Jobs are never run concurrently with themselves: a slow tick delays the next
 * one rather than overlapping it, so a job cannot lap itself under load.
 */
export interface Job {
  readonly name: string;
  readonly every: Duration;
  run(): Promise<void>;
}

export interface SchedulerOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly jobs: readonly Job[];
}

interface JobState {
  readonly job: Job;
  dueAt: Instant;
  running: boolean;
}

export class Scheduler {
  private readonly states: JobState[];

  constructor(private readonly options: SchedulerOptions) {
    const now = options.clock.now();
    this.states = options.jobs.map((job) => ({
      job,
      dueAt: now,
      running: false,
    }));
  }

  /** Run whatever is due. Returns the names of the jobs that ran. */
  async tick(): Promise<readonly string[]> {
    const now = this.options.clock.now();
    const ran: string[] = [];

    for (const state of this.states) {
      if (state.running || state.dueAt.isAfter(now)) {
        continue;
      }
      state.running = true;
      try {
        await state.job.run();
        ran.push(state.job.name);
      } catch (error) {
        this.options.logger.error(
          { err: describeError(error), operationId: state.job.name },
          "scheduled job failed",
        );
      } finally {
        state.running = false;
        // Scheduled from completion, not from the previous due time, so a job
        // that takes longer than its interval does not immediately re-fire.
        state.dueAt = this.options.clock.now().plus(state.job.every);
      }
    }

    return ran;
  }

  nextDueAt(): Instant | undefined {
    return this.states
      .map((state) => state.dueAt)
      .sort((left, right) => left.compare(right))[0];
  }
}
