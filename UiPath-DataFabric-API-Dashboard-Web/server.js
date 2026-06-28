// ============================================================================
// server.js — MCP server that lets Claude pull live data from UiPath
// Data Fabric, plus a small web dashboard that shows the same data in a
// browser.
//
// Three things live in this one file:
//   1. An MCP endpoint            (POST /mcp)                — what Claude talks to
//   2. A JSON data endpoint       (GET  /api/dashboard-data)  — what dashboard.html talks to
//   3. A static file server                                  — serves dashboard.html itself
//
// Both Claude's tool call and the browser dashboard end up calling the same
// two helper functions near the top of this file: getAccessToken() and
// getDashboardData(). One auth flow, reused everywhere — that's the whole
// design.
// ============================================================================

// Node does NOT read .env files on its own. This line loads it into
// process.env before anything else runs — remove it and UIPATH_CLIENT_SECRET
// below will always be undefined.
import "dotenv/config";

import express from "express";

// The official MCP SDK. McpServer is the high-level helper for defining
// tools; StreamableHTTPServerTransport is the HTTP wire format Claude speaks
// (the current MCP standard — older examples you find online may show SSE
// instead, which is being phased out).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Pull the one secret value out of process.env (it was loaded from .env
// above). PORT defaults to 3000 if you don't set it in .env.
const {
  UIPATH_CLIENT_SECRET,
  UIPATH_CLIENT_ID,
  UIPATH_TOKEN_URL,
  UIPATH_BASE_DATA_URL,
  UIPATH_SCOPE,
  PAGE_SIZE = 1000,
  PORT = 3000,
} = process.env;

const TOKEN_URL = UIPATH_TOKEN_URL;
const CLIENT_ID = UIPATH_CLIENT_ID;
const SCOPE = UIPATH_SCOPE;
const BASE_DATA_URL = UIPATH_BASE_DATA_URL;

// Fail loudly and immediately if the secret is missing, instead of limping
// along and failing confusingly later when a token request 401s.
const required = [
  "UIPATH_CLIENT_SECRET",
  "UIPATH_CLIENT_ID",
  "UIPATH_TOKEN_URL",
  "UIPATH_BASE_DATA_URL",
  "UIPATH_SCOPE",
];

const missing = required.filter((k) => !process.env[k]);

if (missing.length) {
  console.error(
    `Missing required environment variables:\n${missing.join("\n")}`
  );
  process.exit(1);
}



// ---------------------------------------------------------------------------
// Token cache. UiPath access tokens expire after ~1 hour. Without caching,
// every single call (from Claude or from the dashboard) would request a
// brand-new token, which is slow and pointless. These two variables just
// live in memory for as long as the server process keeps running — they
// reset to null/0 every time you restart `npm start`.
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0; // a timestamp in milliseconds, comparable to Date.now()

async function getAccessToken() {
  // If we already have a token AND it hasn't expired yet, reuse it instead
  // of hitting UiPath again. This is the entire point of the cache.
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  // This is the OAuth2 "client_credentials" grant — the exact same request
  // you tested manually in Postman. It trades client_id + client_secret for
  // a short-lived access_token.
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: UIPATH_CLIENT_SECRET,
      scope: SCOPE,
    }),
  });

  if (!res.ok) {
    // Surface UiPath's real error body instead of swallowing it. If your
    // secret is wrong or expired, this is the message that lands in your
    // terminal.
    const body = await res.text();
    throw new Error(`Token request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // data.expires_in is in seconds (usually 3600 = 1 hour). Subtracting 60
  // means we refresh a minute early instead of risking a request that
  // straddles the exact expiry moment.
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// Fetches ALL transcript QA records from Data Fabric, paging through with
// start/limit until every record has been collected, using whatever token
// getAccessToken() hands back. UiPath's read endpoint returns
// { TotalRecordCount, Value } per page — we keep requesting pages and
// concatenating Value until we've collected TotalRecordCount records.
async function getDashboardData() {
  const token = await getAccessToken();

  let start = 0;
  let total = Infinity; // unknown until the first page comes back
  const allRecords = [];
  let pageNum = 0;

  while (start < total) {
    const url = `${BASE_DATA_URL}?start=${start}&limit=${PAGE_SIZE}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // If UiPath ever returns plain text or an HTML error page instead of
      // JSON, this stops JSON.parse from throwing and silently hides the real
      // error message.
      parsed = text;
    }

    if (!res.ok) {
      throw new Error(`Data Fabric API error ${res.status}: ${JSON.stringify(parsed)}`);
    }

    // DEBUG: print the raw shape of the first page to the terminal. This is
    // the easiest way to confirm what UiPath is actually sending back —
    // check your `npm start` terminal after hitting /api/dashboard-data or
    // calling the MCP tool. Once you've confirmed the field names below are
    // correct for your tenant, you can delete this block.
    if (pageNum === 0) {
      console.log("Data Fabric raw response keys:", Object.keys(parsed));
      console.log("Data Fabric raw response sample:", JSON.stringify(parsed).slice(0, 1000));
    }
    pageNum++;

    // UiPath isn't fully consistent about PascalCase vs camelCase across
    // tenants/endpoints, so we check both spellings rather than assuming one.
    const pageRecords = parsed.Value ?? parsed.value ?? [];
    const totalCount =
      parsed.TotalRecordCount ?? parsed.totalRecordCount ?? pageRecords.length;

    total = totalCount;
    allRecords.push(...pageRecords);
    start += PAGE_SIZE;

    // Safety net: if the API ever returns an empty page before we hit
    // `total` (shouldn't happen, but better than spinning forever), stop.
    if (pageRecords.length === 0) break;
  }

  // Same overall shape UiPath itself returns, just with every page merged
  // into one Value array — so dashboard.html and the MCP tool don't need to
  // change how they read the result.
  return { TotalRecordCount: total, Value: allRecords };
}

