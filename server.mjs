
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.TINYFISH_API_KEY;

const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5175");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    const url = new URL(
        req.url || "/",
        `http://localhost:${PORT}`
    );

    if (url.pathname === "/api/health" && req.method === "GET") {
        res.writeHead(200);
        return res.end(JSON.stringify({
            status: "ok",
            service: "Atmos TinyFish backend",
            configured: Boolean(API_KEY),
            timestamp: new Date().toISOString()
        }));
    }

    if (url.pathname !== "/api/advisories" || req.method !== "GET") {
        res.writeHead(404);
        return res.end(JSON.stringify({
            error: "Endpoint not found"
        }));
    }

    if (!API_KEY) {
        res.writeHead(500);
        return res.end(JSON.stringify({
            error: "TinyFish API key is not configured."
        }));
    }

    try {
        const query = url.searchParams.get("query")?.trim()
            || "India official weather warnings IMD severe weather alerts";

        const searchUrl = new URL("https://api.search.tinyfish.ai");
        searchUrl.searchParams.set("query", query);
        searchUrl.searchParams.set("location", "IN");
        searchUrl.searchParams.set("language", "en");

        const response = await fetch(searchUrl, {
            headers: {
                "X-API-Key": API_KEY,
                "Accept": "application/json"
            },
            signal: AbortSignal.timeout(20000)
        });

        if (!response.ok) {
            console.error("TinyFish HTTP status:", response.status);

            res.writeHead(502);
            return res.end(JSON.stringify({
                error: `TinyFish request failed with HTTP ${response.status}.`
            }));
        }

        const data = await response.json();

        const results = Array.isArray(data.results)
            ? data.results.slice(0, 10).map((item) => ({
                title: String(item.title || "Untitled result"),
                source: String(item.site_name || ""),
                url: String(item.url || ""),
                snippet: String(item.snippet || ""),
                position: Number(item.position || 0)
            }))
            : [];

        res.writeHead(200);
        return res.end(JSON.stringify({
            provider: "TinyFish Search",
            query,
            retrievedAt: new Date().toISOString(),
            count: results.length,
            results
        }));
    } catch (error) {
        console.error("TinyFish request error:", error.message);

        res.writeHead(502);
        return res.end(JSON.stringify({
            error: error.name === "TimeoutError"
                ? "TinyFish request timed out. Try again."
                : "Could not retrieve results from TinyFish."
        }));
    }
});

server.listen(PORT, () => {
    console.log(`Atmos backend running at http://localhost:${PORT}`);
});
