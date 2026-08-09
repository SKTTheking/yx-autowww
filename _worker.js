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

// 自动模式的亚洲回退顺序：不再回退美国节点。
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

async function detectOriginRegion(domain, env, manualOriginIP = '') {
  // 公开给别人使用时，可手动填写真实源站 IP；填写后优先使用它，不需要对方提供 Cloudflare Token。
  const suppliedIP = String(manualOriginIP || '').trim();
  const originIP = suppliedIP || await fetchOriginIP(domain, env);
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

function extractDataCell(row, label) {
  const safe = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<td[^>]*data-label=["']${safe}["'][^>]*>([\\s\\S]*?)<\\/td>`, 'i');
  const m = row.match(re);
  return m ? cleanCell(m[1]) : '';
}

// 只读取 WeTest 当前实时优选页，不再使用历史数据中心 IP。
// preferredISPs 为空时表示允许跨运营商取当前仍在线的亚洲候选。
async function fetchLiveCandidates(regions, preferredISPs = []) {
  const wantedColos = new Set(
    regions.flatMap(region => REGION_COLOS[region] || []).map(x => String(x).toUpperCase())
  );
  if (!wantedColos.size) return [];

  try {
    const res = await fetchWithTimeout('https://www.wetest.vip/page/cloudflare/address_v4.html', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, 4500);
    if (!res.ok) return [];
    const html = await res.text();
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const out = [];

    for (const row of rows) {
      const isp = extractDataCell(row, '线路名称');
      const ip = extractDataCell(row, '优选地址');
      const colo = extractDataCell(row, '数据中心').toUpperCase();
      if (!isp || !isIPv4(ip) || !wantedColos.has(colo)) continue;
      if (preferredISPs.length && !preferredISPs.includes(isp)) continue;
      out.push({ isp, ip, colo, live: true });
    }

    const rank = new Map();
    regions.forEach((region, index) => {
      for (const colo of REGION_COLOS[region] || []) rank.set(colo, index);
    });
    out.sort((a, b) => (rank.get(a.colo) ?? 999) - (rank.get(b.colo) ?? 999));

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

function utf8ToBytes(s) {
  return unescape(encodeURIComponent(s));
}

function bytesToUtf8(s) {
  try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
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

// 过滤外部优选源中混入的推广/广告节点。
function isBlockedPromotionalLink(link) {
  const raw = String(link || '');
  const lower = raw.toLowerCase();
  const name = decodeName(raw).toLowerCase();

  if (name.includes('加入频道') || name.includes('kejiland00')) return true;
  if (lower.includes('saas.sin.fan') || lower.includes('kejiland00')) return true;

  if (raw.startsWith('vmess://')) {
    try {
      const obj = JSON.parse(bytesToUtf8(atob(raw.slice(8))));
      const host = String(obj.add || '').toLowerCase();
      const ps = String(obj.ps || '').toLowerCase();
      if (host === 'saas.sin.fan' || ps.includes('加入频道') || ps.includes('kejiland00')) return true;
    } catch (_) {}
  }

  return false;
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

function buildCandidateLinks(baseLinks, candidates) {
  const cleanBaseLinks = baseLinks.filter(link => !isBlockedPromotionalLink(link));
  const native = cleanBaseLinks.filter(isNative);
  const generated = [];

  for (const candidate of candidates) {
    let templates = cleanBaseLinks.filter(link => !isNative(link) && linkISP(link) === candidate.isp);
    if (!templates.length) templates = cleanBaseLinks.filter(link => !isNative(link));

    const uniqueTemplateKinds = new Map();
    for (const t of templates) {
      const name = decodeName(t);
      const kind = t.startsWith('vmess://')
        ? `vmess|${name.includes('-80-') ? '80' : 'tls'}`
        : `${t.split('://')[0]}|${(t.match(/:(\d+)\?/) || [])[1] || ''}`;
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

function filteredBase64Response(baseResponse, links) {
  const headers = new Headers(baseResponse.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-YX-Promo-Filter', 'enabled');
  return new Response(encodeSubscription(links.filter(link => !isBlockedPromotionalLink(link))), {
    status: baseResponse.status,
    headers
  });
}

async function regionalizeSubscription(request, env, baseResponse) {
  if (!baseResponse.ok) return baseResponse;
  const url = new URL(request.url);
  const requested = normalizeRegion(url.searchParams.get('region'));

  const body = await baseResponse.text();
  let links = decodeSubscription(body);
  if (!links.length) return new Response(body, baseResponse);

  links = links.filter(link => !isBlockedPromotionalLink(link));

  if (requested === 'all') {
    return filteredBase64Response(baseResponse, links);
  }

  let selected = requested;
  if (requested === 'auto') {
    const domain = url.searchParams.get('domain');
    const manualOriginIP = url.searchParams.get('originIP') || '';
    const detected = await detectOriginRegion(domain, env, manualOriginIP);
    selected = detected.region;
    if (selected === 'all') return filteredBase64Response(baseResponse, links);
  }

  const native = links.filter(isNative);
  const fallbackOrder = REGION_FALLBACKS[selected] || [selected];

  // 1) 先用原项目已经抓到的当前实时节点。
  for (const region of fallbackOrder) {
    const live = links.filter(link => !isNative(link) && hasRegionColo(link, region));
    if (live.length) {
      const out = [...native, ...live];
      const headers = new Headers(baseResponse.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-YX-Region', region);
      headers.set('X-YX-Region-Source', 'live-base');
      headers.set('X-YX-Promo-Filter', 'enabled');
      return new Response(encodeSubscription(out), { status: baseResponse.status, headers });
    }
  }

  const selectedISPs = enabledISPs(url);

  // 2) 再读取 WeTest 当前实时页，先尊重用户选择的运营商。
  const sameISPLive = await fetchLiveCandidates(fallbackOrder, selectedISPs);
  if (sameISPLive.length) {
    const firstColo = sameISPLive[0].colo;
    const firstRegion = fallbackOrder.find(r => (REGION_COLOS[r] || []).includes(firstColo)) || selected;
    const candidates = sameISPLive.filter(x => (REGION_COLOS[firstRegion] || []).includes(x.colo));
    const out = buildCandidateLinks(links, candidates);
    if (out.length > native.length) {
      const headers = new Headers(baseResponse.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-YX-Region', firstRegion);
      headers.set('X-YX-Region-Source', 'wetest-live-same-isp');
      headers.set('X-YX-Promo-Filter', 'enabled');
      return new Response(encodeSubscription(out), { status: baseResponse.status, headers });
    }
  }

  // 3) 所选运营商没有亚洲实时节点时，允许跨运营商使用当前实时亚洲 IP。
  const anyISPLive = await fetchLiveCandidates(fallbackOrder, []);
  if (anyISPLive.length) {
    const firstColo = anyISPLive[0].colo;
    const firstRegion = fallbackOrder.find(r => (REGION_COLOS[r] || []).includes(firstColo)) || selected;
    const candidates = anyISPLive.filter(x => (REGION_COLOS[firstRegion] || []).includes(x.colo));
    const out = buildCandidateLinks(links, candidates);
    if (out.length > native.length) {
      const headers = new Headers(baseResponse.headers);
      headers.set('Cache-Control', 'no-store');
      headers.set('X-YX-Region', firstRegion);
      headers.set('X-YX-Region-Source', 'wetest-live-cross-isp');
      headers.set('X-YX-Promo-Filter', 'enabled');
      return new Response(encodeSubscription(out), { status: baseResponse.status, headers });
    }
  }

  // 4) 亚洲实时候选都没有时，只保留原生地址。
  if (native.length) {
    const headers = new Headers(baseResponse.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-YX-Region', selected);
    headers.set('X-YX-Region-Source', 'native-only');
    headers.set('X-YX-Promo-Filter', 'enabled');
    return new Response(encodeSubscription(native), { status: baseResponse.status, headers });
  }

  return filteredBase64Response(baseResponse, links);
}

async function customizePublicPage(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();

  // 在“域名”下面加入可选真实源站 IP。别人使用自己的橙云域名时可手动填写。
  const domainBlock = `            <div class="form-group">\n                <label>域名</label>\n                <input type="text" id="domain" placeholder="请输入您的域名">\n            </div>`;
  const originBlock = `${domainBlock}\n            \n            <div class="form-group">\n                <label>真实源站 IP（可选）</label>\n                <input type="text" id="originIP" placeholder="例如：203.0.113.10">\n                <small style="display: block; margin-top: 6px; color: #86868b; font-size: 13px;">自己的 Cloudflare 域名可留空自动检测；其他人的橙云域名请填写真实服务器 IP。</small>\n            </div>`;
  if (html.includes(domainBlock) && !html.includes('id="originIP"')) {
    html = html.replace(domainBlock, originBlock);
  }

  // 生成订阅链接时读取手动源站 IP。
  const regionLine = `            const preferredRegion = document.getElementById('preferredRegion')?.value || 'auto';`;
  if (html.includes(regionLine) && !html.includes("document.getElementById('originIP')")) {
    html = html.replace(regionLine, `${regionLine}\n            const originIP = document.getElementById('originIP')?.value.trim() || '';`);
  }

  // 把手动源站 IP 加到订阅 URL。后端会优先按这个 IP 判断地区。
  const expireLine = `            if (expireParam) subscriptionUrl += expireParam;`;
  if (html.includes(expireLine) && !html.includes("subscriptionUrl += '&originIP='")) {
    html = html.replace(expireLine, `            if (originIP) subscriptionUrl += '&originIP=' + encodeURIComponent(originIP);\n${expireLine}`);
  }

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('Content-Length');
  const modified = new Response(html, { status: response.status, headers });

  // 同时删除页面底部原作者 footer。
  return new HTMLRewriter()
    .on('.footer', {
      element(element) {
        element.remove();
      }
    })
    .transform(modified);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isSub = /^\/[^/]+\/sub$/.test(url.pathname);

    if (!isSub) {
      const pageResponse = await baseWorker.fetch(request, env, ctx);
      return customizePublicPage(pageResponse);
    }

    // 原项目继续负责有效期、协议、TLS/ECH、客户端格式等全部既有功能。
    const baseResponse = await baseWorker.fetch(request, env, ctx);

    // 外部订阅转换器最终会回取这个原生订阅，因此这里只处理原生 base64 订阅。
    if (url.searchParams.has('target')) return baseResponse;
    return regionalizeSubscription(request, env, baseResponse);
  }
};