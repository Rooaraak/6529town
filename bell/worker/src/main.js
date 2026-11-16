// main.js: entry of the town worker. /api/bell and /api/bell/* go to the bell handler, the rest to the static
// files (env.ASSETS). No top-level `fetch` name: the bundle is one scope and push.js uses the global fetch.
import { sendPush } from "./push.js";
import { makeHandler } from "./api.js";
const bellMainHandler = makeHandler({ sendPush, now: () => Date.now() });
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api/bell" || path.startsWith("/api/bell/")) return bellMainHandler(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
