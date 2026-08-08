import baseWorker from './worker_base.js';

const REGION_COLOS = {
  jp: ['NRT', 'KIX', 'FUK', 'OKA'],
  hk: ['HKG'],
  sg: ['SIN'],
  kr: ['ICN'],
  tw: ['TPE']
};

const COUNTRY_TO_REGION = {
  JP: 'jp', HK: 'hk', SG: 'sg', KR: 'kr', TW: 'tw'
};

const REGION_FALLBACKS = {
  jp: ['jp', 'hk', 'sg'],
  hk: ['hk', 'jp', 'sg'],
  sg: ['sg', 'hk', 'jp'],
  kr: ['kr', 'jp', 'hk', 'sg'],
  tw: ['tw', 'hk', 'jp', 'sg']
};

const ISP_FLAGS = [
  { name: '移动', param: 'ispMobile' },
  { name: '联通', param: 'ispUnicom' },
  { name: '电信', param: 'ispTelecom' }
];

function normalizeRegion(value) {
  const v = String(value || 'all').trim().toLowerCase();
  return ['auto', 'all', 'jp', 'hk', 'sg', 'kr', 'tw'].includes(v) ? v : 'all';
}

async function fetchWithTimeout(resource, options = {}, timeout = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOriginIP(domain, env) {
  const zoneId = env?.CF_ZONE_ID;
  const token = env?.CF_API_TOKEN;
  if (!zoneId || !token || !domain) return null;

  let name = String(domain).trim().toLowerCase().replace(/\.$/, '');
  for (let i = 0; i < 3 && name; i++) {
    try {
      const endpoint = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`;
      const res = await fetchWithTimeout(endpoint, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.success || !Array.isArray(data.result)) return null;
      const records = data.result.filter(r => String(r.name || '').toLowerCase().replace(/\.$/, '') === name);
      const a = records.find(r => r.type === 'A' && r.content);
      if (a) return String(a.content).trim();
      const aaaa = records.find(r => r.type === 'AAAA' && r.content);
      if (aaaa) return String(aaaa.content).trim();
      const cname = records.find(r => r.type === 'CNAME' && r.content);
      if (!cname) return null;
      name = String(cname.content).trim().toLowerCase().replace(/\.$/, '');
    } catch (_) {
      return null;
    }
  }
  return null;
}

async function detectOriginRegion(domain, env) {
  const originIP = await fetchOriginIP(domain, env);
  if (!originIP) return { region: 'all', originIP: null };
  try {
    const res = await fetchWithTimeout(
      `https://ipwho.is/${encodeURIComponent(originIP)}?fields=success,country_code`,
      { headers: { 'User-Agent': 'yx-autowww-region-wrapper' } },
      3500
    );
    if (!res.ok) return { region: 'all', originIP };
    const geo = await res.json();
    if (geo?.success === false) return { region: 'all', originIP };
    const cc = String(geo?.country_code || '').toUpperCase();
    return { region: COUNTRY_TO_REGION[cc] || 'all', originIP };
  } catch (_) {
    return { region: 'all', originIP };
  }
}

function enabledISPs(url) {
  return ISP_FLAGS.filter(x => url.searchParams.get(x.param) !== 'no').map(x => x.name);
}

function cleanCell(v) {
  return String(v || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

function isIPv4(ip) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  return ip.split('.').every(x => Number(x) >= 0 && Number(x) <= 255);
}

async function fetchHistoricalCandidates(region, isps) {
  const allowed = REGION_COLOS[region] || [];
  if (!allowed.length) return [];
  try {
    const res = await fetchWithTimeout('https://www.wetest.vip/page/cloudflare/colo.html', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, 4500);
    if (!res.ok) return [];
    const html = await res.text();
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const out = [];

    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => cleanCell(m[1]));
      if (cells.length < 7) continue;
      const colo = String(cells[0] || '').toUpperCase();
      if (!allowed.includes(colo)) continue;
      const candidates = [
        { isp: '移动', ip: cells[4] },
        { isp: '联通', ip: cells[5] },
        { isp: '电信', ip: cells[6] }
      ];
      for (const c of candidates) {
        const ip = cleanCell(c.ip);
        if (isps.includes(c.isp) && isIPv4(ip)) out.push({ ...c, ip, colo });
      }
    }

    const seen = new Set();
    return out.filter(x => {
      const key = `${x.isp}|${x.ip}|${x.colo}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (_) {
    return [];
  }
}

function decodeName(link) {
  if (link.startsWith('vmess://')) {
    try {
      const json = JSON.parse(bytesToUtf8(atob(link.slice(8))));
      return String(json.ps || '');
    } catch (_) { return ''; }
  }
  const i = link.indexOf('#');
  if (i < 0) return '';
  try { return decodeURIComponent(link.slice(i + 1)); } catch (_) { return link.slice(i + 1); }
}

function isNative(link) {
  return decodeName(link).includes('原生地址');
}

function hasRegionColo(link, region) {
  const name = decodeName(link);
  return (REGION_COLOS[region] || []).some(c => name.includes(`-${c}-`));
}

function linkISP(link) {
  const name = decodeName(link);
  for (const isp of ['移动', '联通', '电信']) {
    if (name.startsWith(`${isp}-`) || name.includes(`${isp}-`)) return isp;
  }
  return '';
}

function replaceRemark(name, isp, colo) {
  const prefix = `${isp}-`;
  const start = name.indexOf(prefix);
  const source = start >= 0 ? name.slice(start) : name;
  const m = source.match(/^(移动|联通|电信)-[^-]+-(.+)$/);
  if (m) return `${isp}-${colo}-${m[2]}`;
  return `${isp}-${colo}-${source || '443-WS-TLS'}`;
}

function rewriteURI(link, candidate) {
  const hash = link.indexOf('#');
  const main = hash >= 0 ? link.slice(0, hash) : link;
  const oldName = decodeName(link);
  const rewritten = main.replace(/@(\[[^\]]+\]|[^:@/?#]+):(\d+)\?/, `@${candidate.ip}:$2?`);
  const newName = replaceRemark(oldName, candidate.isp, candidate.colo);
  return `${rewritten}#${encodeURIComponent(newName)}`;
}

function utf8ToBytes(s) {
  return unescape(encodeURIComponent(s));
}

function bytesToUtf8(s) {
  try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
}

function rewriteVMess(link, candidate) {
  try {
    const obj = JSON.parse(bytesToUtf8(atob(link.slice(8))));
    obj.add = candidate.ip;
    obj.ps = replaceRemark(String(obj.ps || ''), candidate.isp, candidate.colo);
    return `vmess://${btoa(utf8ToBytes(JSON.stringify(obj)))}`;
  } catch (_) {
    return null;
  }
}

function buildHistoricalLinks(baseLinks, candidates) {
  const native = baseLinks.filter(isNative);
  const generated = [];
  for (const candidate of candidates) {
    let templates = baseLinks.filter(link => !isNative(link) && linkISP(link) === candidate.isp);
    if (!templates.length) templates = baseLinks.filter(link => !isNative(link));
    const uniqueTemplateKinds = new Map();
    for (const t of templates) {
      const name = decodeName(t);
      const kind = t.startsWith('vmess://') ? `vmess|${name.includes('-80-') ? '80' : 'tls'}` :
        `${t.split('://')[0]}|${(t.match(/:(\d+)\?/) || [])[1] || ''}`;
      if (!uniqueTemplateKinds.has(kind)) uniqueTemplateKinds.set(kind, t);
    }
    for (const t of uniqueTemplateKinds.values()) {
      const rewritten = t.startsWith('vmess://') ? rewriteVMess(t, candidate) : rewriteURI(t, candidate);
      if (rewritten) generated.push(rewritten);
    }
  }
  return [...native, ...generated];
}

function decodeSubscription(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    return atob(trimmed).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function encodeSubscription(links) {
  return btoa(links.join('\n'));
}

async function regionalizeSubscription(request, env, baseResponse) {
  if (!baseResponse.ok) return baseResponse;
  const url = new URL(request.url);
  const requested = normalizeRegion(url.searchParams.get('region'));
  if (requested === 'all') return baseResponse;

  let selected = requested;
  if (requested === 'auto') {
    const domain = url.searchParams.get('domain');
    const detected = await detectOriginRegion(domain, env);
    selected = detected.region;
    if (selected === 'all') return baseResponse;
  }

  const body = await baseResponse.text();
  const links = decodeSubscription(body);
  if (!links.length) return new Response(body, baseResponse);

  const native = links.filter(isNative);
  const fallbackOrder = REGION_FALLBACKS[selected] || [selected];

  // 第一优先：使用当前实时优选列表中已经命中目标/邻近地区的节点。
  for (const region of fallbackOrder) {
    const live = links.filter(link => !isNative(link) && hasRegionColo(link, region));
    if (live.length) {
      const out = [...native, ...live];
      const headers = new Headers(baseResponse.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-YX-Region', region);
      headers.set('X-YX-Region-Source', 'live');
      return new Response(encodeSubscription(out), { status: baseResponse.status, headers });
    }
  }

  // 实时列表没有时，按 日本→香港→新加坡（或当前地区优先）读取 WeTest 历史地区候选。
  const isps = enabledISPs(url);
  for (const region of fallbackOrder) {
    const candidates = await fetchHistoricalCandidates(region, isps);
    if (!candidates.length) continue;
    const out = buildHistoricalLinks(links, candidates);
    if (out.length > native.length) {
      const headers = new Headers(baseResponse.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-YX-Region', region);
      headers.set('X-YX-Region-Source', 'wetest-history');
      return new Response(encodeSubscription(out), { status: baseResponse.status, headers });
    }
  }

  // 严格禁止自动回退到美国 LAX/SJC：只保留原生节点，避免误导成“日本优选”。
  if (native.length) {
    const headers = new Headers(baseResponse.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-YX-Region', selected);
    headers.set('X-YX-Region-Source', 'native-only');
    return new Response(encodeSubscription(native), { status: baseResponse.status, headers });
  }
  return baseResponse;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isSub = /^\/[^/]+\/sub$/.test(url.pathname);
    if (!isSub) return baseWorker.fetch(request, env, ctx);

    // 先让原项目继续负责有效期、协议、TLS/ECH、客户端格式等全部既有功能。
    const baseResponse = await baseWorker.fetch(request, env, ctx);

    // 只有原生 base64 订阅需要在这里做地区筛选；外部订阅转换器最终也会来取这个地址。
    if (url.searchParams.has('target')) return baseResponse;
    return regionalizeSubscription(request, env, baseResponse);
  }
};
