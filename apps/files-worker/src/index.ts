import { sweep } from "./cron.js";
import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweep(env).then((report) => {
        // Counts only: no ids, names or keys.
        // eslint-disable-next-line no-console -- the sweep's one structured line
        console.log(JSON.stringify({ level: "info", msg: "files sweep", ...report }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
