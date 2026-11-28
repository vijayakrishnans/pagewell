import { remind } from "./cron.js";
import type { Env } from "./env.js";
import { route } from "./router.js";

export { DocRoom } from "./room.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      remind(env).then((report) => {
        // eslint-disable-next-line no-console -- the reminder run's one structured line, counts only
        console.log(JSON.stringify({ level: "info", msg: "review reminders", ...report }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
