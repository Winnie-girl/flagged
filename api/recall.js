const SYS_PROMPT = `You are Flagged, a product recall analyst for ecommerce sellers. Your job is to determine whether a seller's product has an active recall.

You have two sources of information — use both:
1. Live government database data (CPSC and FDA) provided in this message. Treat this as your primary source when available.
2. Your own training knowledge of documented product recalls. Always cross-reference this alongside the live data, regardless of whether the databases returned results.

Decision rules:
- Return "recall_found" if EITHER the live database data OR your training knowledge confirms a real recall for this product with high confidence. Do not downgrade to "caution" simply because a database was unavailable or returned no results — if you know about a well-documented recall, say so.
- Return "caution" only when you have genuine uncertainty: partial matches, possible brand aliases, or conflicting signals where you cannot confidently confirm or rule out a recall.
- Return "clear" when both live data and your training knowledge find no recall.
- When returning "recall_found" based on training knowledge (not live data), populate recall_details and official_url from what you know. Include the real CPSC.gov or FDA.gov recall page URL if you know it.
- Account for name variations, model numbers, and brand aliases.
- Missing a real recall is worse than a false positive.

Return ONLY this JSON: { "status": "clear"|"caution"|"recall_found", "confidence": 0-100, "headline": "one sentence verdict", "recall_details": { "date": "", "reason": "", "affected_products": "", "hazard": "" }, "action_steps": ["step 1", "step 2", "step 3"], "official_url": "" }`;

/* ── SHARED FETCH HELPER ── */
async function fetchGov(url, timeout = 8000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, data: await r.json() };
  } catch (e) {
    clearTimeout(tid);
    return { ok: false, note: e.name === 'AbortError' ? 'timed out' : e.message };
  }
}

/* ── KEYWORD FILTER for recalls.json ── */
function keywordFilter(records, query) {
  // Extract meaningful words (3+ chars) from the query
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  if (keywords.length === 0) return records.slice(0, 5);

  return records
    .filter(rec => {
      const text = JSON.stringify(rec).toLowerCase();
      return keywords.some(kw => text.includes(kw));
    })
    .slice(0, 5);
}

/* ── CPSC SOURCE 1: cpsc.gov/recalls.json (general feed, filter by keyword) ── */
async function fetchCPSCFeed(q) {
  const r = await fetchGov('https://www.cpsc.gov/recalls.json');
  if (!r.ok) return { ok: false, note: `recalls.json: ${r.note}` };

  // Normalise — the feed may wrap records under various keys
  const raw = r.data;
  const records = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.recalls) ? raw.recalls
    : Array.isArray(raw?.data)    ? raw.data
    : [];

  const matches = keywordFilter(records, q);
  return { ok: true, data: matches, source: 'cpsc.gov/recalls.json' };
}

/* ── CPSC FALLBACK: recalls.gov search ── */
async function fetchRecallsGov(q) {
  const url = `https://recalls.gov/api/search?query=${encodeURIComponent(q)}&agency=CPSC&limit=10`;
  const r   = await fetchGov(url);
  if (!r.ok) return { ok: false, note: `recalls.gov: ${r.note}` };
  return { ok: true, data: r.data, source: 'recalls.gov' };
}

/* ── CPSC ORCHESTRATOR: primary → fallback ── */
async function fetchCPSC(q) {
  const feed = await fetchCPSCFeed(q);

  // Use the feed if it succeeded AND found keyword matches
  if (feed.ok && feed.data.length > 0) return feed;

  // Otherwise (fetch failed OR zero matches) try the recalls.gov fallback
  const fallback = await fetchRecallsGov(q);
  if (fallback.ok) return fallback;

  // Both sources failed
  return {
    ok:   false,
    note: 'CPSC data unavailable (recalls.json and recalls.gov both failed)',
  };
}

/* ── FDA ── */
async function fetchFDAFood(q) {
  const r = await fetchGov(
    `https://api.fda.gov/food/enforcement.json?search=product_description:"${encodeURIComponent(q)}"&limit=5`
  );
  return r.ok ? r : { ok: false, note: 'FDA food database unavailable' };
}

async function fetchFDADevice(q) {
  const r = await fetchGov(
    `https://api.fda.gov/device/enforcement.json?search=device_name:"${encodeURIComponent(q)}"&limit=5`
  );
  return r.ok ? r : { ok: false, note: 'FDA device database unavailable' };
}

/* ── CLAUDE ── */
async function callClaude(apiKey, product, cpsc, fdaFood, fdaDev, retry = false) {
  const cpscLabel = cpsc.ok
    ? `CPSC Data (source: ${cpsc.source})`
    : 'CPSC Data';
  const cpscValue = cpsc.ok
    ? JSON.stringify(cpsc.data)
    : cpsc.note;

  const userMsg = `Product to check: "${product}"

${cpscLabel}: ${cpscValue}

FDA Food Enforcement: ${fdaFood.ok ? JSON.stringify((fdaFood.data?.results || []).slice(0, 5)) : fdaFood.note}

FDA Device Enforcement: ${fdaDev.ok ? JSON.stringify((fdaDev.data?.results || []).slice(0, 5)) : fdaDev.note}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     SYS_PROMPT,
      messages:   [{ role: 'user', content: userMsg }],
    }),
  });

  if (!r.ok) throw new Error(`Anthropic error ${r.status}`);

  const data = await r.json();
  const text = data?.content?.[0]?.text || '';

  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in response');
    return JSON.parse(m[0]);
  } catch {
    if (!retry) {
      await new Promise(res => setTimeout(res, 600));
      return callClaude(apiKey, product, cpsc, fdaFood, fdaDev, true);
    }
    throw new Error('AI returned an invalid response after retry');
  }
}

/* ── HANDLER ── */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { query, name } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'Missing required field: query' });
  }

  try {
    // CPSC tries sources sequentially (primary → fallback)
    // FDA sources run in parallel with each other, independent of CPSC
    const [cpsc, fdaFood, fdaDev] = await Promise.all([
      fetchCPSC(query),
      fetchFDAFood(query),
      fetchFDADevice(query),
    ]);

    const product = name || query;
    const verdict = await callClaude(apiKey, product, cpsc, fdaFood, fdaDev);

    return res.status(200).json(verdict);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Request failed' });
  }
};
