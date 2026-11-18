// source-relay.mjs — DEV-ONLY fetch relay for the P2 gate.
//
// Why this exists: this build sandbox routes all egress through an
// authenticated HTTP proxy. Node and curl use it (NODE_USE_ENV_PROXY /
// *_proxy env vars); workerd (vite dev / wrangler dev) cannot — its
// outbound fetch has no direct route and fails with an internal error.
// The MCP gateway's install ceremony must re-fetch source files from
// GitHub at confirm time, so in the sandbox the Worker is pointed at
// this relay via the TALENTS_SOURCE_RELAY var (wrangler dev --var).
// The relay runs in Node, whose fetch DOES reach GitHub here.
//
// Production needs none of this: a deployed Worker's fetch is native.
// The relay only allows GitHub hosts and is bound to 127.0.0.1.

import { createServer } from "node:http";

const PORT = Number(process.env.RELAY_PORT ?? 4419);
const ALLOWED = ["https://raw.githubusercontent.com/", "https://api.github.com/"];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/fetch") {
    res.writeHead(404).end("not found");
    return;
  }
  const target = url.searchParams.get("url") ?? "";
  if (!ALLOWED.some((p) => target.startsWith(p))) {
    res.writeHead(403, { "content-type": "text/plain" }).end("relay: only GitHub hosts allowed");
    return;
  }
  try {
    const upstream = await fetch(target, { headers: { "user-agent": "talents-source-relay-dev" } });
    const body = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "text/plain; charset=utf-8" }).end(body);
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" }).end(`relay upstream error: ${(e).message}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`source relay → http://127.0.0.1:${PORT}/fetch?url=<github-url>`);
});
