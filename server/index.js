// server/index.js (fixed regex escaping, debug + resilient Gemini JSON parsing + SerpApi error surfacing)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-pro";

function timeoutPromise(p, ms = 12000) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

async function webSearch(query) {
  if (!SERPAPI_KEY) {
    return { error: "SERPAPI_KEY not configured" };
  }
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}`;
  try {
    const r = await timeoutPromise(fetch(url), 8000);
    if (!r.ok) {
      const txt = await r.text();
      return { error: `SerpApi HTTP ${r.status}: ${txt}` };
    }
    const json = await r.json();
    return json;
  } catch (err) {
    return { error: `SerpApi fetch error: ${String(err)}` };
  }
}

async function askGemini(prompt) {
  if (!GEMINI_KEY) {
    throw new Error("GEMINI_API_KEY not set in server environment.");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    temperature: 0.2,
    maximumOutputTokens: 800
  };

  try {
    const r = await timeoutPromise(fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), 10000);

    const json = await r.json();
    return json;
  } catch (err) {
    throw new Error(`Gemini call failed: ${err.message}`);
  }
}

// Helper: try to extract JSON anywhere in the text response.
// Handles fenced ```json blocks, inline JSON, or any {...} containing arrays/objects.
function extractJSONFromText(text) {
  if (!text || typeof text !== "string") return null;

  // 1) try to find ```json ... ``` block(s)
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/ig;
  let m;
  while ((m = fencedRegex.exec(text)) !== null) {
    const candidate = m[1].trim();
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // continue searching
    }
  }

  // 2) fallback: find the first {...} substring that parses
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // try more robust scanning: attempt every {..} pair (naive)
      for (let i = firstBrace; i < lastBrace; i++) {
        if (text[i] !== "{") continue;
        for (let j = lastBrace; j > i; j--) {
          if (text[j] !== "}") continue;
          const sub = text.slice(i, j + 1);
          try {
            return JSON.parse(sub);
          } catch (err) {
            // keep trying
          }
        }
      }
    }
  }

  // 3) couldn't parse JSON
  return null;
}

app.post("/api/recommend", async (req, res) => {
  try {
    const { query, products } = req.body;
    if (!query) return res.status(400).json({ error: "missing query" });

    // 1) Search web
    const web = await webSearch(query);
    console.log("WEB SEARCH RESULT:", JSON.stringify(web && (web.error ? { error: web.error } : { got: true }), null, 2));

    // Build snippets (best-effort)
    let snippets = [];
    if (web && web.organic_results && Array.isArray(web.organic_results)) {
      for (const item of web.organic_results.slice(0, 5)) {
        snippets.push({ title: item.title, snippet: item.snippet || item.description || "", link: item.link || item.source });
      }
    } else if (web && web.error) {
      snippets.push({ title: "search-error", snippet: web.error });
    }

    // 2) Build prompt for Gemini (explicitly request JSON in a fenced block)
    const prompt = `
You are an assistant that recommends products from a small catalog.
User request: "${query}"

Catalog: ${JSON.stringify(products)}

Web snippets: ${JSON.stringify(snippets)}

INSTRUCTIONS:
Return ONLY a JSON object in a fenced code block with keys:
{ "recommended_ids": [ "p1", "p2" ], "reason": "short explanation", "sources": [ { "title": "...", "link": "..." } ] }

Respond with a fenced JSON block like:

\`\`\`json
{ "recommended_ids": [...], "reason": "...", "sources": [...] }
\`\`\`

Do not include any other text.
`;

    const gem = await askGemini(prompt);
    console.log("RAW GEMINI RESPONSE:", JSON.stringify(gem, null, 2));

    // Extract human-readable text from common Gemini response shapes
    let textCandidates = [];

    // candidates -> content -> parts/text
    if (gem && Array.isArray(gem.candidates) && gem.candidates.length) {
      for (const cand of gem.candidates) {
        if (cand.content) {
          if (Array.isArray(cand.content)) {
            for (const c of cand.content) {
              if (typeof c.text === "string") textCandidates.push(c.text);
              else if (typeof c === "string") textCandidates.push(c);
            }
          } else if (typeof cand.content === "string") {
            textCandidates.push(cand.content);
          }
        }
        if (cand.display) textCandidates.push(String(cand.display));
        if (cand.text) textCandidates.push(String(cand.text));
      }
    }

    // older/other shapes
    if (gem && gem.output && Array.isArray(gem.output)) {
      for (const out of gem.output) {
        if (out.content && Array.isArray(out.content)) {
          for (const c of out.content) {
            if (c.text) textCandidates.push(c.text);
          }
        }
        if (out.text) textCandidates.push(out.text);
      }
    }

    // as a last fallback, stringify the entire gem object to search for JSON text
    textCandidates.push(JSON.stringify(gem));

    // Try to extract JSON from each text candidate
    let parsed = null;
    for (const txt of textCandidates) {
      parsed = extractJSONFromText(txt);
      if (parsed) break;
    }

    if (parsed && Array.isArray(parsed.recommended_ids)) {
      // good
      return res.json(parsed);
    }

    // If we get here, Gemini didn't produce parsable JSON
    console.warn("Could not parse JSON from Gemini. Text candidates tried:", textCandidates.slice(0,3));
    // Fallback heuristic (same as before)
    const lower = query.toLowerCase();
    const priceMatch = lower.match(/(under|below|<)\s*\$?(\d{1,6})/);
    const maxPrice = priceMatch ? Number(priceMatch[2]) : null;
    let filtered = products.slice();
    if (maxPrice != null) filtered = filtered.filter(p => p.price <= maxPrice);
    const tokens = lower.split(/\s+/).filter(Boolean);
    filtered.sort((a, b) => {
      let sa = 0, sb = 0;
      tokens.forEach(t => {
        if (a.name.toLowerCase().includes(t) || a.category.includes(t) || a.features.join(' ').toLowerCase().includes(t)) sa++;
        if (b.name.toLowerCase().includes(t) || b.category.includes(t) || b.features.join(' ').toLowerCase().includes(t)) sb++;
      });
      return sb - sa;
    });
    const fallbackIds = filtered.slice(0, 3).map(p => p.id);

    return res.json({
      recommended_ids: fallbackIds,
      reason: "Fallback heuristic (Gemini did not return machine-readable JSON).",
      sources: snippets,
      debug: {
        gemini_candidates_tried: textCandidates.slice(0, 3)
      }
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server listening on ${port}`));
