// Fresh information for questions whose answers change (who holds an office, an artist's
// releases, what a chart is, who a named person is), from keyless public sources: Wikipedia
// (English and Romanian) and the DuckDuckGo Instant Answer API.
//
// Safety and cost rules, all enforced here:
// - Only HTTPS requests to the hosts in ALLOWED_HOSTS; no credentials or secret-looking
//   parameters in URLs; no redirects followed; every resolved address is checked, and private,
//   loopback, link-local and other non-public addresses are refused at connect time (so DNS
//   tricks cannot reach the local network).
// - A hard time budget per question (1.5 s by default): past it the reply goes ahead without
//   the data, and the fetch finishes in the background only to fill the cache.
// - Responses are size-limited, cached in memory with a TTL, and treated as untrusted text: it
//   is cleaned, screened, and handed to the model inside <reference_data> tags with the
//   instruction that it is information, never instructions.
// - Every lookup is recorded (query, source, title, URL, time) for the operator panel at
//   GET /api/knowledge/recent. URLs are never given to the model to read aloud.
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { fold } from "./intent.js";
import { isProfane } from "./profanity.js";

export const ALLOWED_HOSTS = new Set(["en.wikipedia.org", "ro.wikipedia.org", "api.duckduckgo.com"]);
const MAX_BYTES = 256 * 1024;
const BUDGET_MS = 1500;
const TTL = { office: 30 * 60_000, chart: 6 * 3600_000, release: 30 * 60_000, subject: 6 * 3600_000, premise: 6 * 3600_000, keywords: 3600_000 };
const MISS_TTL = 10 * 60_000;
const CACHE_MAX = 300;
const LOG_MAX = 100;
const USER_AGENT = "CreatureLiveShow/1.0 (local TikTok LIVE character show; low-volume, cached lookups)";
const SECRET_PARAM = /^(key|api[-_]?key|apikey|token|access[-_]?token|auth|authorization|secret|client[-_]?secret|password|passwd|pwd|session(id)?|sig|signature|credential|bearer)$/i;

// --- URL and address checks -------------------------------------------------------------
// { ok: true, url } or { ok: false, reason }
export function checkUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https is allowed" };
  if (url.username || url.password) return { ok: false, reason: "credentials in URL" };
  if (url.port && url.port !== "443") return { ok: false, reason: "non-standard port" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) return { ok: false, reason: "IP address hosts are not allowed" };
  if (!ALLOWED_HOSTS.has(host)) return { ok: false, reason: `host not allowed: ${host}` };
  for (const [name] of url.searchParams) if (SECRET_PARAM.test(name)) return { ok: false, reason: `secret-looking parameter: ${name}` };
  if (url.href.length > 2000) return { ok: false, reason: "URL too long" };
  return { ok: true, url };
}

