import { housekeeping } from "./cron.js";
import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      housekeeping(env).then((report) => {
        // eslint-disable-next-line no-console -- the housekeeping run's one structured line, counts only
        console.log(JSON.stringify({ level: "info", msg: "sign housekeeping", ...report }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
