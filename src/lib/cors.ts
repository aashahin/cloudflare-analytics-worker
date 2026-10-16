// ─── CORS Helpers ────────────────────────────────────────────────────────────
// Public routes (collect, tracker, health) use wildcard origin.
// Authenticated routes echo back the request Origin for tighter security.

export function publicCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export function privateCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // Authenticated payloads (tenant analytics, admin domain lists, minted
    // tokens) must never be stored by browsers or intermediaries.
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

export function handleCors(request: Request): Response {
  const origin = request.headers.get("Origin") ?? "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

export function publicJsonResponse(
  data: unknown,
  status: number = 200,
): Response {
  return Response.json(data, { status, headers: publicCorsHeaders() });
}

export function privateJsonResponse(
  request: Request,
  data: unknown,
  status: number = 200,
): Response {
  return Response.json(data, { status, headers: privateCorsHeaders(request) });
}

// ─── Common Error Responses ──────────────────────────────────────────────────

export function unauthorized(request: Request): Response {
  return Response.json(
    { error: "Unauthorized" },
    { status: 401, headers: privateCorsHeaders(request) },
  );
}

export function forbidden(request: Request, message: string): Response {
  return Response.json(
    { error: message },
    { status: 403, headers: privateCorsHeaders(request) },
  );
}

export function badRequest(request: Request, message: string): Response {
  return Response.json(
    { error: message },
    { status: 400, headers: privateCorsHeaders(request) },
  );
}

/**
 * 405 for a known path reached with the wrong method. The caller supplies the
 * route's CORS headers so the response carries the same origin policy as the
 * endpoint it describes.
 */
export function methodNotAllowed(headers: HeadersInit, allow: string): Response {
  return Response.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { ...headers, Allow: allow } },
  );
}
