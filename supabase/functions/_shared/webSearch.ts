// WEB SEARCH (2026-10-02) — shared by project-ai (conversations, summaries)
// and legal-ai (the Newsletter's weekly digest).
//
// Anthropic's own server-side web search — no other provider sees the
// question. `web_search_20250305` is the version Google Cloud (Vertex AI)
// offers too. Capped per answer ($10 per 1,000 searches, plus the results'
// tokens); Romanian sources are preferred by the rule, not by a location.
export const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
  // No user_location: the API refuses country "RO" ("Country code RO is not
  // supported") and fails the whole call. Romanian sources are asked for in
  // WEB_SEARCH_RULE instead.
};
export const WEB_SEARCH_RULE =
  "You can search the web with the web_search tool. Search only when the answer depends on information that is current, " +
  "changing or not in the conversation (recent law changes, case law, official guidance, a company, prices, dates). " +
  "The user works under Romanian law: prefer official Romanian sources (legislatie.just.ro, monitoruloficial.ro, portal.just.ro, " +
  "anaf.ro, onrc.ro, ministries and courts) and EUR-Lex for EU law, and search in Romanian when the question is about Romania. " +
  "Never narrate the search (no \"I'll search for…\"). Lead with the direct answer in the first sentence, without filler, " +
  "then the support. Every statement you take from a search result must rest on that result: the app numbers the " +
  "sources and links them after the statement automatically, so do not write source lists, footnotes or URLs yourself.";
// RESEARCH searches EVERY time (2026-10-02 — the sources are the point of it;
// with the rule above Claude answered most legal questions from memory, so no
// sources and no cards came back). Replaces the rule's first sentence.
export const WEB_SEARCH_ALWAYS =
  "You can search the web with the web_search tool, and you MUST use it before answering any question about law, " +
  "facts, an act, a court, a company, a person, a figure or a date — even when you believe you know the answer — and " +
  "base the answer on what you find. Only a greeting or small talk is answered without searching. ";
// Numbers the web sources of ONE answer and writes the links after a cited
// passage: " [1](url) [2](url)". A source is numbered when it is first cited;
// sources searched but never cited are numbered after them (shown in the
// "Sources reviewed" list).
export type Source = { index: number; title: string; url: string; snippet: string; pageAge?: string; cited: boolean };
export type Citer = { results: (block: Record<string, unknown>) => Source[]; marks: (citations: unknown[]) => string; list: () => Source[] };
export function makeCiter(): Citer {
  const byUrl = new Map<string, Source>();
  let next = 1;
  const clean = (u: unknown) => String(u ?? "").trim();
  const get = (url: string, title = "", snippet = "", pageAge = ""): Source => {
    let s = byUrl.get(url);
    if (!s) { s = { index: 0, title: title || url, url, snippet, pageAge, cited: false }; byUrl.set(url, s); }
    if (title && (!s.title || s.title === url)) s.title = title;
    if (snippet && !s.snippet) s.snippet = snippet;
    return s;
  };
  return {
    results(block) {
      const items = Array.isArray(block?.content) ? block.content as Array<Record<string, unknown>> : [];
      const added: Source[] = [];
      for (const r of items) {
        if (r?.type !== "web_search_result") continue;
        const url = clean(r.url);
        if (!/^https?:\/\//i.test(url)) continue;
        if (!byUrl.has(url)) added.push(get(url, clean(r.title), "", clean(r.page_age)));
      }
      return added;
    },
    marks(citations) {
      const seen: Source[] = [];
      for (const c of (citations || []) as Array<Record<string, unknown>>) {
        if (c?.type !== "web_search_result_location") continue;
        const url = clean(c.url);
        if (!/^https?:\/\//i.test(url)) continue;
        const s = get(url, clean(c.title), clean(c.cited_text).slice(0, 300));
        if (!s.cited) { s.cited = true; s.index = next++; }
        if (!s.snippet) s.snippet = clean(c.cited_text).slice(0, 300);
        if (!seen.includes(s)) seen.push(s);
      }
      return seen.map((s) => ` [${s.index}](${s.url.replace(/\)/g, "%29").replace(/ /g, "%20")})`).join("");
    },
    list() {
      const all = [...byUrl.values()];
      let n = all.filter((s) => s.cited).length;
      for (const s of all) if (!s.cited && !s.index) s.index = ++n;
      return all.sort((a, b) => a.index - b.index);
    },
  };
}
// The same, for a whole (not streamed) message: links written into its text.
export function citeMessage(data: Record<string, unknown>, cite: Citer) {
  const blocks = (Array.isArray(data?.content) ? data.content : []) as Array<Record<string, unknown>>;
  for (const b of blocks) {
    if (b?.type === "web_search_tool_result") cite.results(b);
    if (b?.type === "text" && Array.isArray(b.citations) && b.citations.length) {
      b.text = String(b.text ?? "") + cite.marks(b.citations);
    }
  }
}
