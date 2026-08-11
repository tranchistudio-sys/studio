import http from "node:http";

const target = "http://127.0.0.1:4200";
const port = 4299;
const username = "x20";
const password = process.env.PREVIEW_CODE;

function authorized(req) {
  const value = req.headers.authorization || "";
  if (!value.startsWith("Basic ")) return false;
  const decoded = Buffer.from(value.slice(6), "base64").toString();
  return decoded === `${username}:${password}`;
}

http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="AI Codex X20 Preview"', "cache-control": "no-store" });
    return res.end("Unauthorized");
  }
  try {
    const upstream = await fetch(`${target}${req.url || "/"}`, {
      method: req.method,
      headers: { ...req.headers, host: "127.0.0.1:4200", authorization: "" },
      body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : req,
    });
    const headers = Object.fromEntries(upstream.headers.entries());
    headers["cache-control"] = "no-store";
    delete headers["content-length"]; delete headers["content-encoding"]; delete headers["transfer-encoding"];
    res.writeHead(upstream.status, headers);
    const body = await upstream.arrayBuffer();
    res.end(Buffer.from(body));
  } catch {
    res.writeHead(502, { "cache-control": "no-store" });
    res.end("Preview upstream unavailable");
  }
}).listen(port, "127.0.0.1");
