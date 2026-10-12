// Varredura semanal rodando no GitHub Actions (.github/workflows/sweep.yml).
// Mesma lógica do Worker, mas sai dos IPs do GitHub: a Microsoft limita
// (Bing 400 ThrottleIP, IndexNow 429) os IPs de saída compartilhados dos
// Workers da Cloudflare — verificado 10–12/10/2026 em todos os sites.
// Uso: BING_API_KEY=... node scripts/sweep.mjs
// Sai com código 1 se algum site falhar, para o GitHub avisar por e-mail.
import { readFileSync, appendFileSync } from "node:fs";

const SITES = JSON.parse(readFileSync(new URL("../sites.json", import.meta.url), "utf8"));
const BING_API_KEY = process.env.BING_API_KEY?.trim();

async function lerLocs(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)].map((m) => m[1]);
  return { indice: /<sitemapindex[\s>]/.test(xml), locs };
}

async function sitemapUrls(site) {
  const raiz = await lerLocs(site.sitemap);
  let urls = raiz.locs;
  if (raiz.indice) {
    urls = [];
    for (const filho of raiz.locs) urls.push(...(await lerLocs(filho)).locs);
  }
  if (!urls.length) throw new Error("sitemap sem <loc>");
  return urls;
}

async function pingIndexNow(site, urls) {
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: site.host,
      key: site.indexnowKey,
      keyLocation: `https://${site.host}/${site.indexnowKey}.txt`,
      urlList: urls,
    }),
  });
  return res.status;
}

async function resubmitBingSitemap(site) {
  if (!BING_API_KEY) throw new Error("BING_API_KEY ausente");
  const res = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/SubmitFeed?apikey=${BING_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ siteUrl: site.bingSiteUrl, feedUrl: site.sitemap }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status;
}

const linhas = [];
let falhas = 0;
for (const site of SITES) {
  const r = { host: site.host, urls: 0, indexnow: "-", bing: "-" };
  try {
    const urls = await sitemapUrls(site);
    r.urls = urls.length;
    const s = await pingIndexNow(site, urls);
    r.indexnow = `HTTP ${s}`;
    if (s !== 200 && s !== 202) falhas++;
  } catch (e) {
    r.indexnow = `erro: ${e.message}`;
    falhas++;
  }
  try {
    r.bing = `HTTP ${await resubmitBingSitemap(site)}`;
  } catch (e) {
    r.bing = `erro: ${e.message}`;
    falhas++;
  }
  console.log(JSON.stringify(r));
  linhas.push(`| ${r.host} | ${r.urls} | ${r.indexnow} | ${r.bing} |`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Varredura ${new Date().toISOString().slice(0, 10)}\n\n| Site | URLs | IndexNow | Bing |\n|---|---|---|---|\n${linhas.join("\n")}\n`,
  );
}
process.exit(falhas ? 1 : 0);
