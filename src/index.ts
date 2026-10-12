// citado-indexer central — mantém indexados os sites da rede Citado que não
// têm o motor embutido (sites estáticos em Pages/Vercel, sem cron próprio).
//
// Toda segunda: para cada site da lista, lê o sitemap.xml, pinga IndexNow
// com todas as URLs e reenvia o sitemap ao Bing Webmaster.
// Regra de ouro (herdada do motor embutido): falha de um site não pode
// derrubar a varredura dos demais — tudo em try/catch, resultado no log.

interface Env {
  BING_API_KEY?: string;
  RUN_TOKEN?: string;
}

interface Site {
  host: string; // host canônico (como servido, com www se for o caso)
  sitemap: string;
  indexnowKey: string; // pública por design — hospedada em https://<host>/<key>.txt
  bingSiteUrl?: string; // como o site foi registrado no Bing Webmaster
}

// Lista única de sites: sites.json (lida também pelo GitHub Actions, que faz a varredura semanal).
import SITES_JSON from "../sites.json";
const SITES: Site[] = SITES_JSON;

interface SiteResult {
  host: string;
  urls: number;
  indexnow: string;
  bing: string;
  erro: string | null;
}

async function lerLocs(url: string): Promise<{ indice: boolean; locs: string[] }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)].map((m) => m[1]);
  return { indice: /<sitemapindex[\s>]/.test(xml), locs };
}

async function sitemapUrls(site: Site): Promise<string[]> {
  // Aceita sitemap simples ou índice de sitemaps (padrão do Astro: sitemap-index.xml → sitemap-0.xml)
  const raiz = await lerLocs(site.sitemap);
  let urls = raiz.locs;
  if (raiz.indice) {
    urls = [];
    for (const filho of raiz.locs) urls.push(...(await lerLocs(filho)).locs);
  }
  if (!urls.length) throw new Error("sitemap sem <loc>");
  return urls;
}

async function pingIndexNow(site: Site, urls: string[]): Promise<string> {
  // NOTA: os endpoints IndexNow da Microsoft (api.indexnow.org e www.bing.com)
  // limitam (HTTP 429) os IPs de saída COMPARTILHADOS dos Workers da Cloudflare
  // — verificado 12/09/2026 (do IP local a mesma key retorna 200). Não é erro de
  // chave nem de hospedagem. O ping é best-effort: a indexação no Bing é garantida
  // pelo reenvio semanal do sitemap (resubmitBingSitemap, HTTP 200) logo abaixo.
  // Para IndexNow nativo sem rate-limit, usar Cloudflare Crawler Hints na zona.
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
  return `HTTP ${res.status}`;
}

async function resubmitBingSitemap(env: Env, site: Site): Promise<string> {
  // .trim(): secrets colados via pipe no Windows podem carregar \r\n no fim
  const key = env.BING_API_KEY?.trim();
  if (!key) return "sem-chave";
  if (!site.bingSiteUrl) return "nao-registrado";
  const res = await fetch(
    `https://ssl.bing.com/webmaster/api.svc/json/SubmitFeed?apikey=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ siteUrl: site.bingSiteUrl, feedUrl: site.sitemap }),
    },
  );
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  return `HTTP ${res.status}`;
}

async function sweepSite(env: Env, site: Site): Promise<SiteResult> {
  const r: SiteResult = { host: site.host, urls: 0, indexnow: "-", bing: "-", erro: null };
  const erros: string[] = [];
  let urls: string[] = [];
  try {
    urls = await sitemapUrls(site);
    r.urls = urls.length;
  } catch (e) {
    erros.push(`sitemap: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (urls.length) {
    try {
      r.indexnow = await pingIndexNow(site, urls);
    } catch (e) {
      erros.push(`indexnow: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    r.bing = await resubmitBingSitemap(env, site);
  } catch (e) {
    erros.push(`bing: ${e instanceof Error ? e.message : String(e)}`);
  }
  r.erro = erros.length ? erros.join(" | ") : null;
  return r;
}

async function runSweep(env: Env, origem: string): Promise<SiteResult[]> {
  const resultados: SiteResult[] = [];
  for (const site of SITES) {
    resultados.push(await sweepSite(env, site));
  }
  console.log(`citado-indexer sweep (${origem}):`, JSON.stringify(resultados));
  return resultados;
}

export default {
  fetch: async (req: Request, env: Env): Promise<Response> => {
    const url = new URL(req.url);
    // disparo manual protegido: GET /run?token=<RUN_TOKEN>
    if (url.pathname === "/run") {
      if (!env.RUN_TOKEN || url.searchParams.get("token") !== env.RUN_TOKEN.trim()) {
        return new Response("nao-autorizado", { status: 401 });
      }
      const resultados = await runSweep(env, "manual");
      return Response.json({ ok: true, quando: new Date().toISOString(), resultados });
    }
    return new Response(
      `citado-indexer central — ${SITES.length} site(s) na varredura semanal (varredura semanal no GitHub Actions; aqui só o disparo manual /run)\n`,
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },

  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(runSweep(env, "cron"));
  },
};
