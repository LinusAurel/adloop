import { createServer, type Server } from "node:http";

/**
 * The worker has no HTTP surface otherwise. Not published to the host
 * (docker-compose.yml keeps it compose-network-only) — it exists purely so
 * Docker's healthcheck has something to ask.
 */
export function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  return server;
}
