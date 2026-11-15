import { parse } from "node-html-parser";
import { BlockedError, cached } from "./cache";
import { errorResult, McpServer, ToolInfo } from "./mcp";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MAX_IMAGES = 4;

const HOSTS: Record<string, string> = {
  de: "www.vinted.de",
  at: "www.vinted.at",
  fr: "www.vinted.fr",
  it: "www.vinted.it",
  es: "www.vinted.es",
  nl: "www.vinted.nl",
  be: "www.vinted.be",
  lu: "www.vinted.lu",
  pl: "www.vinted.pl",
  cz: "www.vinted.cz",
  sk: "www.vinted.sk",
  lt: "www.vinted.lt",
  pt: "www.vinted.pt",
  se: "www.vinted.se",
  dk: "www.vinted.dk",
  fi: "www.vinted.fi",
  uk: "www.vinted.co.uk",
};

/** Vinted's status_ids; the order matches the condition dropdown on the site. */
const CONDITIONS: Record<string, number> = {
  neu_mit_etikett: 6,
  neu: 1,
  sehr_gut: 2,
  gut: 3,
  zufriedenstellend: 4,
};

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const HTML_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "de-DE,de;q=0.9",
};

function hostFor(country: string | undefined): string {
  const key = (country ?? "de").toLowerCase().replace(/^\./, "");
  const host = HOSTS[key === "co.uk" || key === "gb" ? "uk" : key];
  if (!host) throw new Error(`Unbekanntes Vinted-Land „${country}“. Möglich: ${Object.keys(HOSTS).join(", ")}.`);
  return host;
}

/**
 * Vinted's JSON catalogue picks the market from the caller's IP, and Cloudflare's egress IPs count as US.
 * The server-rendered pages on www.vinted.<tld> always show that country's market, so they are the source.
 */
async function page(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: HTML_HEADERS });
    if (res.status !== 403 && res.status !== 429) return res;
    // Honour a short Retry-After once; anything longer goes back to the caller instead of hammering.
    const wait = Number(res.headers.get("Retry-After"));
    if (attempt > 0 || res.status !== 429 || !(wait > 0 && wait <= 3)) throw new BlockedError(res.status);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

/** Search results stay fresh for 15 minutes, item pages for an hour. */
const SEARCH_FRESH_MS = 15 * 60_000;
const ITEM_FRESH_MS = 60 * 60_000;

const staleNote = (minutes?: number) =>
  minutes === undefined ? "" : `Hinweis: Vinted drosselt gerade, das ist der Stand von vor ${minutes} Minuten.\n\n`;

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Prices show up either as {amount, currency_code} or as a plain string next to a currency field. */
function money(value: any, currency?: string): string {
  if (value === undefined || value === null || value === "") return "";
  const amount = typeof value === "object" ? value.amount : value;
  const cur = (typeof value === "object" ? value.currency_code : undefined) ?? currency ?? "EUR";
  const n = Number(amount);
  if (!Number.isFinite(n)) return clean(amount);
  return `${n.toFixed(2).replace(".", ",")} ${cur === "EUR" ? "€" : cur}`;
}

interface SearchArgs {
  query: string;
  country?: string;
  min_price?: number;
  max_price?: number;
  sort?: "relevance" | "newest_first" | "price_low_to_high" | "price_high_to_low";
  condition?: string[];
  page?: number;
  per_page?: number;
}

function searchParams(a: SearchArgs): URLSearchParams {
  const p = new URLSearchParams({ search_text: a.query.trim() });
  if (a.min_price !== undefined) p.set("price_from", String(a.min_price));
  if (a.max_price !== undefined) p.set("price_to", String(a.max_price));
  if (a.min_price !== undefined || a.max_price !== undefined) p.set("currency", "EUR");
  if (a.sort) p.set("order", a.sort);
  for (const c of a.condition ?? []) {
    const id = CONDITIONS[c];
    if (id) p.append("status_ids[]", String(id));
  }
  return p;
}

interface CatalogItem {
  id: string;
  url: string;
  title: string;
  attrs: string[];
  price: string;
  total: string;
}

const PRICE_RE = /^\d[\d.,\s]*\s?(€|EUR|£|zł|Kč|kr|Ft|lei|RON|SEK|DKK|PLN|CZK|HUF|\$)$/;

/**
 * Each result tile has an overlay link whose title reads
 * "<Titel>, Marke: woom, Zustand: Gut, Größe: M, 20.00 €, 21.70 €" (labels in the site's language).
 */