// True for any address that is not a normal public internet address.
export function isPrivateAddress(address) {
  const ip = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (v === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    const v4 = (hi, lo) => isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
    if (zeros(0, 8) || (zeros(0, 7) && g[7] === 1)) return true; // :: and ::1
    if (zeros(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // IPv4-mapped ::ffff:a.b.c.d
    if (zeros(0, 6)) return true; // deprecated IPv4-compatible ::a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b) return zeros(2, 6) ? v4(g[6], g[7]) : true; // NAT64 (well-known, or local-use)
    if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 carries an IPv4 address
    return (
      (g[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (g[0] & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (g[0] & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated, still routable inside sites)
      (g[0] & 0xff00) === 0xff00 || // multicast
      (g[0] === 0x2001 && g[1] === 0x0db8) || // documentation
      (g[0] === 0x2001 && g[1] === 0) || // Teredo (hides an IPv4 address)
      (g[0] === 0x0100 && zeros(1, 4)) // discard-only 100::/64
    );
  }
  return true; // not an IP at all: refuse
}

// "0:0:0:0:0:ffff:7f00:0001", "::ffff:127.0.0.1" and "[::FFFF:7F00:1]" all become the same
// eight 16-bit groups. Returns null if the text is not an IPv6 address.
function ipv6Groups(text) {
  let ip;
  try {
    ip = new URL(`http://[${text}]`).hostname.replace(/^\[|\]$/g, ""); // canonical form
  } catch {
    return null;
  }
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    ip = `${ip.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const parts = (s) => (s ? s.split(":").map((x) => parseInt(x, 16)) : []);
  const h = parts(head);
  const t = tail === null ? [] : parts(tail);
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null;
}

// DNS lookup that refuses non-public answers; used for the actual connection, so the address
// that was checked is the address connected to.
export function safeLookup(hostname, options, callback) {
  if (typeof options === "function") [callback, options] = [options, {}];
  dns.lookup(hostname, { all: true, family: options?.family || 0 }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      const e = new Error(`refused: ${hostname} resolves to a non-public address`);
      e.code = "EPRIVATE";
      return callback(e);
    }
    if (options?.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 6, keepAliveMsecs: 30_000, lookup: safeLookup });

// GETs a JSON document from an allowed host within `timeoutMs`; never follows redirects.
export function getJson(input, { timeoutMs = BUDGET_MS, signal, lookup = safeLookup, request = https.request } = {}) {
  const check = checkUrl(input);
  if (!check.ok) return Promise.reject(Object.assign(new Error(`blocked URL: ${check.reason}`), { code: "EBLOCKED" }));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      error ? reject(error) : resolve(value);
    };
    const req = request(check.url, { method: "GET", agent: lookup === safeLookup ? agent : undefined, lookup, headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Encoding": "identity" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return finish(Object.assign(new Error(`redirect refused (${res.statusCode})`), { code: "EREDIRECT" }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error(`HTTP ${res.statusCode}`));
      }
      const type = String(res.headers["content-type"] || "");
      if (!/json|javascript/i.test(type)) {
        res.resume();
        return finish(new Error(`unexpected content type ${type}`));
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          finish(Object.assign(new Error("response too large"), { code: "ETOOBIG" }));
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(new Error("invalid JSON"));
        }
      });
      res.on("error", (e) => finish(e));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(Object.assign(new Error("timed out"), { code: "ETIMEOUT" }));
    }, timeoutMs);
    const onAbort = () => {
      req.destroy();
      finish(Object.assign(new Error("aborted"), { code: "EABORT" }));
    };
    signal?.addEventListener?.("abort", onAbort);
    req.on("error", (e) => finish(e));
    req.end();
  });
}

// --- cleaning untrusted text -----------------------------------------------------------
const INJECTION = /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(instructions?|rules|prompt|previous|above)\b|\b(system|developer|assistant)\s*(prompt|message|mode|:)|\byou are now\b|\bnew instructions\b|\bdo not tell\b|\bjailbreak\b|<\/?\s*(system|assistant|user|reference_data|viewer_comment|event)\b/i;

export function cleanText(text, max = 600) {
  let t = String(text || "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ") // no links reach the model
    .replace(/\{\\displaystyle[^}]*\}/g, " ")
    .replace(/\(\s*[^()]{0,40}pronunciation:?[^()]*\)|\s*\[[^\]]{0,80}\]/gi, " ") // IPA and footnote marks
    .replace(/[<>{}]/g, " ")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\(\s*[;,]?\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Sentences that read like instructions to an AI are dropped, not passed on.
  t = t
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !INJECTION.test(s))
    .join(" ");
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = cut.lastIndexOf(". ");
    t = (end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`).trim();
  }
  return t;
}

// The single place retrieved text is screened before the model sees it: the show's broadcast
// guard (src/guard.js reviewRetrieved: drops injected instructions, links, contact details and
// anything that fails the broadcast rules; withholds everything during a guard outage). If the
// guard module can't be loaded, text that fails the profanity filter is withheld.
let guardModule;
export async function screenRetrieved(text) {
  if (guardModule === undefined) {
    try {
      guardModule = await import("./guard.js");
    } catch {
      guardModule = null;
    }
  }
  const fn = guardModule && (guardModule.reviewRetrieved || guardModule.screenRetrieved);
  if (typeof fn === "function") {
    try {
      const verdict = await fn(text);
      if (verdict === false || verdict?.ok === false || verdict?.allowed === false) return "";
      if (typeof verdict === "string") return verdict;
      if (typeof verdict?.text === "string") return verdict.text;
    } catch {
      return ""; // a failing guard withholds rather than passes
    }
  }
  return isProfane(text) ? "" : text;
}

// --- sources ----------------------------------------------------------------------------
const wikiApi = (lang, params) => `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", redirects: "1", ...params })}`;
const articleUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

function stripWiki(s) {
  return String(s || "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/<br\s*\/?>/gi, ", ")
    .replace(/<[^>]+>/g, "")
    .replace(/'''?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// An office article: its infobox names the current holder ("incumbent"), which the intro
// usually doesn't.
async function wikiOffice(title, opts) {
  const data = await getJson(wikiApi("en", { titles: title, prop: "extracts|revisions", exintro: "1", explaintext: "1", exsentences: "2", rvprop: "content|timestamp", rvslots: "main", rvsection: "0" }), opts);
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return null;
  const wikitext = page.revisions?.[0]?.slots?.main?.content || "";
  const field = (name) => stripWiki(new RegExp(`\\|\\s*${name}\\s*=\\s*([^\\n]*)`, "i").exec(wikitext)?.[1] || "");
  const incumbent = field("incumbent");
  const since = field("incumbent_?since");
  const acting = field("acting");
  const edited = page.revisions?.[0]?.timestamp?.slice(0, 10);
  const facts = incumbent ? `Current holder (Wikipedia infobox${edited ? `, page last edited ${edited}` : ""}): ${incumbent}${since ? `, in office since ${since}` : ""}${/^(y|yes)$/i.test(acting) ? " (acting)" : ""}.` : "";
  return { source: "Wikipedia (en)", title: page.title, url: articleUrl("en", page.title), text: `${facts} ${page.extract || ""}`.trim(), facts };
}

async function wikiPage(lang, title, opts, sentences = 4) {
  const data = await getJson(wikiApi(lang, { titles: title, prop: "extracts|info", exintro: "1", explaintext: "1", exsentences: String(sentences), inprop: "url" }), opts);
  const page = data?.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  return { source: `Wikipedia (${lang})`, title: page.title, url: articleUrl(lang, page.title), text: page.extract };
}

async function wikiSearch(lang, q, opts, sentences = 4) {
  const data = await getJson(wikiApi(lang, { generator: "search", gsrsearch: q, gsrlimit: "3", prop: "extracts|info", exintro: "1", explaintext: "1", exsentences: String(sentences), exlimit: "3", inprop: "url" }), opts);
  const pages = (data?.query?.pages || []).filter((p) => p.extract).sort((a, b) => (a.index ?? 9) - (b.index ?? 9));
  return pages.map((p) => ({ source: `Wikipedia (${lang})`, title: p.title, url: articleUrl(lang, p.title), text: p.extract }));
}

async function duckduckgo(q, opts) {
  const data = await getJson(`https://api.duckduckgo.com/?${new URLSearchParams({ q, format: "json", no_html: "1", skip_disambig: "1", no_redirect: "1", t: "creature-show" })}`, opts);
  const text = data?.AbstractText || data?.Answer || "";
  if (!text) return null;
  return { source: `DuckDuckGo${data.AbstractSource ? ` / ${data.AbstractSource}` : ""}`, title: data.Heading || q, url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, text };
}

// Does a result actually talk about what was asked? Every word of a name must appear.
function about(result, name) {
  if (!result) return false;
  const hay = fold(`${result.title} ${result.text}`);
  const parts = fold(name).replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length > 1);
  return parts.length > 0 && parts.every((w) => hay.includes(w));
}
const STOPWORDS = new Set("the a an of in on at to for and or is are was were did does do when why how what who which with from by about win won paint painted".split(" "));
function sharesWords(result, q) {
  const hay = fold(`${result.title} ${result.text}`);
  return fold(q).replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)).some((w) => hay.includes(w));
}

// One plan per kind of question; each returns up to two results.
async function fetchFor(plan, opts) {
  const lang = plan.lang === "ro" ? "ro" : "en";
  switch (plan.kind) {
    case "office": {
      const r = await wikiOffice(plan.q, opts);
      return r?.facts ? [r] : [];
    }
    case "chart": {
      const r = await wikiPage("en", plan.q, opts, 3);
      return r ? [r] : [];
    }
    case "release": {
      const [list, ddg] = await Promise.all([wikiSearch("en", plan.q, opts, 3).catch(() => []), duckduckgo(plan.subject, opts).catch(() => null)]);
      const disc = list.find((r) => /discography/i.test(r.title) && about(r, plan.subject)) || list.find((r) => about(r, plan.subject));
      return [disc, about(ddg, plan.subject) ? ddg : null].filter(Boolean).slice(0, 2);
    }
    case "subject": {
      const [ddg, list] = await Promise.all([duckduckgo(plan.q, opts).catch(() => null), wikiSearch(lang, plan.q, opts, 3).catch(() => [])]);
      if (about(ddg, plan.q)) return [ddg];
      const hit = list.find((r) => about(r, plan.q));
      return hit ? [hit] : [];
    }
    case "premise": {
      // The named people or works in the question, looked up side by side.
      const names = (plan.names || [plan.subject]).filter(Boolean).slice(0, 2);
      const found = await Promise.all(names.map(async (n) => {
        const ddg = await duckduckgo(n, opts).catch(() => null);
        if (about(ddg, n)) return ddg;
        const list = await wikiSearch(lang, n, opts, 2).catch(() => []);
        return list.find((r) => about(r, n)) || null;
      }));
      return found.filter(Boolean);
    }
    default: {
      const list = await wikiSearch(lang, plan.q, opts, 3).catch(() => []);
      return list.filter((r) => sharesWords(r, plan.q)).slice(0, 1);
    }
  }
}

// --- the service ------------------------------------------------------------------------
export class Knowledge {
  constructor({ log = () => {}, fetcher = fetchFor, now = () => Date.now(), budgetMs = BUDGET_MS } = {}) {
    this.log = log;
    this.fetcher = fetcher;
    this.now = now;
    this.budgetMs = budgetMs;
    this.cache = new Map();
    this.inflight = new Map();
    this.recent = [];
  }

  key(plan) {
    return `${plan.kind}|${plan.lang || "en"}|${fold(plan.q)}|${(plan.names || []).map(fold).join(",")}`;
  }

  cached(plan) {
    const hit = this.cache.get(this.key(plan));
    if (hit && this.now() - hit.at < hit.ttl) return hit.value;
    return null;
  }

  // Looks the plan up within the time budget. Resolves (never rejects) with
  // { ok, results: [{ source, title, url, text }], ms, cached, error }.
  async lookup(plan, { budgetMs = this.budgetMs, intent = "", signal } = {}) {
    const t0 = this.now();
    const key = this.key(plan);
    const hit = this.cached(plan);
    if (hit) {
      this.record(plan, intent, { ...hit, ms: 0, cached: true });
      return { ...hit, ms: 0, cached: true };
    }
    // Two viewers asking the same thing share one fetch.
    let job = this.inflight.get(key);
    if (!job) {
      job = (async () => {
        try {
          const raw = await this.fetcher(plan, { timeoutMs: Math.max(budgetMs, 4000) });
          const results = [];
          for (const r of raw || []) {
            const text = await screenRetrieved(cleanText(r.text, plan.kind === "premise" ? 350 : 600));
            if (text) results.push({ source: r.source, title: cleanText(r.title, 120), url: r.url, text });
          }
          const value = { ok: results.length > 0, results, error: results.length ? "" : "nothing relevant found" };
          this.store(key, value, results.length ? TTL[plan.kind] || TTL.keywords : MISS_TTL);
          return value;
        } catch (error) {
          const value = { ok: false, results: [], error: error?.code === "EBLOCKED" ? error.message : String(error?.message || error) };
          this.store(key, value, Math.min(MISS_TTL, 60_000)); // network trouble: retry soon
          return value;
        } finally {
          this.inflight.delete(key);
        }
      })();
      this.inflight.set(key, job);
    }
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve({ ok: false, results: [], error: `no answer within ${budgetMs} ms`, late: true }), budgetMs)));
    const aborted = new Promise((resolve) => signal?.addEventListener?.("abort", () => resolve({ ok: false, results: [], error: "aborted" }), { once: true }));
    const value = await Promise.race([job, late, aborted]);
    clearTimeout(timer);
    const out = { ...value, ms: Math.round(this.now() - t0), cached: false };
    this.record(plan, intent, out);
    return out;
  }

  store(key, value, ttl) {
    this.cache.set(key, { value, at: this.now(), ttl });
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
  }

  record(plan, intent, out) {
    const first = out.results?.[0];
    const entry = {
      at: new Date().toISOString(),
      query: plan.q,
      kind: plan.kind,
      intent,
      ok: Boolean(out.ok),
      source: first?.source || "",
      title: (out.results || []).map((r) => r.title).join(" · "),
      url: first?.url || "",
      urls: (out.results || []).map((r) => r.url),
      ms: out.ms,
      cached: Boolean(out.cached),
      error: out.ok ? "" : out.error || "",
    };
    this.recent.push(entry);
    if (this.recent.length > LOG_MAX) this.recent.shift();
    this.log(`Knowledge: ${plan.kind} "${plan.q}" -> ${entry.ok ? entry.title : `nothing (${entry.error})`} in ${entry.ms} ms${entry.cached ? " (cached)" : ""}.`);
  }

  recentLookups(limit = 50) {
    return this.recent.slice(-limit).reverse();
  }
}

// The data block for the prompt: delimited, labelled as untrusted, without URLs.
export function referenceBlock(found, { fetchedAt = new Date(), query = "" } = {}) {
  if (!found?.ok || !found.results?.length) return "";
  const when = fetchedAt.toISOString().slice(0, 16).replace("T", " ");
  const parts = found.results.map((r) => `<reference_data source="${r.source.replace(/"/g, "'")}" title="${r.title.replace(/"/g, "'")}" retrieved="${when} UTC"${query ? ` query="${String(query).replace(/"/g, "'").slice(0, 80)}"` : ""}>\n${r.text}\n</reference_data>`);
  return parts.join("\n");
}

// One shared instance for the show; the operator route reads its log.
export const knowledge = new Knowledge();
export const recentLookups = (limit) => knowledge.recentLookups(limit);
