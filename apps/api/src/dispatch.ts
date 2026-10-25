import { CloudTasksClient } from "@google-cloud/tasks";
import type { Config } from "./config";
import type { Database } from "./database";
export class Dispatcher {
  private readonly client = new CloudTasksClient();
  constructor(
    readonly c: Config,
    readonly db: Database,
  ) {}
  async dispatch(): Promise<void> {
    if (this.c.GAFFER_MODE === "local") return;
    const rows = await this.db.query<{ job_id: string; generation: number; path: string }>(
      `SELECT o.*,j.path FROM private.outbox o JOIN private.jobs j ON j.id=o.job_id WHERE o.sent_at IS NULL AND o.next_at<=now() AND j.status='queued' ORDER BY o.next_at LIMIT 10`,
    );
    for (const row of rows) {
      const parent = this.client.queuePath(
        this.c.GCP_PROJECT!,
        this.c.GCP_REGION,
        row.path.endsWith("/match/live")
          ? this.c.SIM_TASK_QUEUE
          : row.path === "/internal/lorebook"
            ? this.c.BACKGROUND_TASK_QUEUE
            : this.c.TASK_QUEUE,
      );
      const origin = row.path.endsWith("/match/live") ? this.c.SIM_URL! : this.c.WORKER_URL!;
      try {
        await this.client.createTask({
          parent,
          task: {
            name: `${parent}/tasks/${row.job_id}-${row.generation}`,
            dispatchDeadline: { seconds: 720 },
            httpRequest: {
              httpMethod: "POST",
              url: `${origin}/internal/jobs/${row.job_id}`,
              headers: { "Content-Type": "application/json" },
              body: Buffer.from("{}").toString("base64"),
              oidcToken: { serviceAccountEmail: this.c.TASK_SERVICE_ACCOUNT!, audience: origin },
            },
          },
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 6) throw error;
      }
      await this.db.query(
        "UPDATE private.outbox SET sent_at=now() WHERE job_id=$1 AND generation=$2",
        [row.job_id, row.generation],
      );
    }
  }
}