export function parseCatalog(html: string, host: string): CatalogItem[] {
  const seen = new Set<string>();
  const items: CatalogItem[] = [];
  for (const m of html.matchAll(/<a\s[^>]*data-testid="product-item-id-(\d+)--overlay-link"[^>]*>/g)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const tag = m[0];
    const href = tag.match(/href="([^"]+)"/)?.[1] ?? `/items/${id}`;
    const parts = decodeEntities(tag.match(/title="([^"]*)"/)?.[1] ?? "").split(", ");
    const prices: string[] = [];
    while (parts.length > 1 && PRICE_RE.test(parts[parts.length - 1].trim())) prices.unshift(parts.pop()!.trim());
    const attrs: string[] = [];
    while (parts.length > 1 && /^[^:]{2,25}: \S/.test(parts[parts.length - 1])) attrs.unshift(parts.pop()!);
    const fmt = (p?: string) => (p ? p.replace(/(\d)\.(\d{2})\b/, "$1,$2") : "");
    items.push({
      id,
      url: `https://${host}${decodeEntities(href).split("?")[0]}`,
      title: clean(parts.join(", ")),
      attrs,
      price: fmt(prices[0]),
      total: fmt(prices[1]),
    });
  }
  return items;
}

function formatItem(it: CatalogItem): string {
  const price = it.total && it.total !== it.price ? `${it.price} (${it.total} mit Käuferschutz)` : it.price;
  return [`- **${it.title}**${price ? ` · ${price}` : ""}`, it.attrs.length ? `  ${it.attrs.join(" · ")}` : "", `  ${it.url}`]
    .filter(Boolean)
    .join("\n");
}

async function search(a: SearchArgs): Promise<Content[]> {
  if (!a.query?.trim()) return [{ type: "text", text: "Bitte einen Suchbegriff angeben." }];
  const host = hostFor(a.country);
  const pageNo = Math.max(1, a.page ?? 1);
  const perPage = Math.min(96, Math.max(1, a.per_page ?? 24));
  const params = searchParams(a);
  const browserUrl = `https://${host}/catalog?${params}`;
  if (pageNo > 1) params.set("page", String(pageNo));
  const url = `https://${host}/catalog?${params}`;
  // per_page is applied after the cache, so the same search with a different page size costs nothing.
  const { value, staleMinutes } = await cached(`s:${url}`, SEARCH_FRESH_MS, async () => {
    const res = await page(url);
    if (!res.ok) throw new Error(`Vinted antwortete mit HTTP ${res.status} auf die Katalogsuche.`);
    const html = await res.text();
    return { items: parseCatalog(html, host), total: html.match(/total_entries\\?"\s*:\s*(\d+)/)?.[1] };
  });
  const { items, total } = value;
  const note = staleNote(staleMinutes);
  if (!items.length) return [{ type: "text", text: `${note}Keine Artikel für „${a.query}“ auf ${host} gefunden.\n${browserUrl}` }];
  const shown = items.slice(0, perPage);
  const head = `${total ? `${total} Treffer` : `${items.length} Treffer auf dieser Seite`} für „${a.query}“ auf ${host}, Seite ${pageNo}${
    shown.length < items.length ? ` (die ersten ${shown.length} von ${items.length} dieser Seite)` : ""
  }.`;
  return [{ type: "text", text: `${note}${head}\nSuche im Browser: ${browserUrl}\n\n${shown.map(formatItem).join("\n\n")}` }];
}

function parseItemRef(input: string, country?: string): { host: string; id: string } {
  const v = input.trim();
  if (/^\d{5,}$/.test(v)) return { host: hostFor(country), id: v };
  const u = new URL(v.startsWith("http") ? v : `https://${v}`);
  if (!Object.values(HOSTS).includes(u.hostname) && !Object.values(HOSTS).includes(`www.${u.hostname}`)) {
    throw new Error("Nur Links von Vinted oder Artikel-IDs sind erlaubt.");
  }
  const id = u.pathname.match(/\/items\/(\d+)/)?.[1];
  if (!id) throw new Error("Im Link steckt keine Artikel-ID (erwartet …/items/1234567890-…).");
  return { host: u.hostname.startsWith("www.") ? u.hostname : `www.${u.hostname}`, id };
}

interface ItemDetails {
  lines: string[];
  photos: string[];
}

/** The product page carries JSON-LD and Open Graph tags; the item API is gone since autumn 2026. */
async function fromPage(host: string, id: string): Promise<ItemDetails | null> {
  const res = await page(`https://${host}/items/${id}`);
  if (!res.ok) return null;
  const root = parse(await res.text());
  const meta = (p: string) => root.querySelector(`meta[property="${p}"]`)?.getAttribute("content") ?? "";
  let product: any;
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.text);
      product = [data, ...(data["@graph"] ?? [])].find((d: any) => d?.["@type"] === "Product");
      if (product) break;
    } catch {
      // Broken JSON-LD blocks are skipped.
    }
  }
  const title = clean(product?.name) || clean(meta("og:title"));
  if (!title) return null;
  const offer = Array.isArray(product?.offers) ? product.offers[0] : product?.offers;
  const images = product?.image ? (Array.isArray(product.image) ? product.image : [product.image]) : [meta("og:image")];
  const sold = /SoldOut|OutOfStock/.test(String(offer?.availability ?? ""));
  return {
    photos: images.filter(Boolean),
    lines: [
      `# ${sold ? "Verkauft: " : ""}${title}`,
      `Preis: ${money(offer?.price, offer?.priceCurrency) || "keine Angabe"}`,
      product?.brand?.name ? `Marke: ${clean(product.brand.name)}` : "",
      offer?.itemCondition ? `Zustand: ${clean(String(offer.itemCondition).split("/").pop())}` : "",
      `\n## Beschreibung\n${clean(product?.description ?? meta("og:description")) || "keine"}`,
      `\nhttps://${host}/items/${id}`,
    ],
  };
}

