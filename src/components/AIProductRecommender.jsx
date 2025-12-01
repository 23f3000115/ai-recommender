import React, { useState } from "react";

const PRODUCTS = [
  { id: "p1", name: "PocketPhone A1", price: 299, category: "phone", features: ["5.5in", "64GB", "dual-sim"] },
  { id: "p2", name: "PocketPhone Pro", price: 549, category: "phone", features: ["6.2in", "128GB", "fast-charge"] },
  { id: "p3", name: "BudgetPhone B2", price: 199, category: "phone", features: ["5.0in", "32GB"] },
  { id: "p4", name: "CameraZoom X", price: 699, category: "camera", features: ["50MP", "optical-zoom"] },
  { id: "p5", name: "WorkTablet T1", price: 429, category: "tablet", features: ["10in", "64GB"] },
  { id: "p6", name: "Lifestyle Earbuds", price: 89, category: "audio", features: ["noise-cancel", "bluetooth 5.2"] },
];

function ProductCard({ product }) {
  return (
    <div className="border rounded-2xl p-4 shadow-sm bg-white">
      <h3 className="text-lg font-semibold">{product.name}</h3>
      <p className="text-sm text-slate-600">{product.category.toUpperCase()}</p>
      <p className="mt-2 font-medium">${product.price}</p>
      <div className="mt-2 text-xs text-slate-500">{product.features.join(" · ")}</div>
    </div>
  );
}

export default function AIProductRecommender() {
  const [query, setQuery] = useState("");
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState(null);

  async function handleRecommend(e) {
    e && e.preventDefault();
    setError(null);
    if (!query.trim()) {
      setError("Enter something like: I want a phone under $500");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, products: PRODUCTS }),
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`Server error: ${resp.status} ${t}`);
      }
      const data = await resp.json();
      // expected { recommended_ids: [...], reason: "...", sources: [...] }
      const recs = Array.isArray(data.recommended_ids)
        ? data.recommended_ids.map(id => PRODUCTS.find(p => p.id === id)).filter(Boolean)
        : [];
      setRecommendations(recs);
      setExplanation(data.reason || "");
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">AI Product Recommender (Gemini + Web)</h1>
        <p className="text-sm text-slate-600 mt-1">Type preferences and get recommendations enhanced by live web search + Gemini.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 bg-white p-4 rounded-2xl shadow-sm">
          <form onSubmit={handleRecommend}>
            <label className="block text-sm font-medium mb-2">Your preference</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={'e.g. "I want a phone under $500"'}
              className="w-full border rounded-lg p-2 mb-3"
            />
            <button className="w-full py-2 rounded-xl font-medium border" disabled={loading}>
              {loading ? "Searching & Asking AI..." : "Get Recommendations"}
            </button>
          </form>

          {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

          <div className="mt-4">
            <h4 className="text-sm font-semibold">AI Results</h4>
            {recommendations.length === 0 ? (
              <div className="text-xs text-slate-500 mt-2">No recommendations yet.</div>
            ) : (
              <ul className="mt-2 space-y-2">
                {recommendations.map(r => (
                  <li key={r.id} className="text-sm">
                    <span className="font-medium">{r.name}</span> — ${r.price}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {explanation && (
            <div className="mt-4 text-sm">
              <strong>Why:</strong>
              <div className="text-xs text-slate-600 mt-1">{explanation}</div>
            </div>
          )}
        </div>

        <div className="md:col-span-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {PRODUCTS.map(p => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </div>
      </div>

      <footer className="mt-6 text-xs text-slate-500">
        <div>Backend flows: (1) search web for relevant results, (2) send top snippets + product catalog to Gemini, (3) parse JSON reply with recommended_ids.</div>
      </footer>
    </div>
  );
}
