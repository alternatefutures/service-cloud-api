#!/usr/bin/env node
/**
 * Lightweight production server for Milaidy on Akash.
 *
 * Serves the built React dashboard UI as static files and proxies
 * /api/* and /ws requests to the Milaidy API server (running on an
 * internal port).
 *
 * This gives users the "open URL → see dashboard" experience
 * (same pattern as Clawdbot).
 *
 * Architecture:
 *   Browser → :2138 (this server)
 *     ├── /api/*  → proxy to localhost:INTERNAL_API_PORT
 *     ├── /ws     → WebSocket proxy to localhost:INTERNAL_API_PORT
 *     └── /*      → static files from apps/app/dist/ (SPA fallback)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────
const PUBLIC_PORT = Number(process.env.MILAIDY_PORT || 2138);
const API_PORT = Number(process.env.MILAIDY_INTERNAL_API_PORT || 31337);
const BIND = process.env.MILAIDY_API_BIND || "0.0.0.0";

// Locate the built UI. In the Docker image, the app is built at /app/apps/app/dist.
const UI_DIR = process.env.MILAIDY_UI_DIR
  || path.resolve("/app/apps/app/dist")

// ── MIME types ──────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf":  "font/ttf",
  ".otf":  "font/otf",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
  ".map":  "application/json",
  ".txt":  "text/plain; charset=utf-8",
  ".xml":  "application/xml",
  ".wasm": "application/wasm",
};

// ── Proxy helper ────────────────────────────────────────────────────────
function proxyRequest(clientReq, clientRes) {
  const opts = {
    hostname: "127.0.0.1",
    port: API_PORT,
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: `127.0.0.1:${API_PORT}`,
    },
  };

  const proxyReq = http.request(opts, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error(`[serve-ui] Proxy error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
    }
    clientRes.end(JSON.stringify({ error: "API unavailable", detail: err.message }));
  });

  clientReq.pipe(proxyReq, { end: true });
}

// ── Static file serving ─────────────────────────────────────────────────
const indexHtml = path.join(UI_DIR, "index.html");
let indexHtmlContent = null;

function loadIndexHtml() {
  try {
    indexHtmlContent = fs.readFileSync(indexHtml);
    return true;
  } catch {
    return false;
  }
}

function serveStatic(req, res) {
  // Decode URL and strip query string
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(parsed.pathname);

  // Resolve file path (prevent directory traversal)
  const filePath = path.join(UI_DIR, pathname);
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // Try to serve the exact file
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || "application/octet-stream";
      const content = fs.readFileSync(filePath);

      // Cache immutable hashed assets aggressively
      const cacheControl = pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate";

      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": content.length,
        "Cache-Control": cacheControl,
      });
      res.end(content);
      return;
    }
  } catch {
    // File doesn't exist — fall through to SPA fallback
  }

  // SPA fallback: serve index.html for all non-file routes
  if (indexHtmlContent) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": indexHtmlContent.length,
      "Cache-Control": "public, max-age=0, must-revalidate",
    });
    res.end(indexHtmlContent);
  } else {
    // UI not built — return a helpful message
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Milaidy</title></head>
<body style="font-family:system-ui;max-width:600px;margin:2rem auto;padding:0 1rem">
  <h1>Milaidy API is running</h1>
  <p>The dashboard UI is not available in this build.</p>
  <p>API endpoints:</p>
  <ul>
    <li><a href="/api/status">/api/status</a></li>
    <li><a href="/api/auth/status">/api/auth/status</a></li>
    <li><a href="/api/onboarding/status">/api/onboarding/status</a></li>
  </ul>
</body>
</html>`);
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────────
const uiAvailable = loadIndexHtml();
if (uiAvailable) {
  console.log(`[serve-ui] Dashboard UI loaded from ${UI_DIR}`);
} else {
  console.warn(`[serve-ui] No dashboard UI found at ${UI_DIR} — serving API-only fallback page`);
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  // Proxy /api/* and /ws to the internal Milaidy API server
  if (url.startsWith("/api/") || url.startsWith("/api?") || url === "/api") {
    proxyRequest(req, res);
    return;
  }

  // Everything else: serve static UI files
  serveStatic(req, res);
});

// WebSocket upgrade: proxy /ws to the internal API server
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";
  if (url === "/ws" || url.startsWith("/ws?")) {
    const opts = {
      hostname: "127.0.0.1",
      port: API_PORT,
      path: req.url,
      method: "GET",
      headers: {
        ...req.headers,
        host: `127.0.0.1:${API_PORT}`,
      },
    };

    const proxyReq = http.request(opts);
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n"
      );
      if (proxyHead.length) socket.write(proxyHead);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
    });

    proxyReq.on("error", (err) => {
      console.error(`[serve-ui] WS proxy error: ${err.message}`);
      socket.destroy();
    });

    proxyReq.end();
  } else {
    socket.destroy();
  }
});

server.listen(PUBLIC_PORT, BIND, () => {
  console.log(`[serve-ui] Listening on http://${BIND}:${PUBLIC_PORT}`);
  console.log(`[serve-ui] API proxy → http://127.0.0.1:${API_PORT}`);
  if (uiAvailable) {
    console.log(`[serve-ui] Dashboard: http://${BIND}:${PUBLIC_PORT}/`);
  }
});
