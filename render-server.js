"use strict";

const http = require("http");
const { URL } = require("url");
const { handler } = require("./functions/index");

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();

  try {
    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    const queryStringParameters = Object.fromEntries(
      requestUrl.searchParams.entries()
    );

    const event = {
      httpMethod: req.method,
      path: requestUrl.pathname,
      queryStringParameters,
      headers: req.headers,
      ip: req.socket.remoteAddress || "",
    };

    const result = await handler(event);

    const statusCode = Number(result.statusCode) || 200;
    res.writeHead(statusCode, result.headers || {});

    if (result.isBase64Encoded && result.body) {
      res.end(Buffer.from(result.body, "base64"));
    } else {
      res.end(result.body || "");
    }

    console.log(
      `[render-http] method=${req.method} path=${requestUrl.pathname}` +
      ` status=${statusCode} total=${Date.now() - startedAt}ms`
    );
  } catch (err) {
    console.error("[render-http] Request failed:", err);

    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end("Internal Server Error");
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[render-http] Listening on ${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`[render-http] ${signal}: shutting down`);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