// ---------------------------------------------------------------------------
// MCP server definition — this is the part Claude actually "sees".
// ---------------------------------------------------------------------------
function buildServer() {
  // A fresh McpServer instance is created per request — see the comment
  // near app.post("/mcp", ...) below for why.
  const server = new McpServer({
    name: "transcript-qa-dashboard",
    version: "1.0.0",
  });

  // server.tool(name, description, inputSchema, handler)
  //   name        — the identifier Claude calls: get_transcript_qa_dashboard
  //   description — Claude reads this text to decide WHEN to use the tool.
  //                 Be specific; vague descriptions get ignored or misused.
  //   {}          — input schema. An empty object means this tool takes no
  //                 arguments at all. (If you wanted Claude to pass, say, a
  //                 date filter, you'd describe that parameter here using
  //                 zod instead of {}.)
  //   handler     — the function that actually runs when Claude calls it.
  server.tool(
    "get_transcript_qa_dashboard",
    "Fetch all records from the TranscriptQADashboard entity in UiPath Data Fabric (staging). Use this whenever the user asks about transcript QA data, scores, or wants a summary of it.",
    {},
    async () => {
      const data = await getDashboardData();
      // MCP tool results must come back in this exact shape: a "content"
      // array of typed blocks. "text" is the simplest block type — Claude
      // reads the JSON string and reasons over it like any other text.
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Express auto-generates an ETag for every JSON response by default. That's
// normally a nice optimization, but for a live dashboard it backfires: the
// browser can send a conditional request (If-None-Match) and get back a 304
// "nothing changed, reuse your cache" even when the underlying UiPath data
// genuinely has changed shape (e.g. record count). Disabling it means every
// request always gets a full, fresh body.
app.disable("etag");

// Serves every file inside ./public as a plain static file. This single
// line is the entire reason http://localhost:3000/dashboard.html works —
// there's no explicit route written for it anywhere; Express just looks in
// the public/ folder for a matching filename.
app.use(express.static("public"));

// dashboard.html's own JavaScript calls THIS endpoint (via fetch, in the
// browser) to get live numbers. It's a plain GET returning JSON — nothing
// MCP-specific about it. It reuses the exact same auth + data logic as the
// tool above, so both paths always show the same numbers.
app.get("/api/dashboard-data", async (_req, res) => {
  try {
    const data = await getDashboardData();
    // Belt-and-suspenders alongside app.disable("etag") above: explicitly
    // tell the browser never to cache this response or treat it as
    // revalidatable, so a 304 can never happen on this route.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json(data);
  } catch (err) {
    console.error("Dashboard data error:", err);
    res.status(500).json({ error: err.message });
  }
});

// This is the one endpoint Claude itself talks to. Every MCP message —
// both "what tools do you have?" and "call this tool" — arrives here as a
// POST request.
app.post("/mcp", async (req, res) => {
  try {
    // A new server + transport is built fresh for every request, rather
    // than reusing one shared instance, because this server runs
    // "stateless": each request is handled independently, with no MCP
    // session remembered between calls. That's simpler to reason about and
    // works fine on hosting platforms that don't guarantee the same request
    // hits the same running instance twice.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // undefined = stateless mode, no session ID tracking
    });

    // Clean up once the HTTP response finishes, so nothing is left running
    // in the background after the request is done.
    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      // -32603 is the standard JSON-RPC "internal error" code. MCP messages
      // are built on JSON-RPC, so errors follow that same shape.
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Browsers send GET by default. If you open /mcp directly in a browser tab,
// you'll land here — that's expected, not a bug. MCP only ever uses POST.
app.get("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));
app.delete("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));

// A trivial endpoint that just confirms the server process is alive at all,
// independent of UiPath auth or MCP. This is the first thing to check when
// something feels broken — if /health fails, the problem is the server
// itself, not your UiPath credentials.
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
