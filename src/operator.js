// Read-only operator API for the panel's Operator tab.
//
//   GET /api/operator/ledger              exact session totals, pending values, top supporters, units, flags
//   GET /api/operator/events?limit=100    recent normalized events with their outcome
//   GET /api/operator/connection          lifecycle state, health, gaps and retry info
//
// Figures are locally observed through an unofficial connector; they are not TikTok's
// authoritative numbers. Nothing here exposes credentials (the sign-server key never leaves
// the TikTokSource).
import { DISCLAIMER } from "./ledger.js";

const context = { ledger: null, source: null };

// Call once at startup: configureOperator({ ledger, source: tiktok }).
export function configureOperator({ ledger = null, source = null } = {}) {
  context.ledger = ledger;
  context.source = source;
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

// Returns true when it handled the request (any /api/operator path), false otherwise.
export function operatorRoutes(req, res, url, ctx = context) {
  const pathname = url?.pathname || "";
  if (pathname !== "/api/operator" && !pathname.startsWith("/api/operator/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { error: "Operator routes are read-only; use GET." });
    return true;
  }
  const { ledger, source } = ctx || {};
  if (!ledger) {
    send(res, 503, { error: "Operator view is not configured (no ledger)." });
    return true;
  }
  try {
    if (pathname === "/api/operator/ledger") {
      send(res, 200, ledger.snapshot());
    } else if (pathname === "/api/operator/events") {
      const raw = Number.parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 500)) : 100;
      send(res, 200, { generatedAt: Date.now(), disclaimer: DISCLAIMER, limit, events: ledger.history(limit) });
    } else if (pathname === "/api/operator/connection") {
      const status = source ? source.status : null;
      send(res, 200, {
        generatedAt: Date.now(),
        disclaimer: DISCLAIMER,
        connection: status,
        health: status?.health ?? null,
        retry: status?.retry ?? null,
        ledgerGaps: ledger.gaps(),
        flags: ledger.flags(),
      });
    } else {
      send(res, 404, { error: "Unknown operator endpoint", endpoints: ["/api/operator/ledger", "/api/operator/events?limit=", "/api/operator/connection"] });
    }
  } catch (err) {
    send(res, 500, { error: err?.message || String(err) });
  }
  return true;
}