function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function getItem(input: string, country: string | undefined, withImages: boolean): Promise<Content[]> {
  const { host, id } = parseItemRef(input, country);
  const { value: details, staleMinutes } = await cached(`i:${host}:${id}`, ITEM_FRESH_MS, () => fromPage(host, id));
  if (!details) return [{ type: "text", text: `Artikel ${id} auf ${host} nicht gefunden (gelöscht oder verkauft?).` }];

  const text = staleNote(staleMinutes) + details.lines.filter((l) => l.trim()).join("\n");
  const content: Content[] = [{ type: "text", text }];
  if (withImages) {
    for (const src of details.photos.slice(0, MAX_IMAGES)) {
      const img = await fetch(src, { headers: { "User-Agent": UA } });
      if (!img.ok) continue;
      const mime = (img.headers.get("Content-Type") ?? "image/jpeg").split(";")[0];
      if (!mime.startsWith("image/")) continue;
      content.push({ type: "image", data: toBase64(new Uint8Array(await img.arrayBuffer())), mimeType: mime });
    }
  }
  return content;
}

const COUNTRY_PROP = {
  type: "string",
  enum: Object.keys(HOSTS),
  description: "Vinted-Länderseite, Standard de (vinted.de)",
};

const TOOLS: ToolInfo[] = [
  {
    name: "search_items",
    title: "Vinted durchsuchen",
    description:
      "Sucht Artikel auf Vinted und liefert je Treffer Titel, Preis (auch inkl. Käuferschutz), Marke, Zustand, Größe und Link (bis 96 pro Seite).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriff, z. B. „Patagonia Fleece“ oder „Lego 42115“" },
        country: COUNTRY_PROP,
        min_price: { type: "number", minimum: 0, description: "Mindestpreis in Euro" },
        max_price: { type: "number", minimum: 0, description: "Höchstpreis in Euro" },
        sort: {
          type: "string",
          enum: ["relevance", "newest_first", "price_low_to_high", "price_high_to_low"],
          description: "Sortierung, Standard relevance",
        },
        condition: {
          type: "array",
          items: { type: "string", enum: Object.keys(CONDITIONS) },
          description: "Nur diese Zustände",
        },
        page: { type: "integer", minimum: 1, maximum: 50, description: "Ergebnisseite (Standard 1)" },
        per_page: { type: "integer", minimum: 1, maximum: 96, description: "Treffer pro Seite (Standard 24)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_item",
    title: "Vinted-Artikel anzeigen",
    description:
      "Liest einen einzelnen Vinted-Artikel: Titel, Preis, Marke, Zustand, Beschreibung und optional die ersten Fotos.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Link zum Artikel oder die Artikel-ID" },
        country: { ...COUNTRY_PROP, description: "Nur nötig, wenn statt eines Links eine ID übergeben wird (Standard de)" },
        images: { type: "boolean", description: `Die ersten ${MAX_IMAGES} Fotos mitliefern (Standard true)` },
      },
      required: ["url"],
    },
  },
];

export const vintedServer: McpServer = {
  info: { name: "vinted", title: "Vinted", version: "0.3.0" },
  instructions:
    "Lesender Zugriff auf Vinted ohne Login, Standard ist vinted.de. search_items für Suchen (Preisgrenzen, Zustand, " +
    "Sortierung), get_item für Details und Fotos eines Artikels. Immer den Link zum Artikel mitgeben. " +
    "Kaufen, Favorisieren und Nachrichten an Verkäufer kann dieser Connector nicht. " +
    "Vinted drosselt schnell (HTTP 429): lieber eine Suche mit großem per_page als mehrere Seiten, get_item nur für die " +
    "zwei, drei Artikel, die wirklich interessieren, und nie mehrere Aufrufe parallel. Nach einer Drosselung nicht sofort " +
    "erneut versuchen, sondern dem Nutzer Bescheid geben. Ergebnisse werden 15 Minuten (Suche) bzw. 1 Stunde (Artikel) zwischengespeichert.",
  tools: TOOLS,
  async call(name, args) {
    try {
      if (name === "search_items") return { content: await search(args as unknown as SearchArgs) };
      return {
        content: await getItem(String(args.url ?? ""), args.country as string | undefined, args.images !== false),
      };
    } catch (e) {
      return errorResult(`Fehler: ${(e as Error).message}`);
    }
  },
};
