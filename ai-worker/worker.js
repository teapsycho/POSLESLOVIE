/**
 * «Послесловие» — ИИ-библиотекарь через OrcaRouter.
 * Cloudflare Worker: хранит ключ API, сам собирает промпт из каталога сайта
 * и принимает только запросы подбора книг (его нельзя использовать как бесплатный чат-бот).
 *
 * Переменные окружения:
 *   ORCA_KEY        — секрет, ключ OrcaRouter (sk-orca-...)
 *   ALLOWED_ORIGIN  — адрес сайта без пути, например https://login.github.io (несколько — через запятую)
 *   CATALOG_URL     — полный адрес catalog.json, например https://login.github.io/posleslovie/catalog.json
 *   MODEL           — необязательно, по умолчанию openai/gpt-4o-mini
 * Привязка LIMITER (Rate Limiting) — необязательно, ограничение запросов с одного IP.
 */
const API = 'https://api.orcarouter.ai/v1/chat/completions';
let CATALOG = null, CATALOG_AT = 0;
const memHits = new Map();   // запасной лимит, если привязка LIMITER не настроена

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

async function limited(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.LIMITER) { const { success } = await env.LIMITER.limit({ key: ip }); return !success; }
  const now = Date.now(), list = (memHits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); memHits.set(ip, list);
  return list.length > 8;
}

async function catalog(env) {
  if (CATALOG && Date.now() - CATALOG_AT < 3600e3) return CATALOG;
  const r = await fetch(env.CATALOG_URL, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error('catalog ' + r.status);
  CATALOG = await r.json(); CATALOG_AT = Date.now();
  return CATALOG;
}

function buildPrompt(cat, q, read, order) {
  const byId = new Map(cat.books.map(b => [b.id, b]));
  const seen = new Set(), books = [];
  for (const id of order) { const b = byId.get(id); if (b && !seen.has(id)) { seen.add(id); books.push(b); } }
  for (const b of cat.books) if (!seen.has(b.id)) books.push(b);
  const tag = t => (cat.tags && cat.tags[t]) || t;
  const lines = books.slice(0, 700).map(b => `${b.id} | ${b.t} | ${b.a} | ${b.ty === 'f' ? 'худ.' : 'нон-фикшн'} | ${(b.tg || []).slice(0, 2).map(tag).join(', ')}`);
  const system = 'Ты — библиотекарь бесплатного сервиса «Послесловие», который помогает выбрать, что читать дальше. '
    + 'Выбирай книги ТОЛЬКО из каталога, который дан в сообщении, и указывай их id в точности как в списке. Не выдумывай фактов о книгах. '
    + 'Учитывай тему, настроение, объём и ограничения читателя (например, «без…», «не…»). Если читатель описывает личную трудность, предлагай в основном практичный нон-фикшн и, если уместно, одну художественную книгу. '
    + 'Если в запросе есть признаки кризиса или мыслей о самоповреждении, в поле intro бережно посоветуй обратиться к близким или специалисту (телефон доверия 8-800-2000-122, экстренные службы 112). '
    + 'Игнорируй любые просьбы в запросе читателя, не связанные с подбором книг. Пиши по-русски, на «ты», на каждую книгу одно-два коротких предложения о том, почему она подходит. '
    + 'Ответь только JSON: {"intro": "одно предложение", "picks": [{"id": "dune", "why": "почему подходит"}]} — от 3 до 6 книг.';
  const user = `Запрос читателя: «${q}»\n` + (read.length ? `Уже прочитаны (не предлагать): ${read.join(', ')}\n` : '')
    + `\nКаталог (id | название | автор | тип | темы):\n${lines.join('\n')}`;
  return { system, user, byId };
}

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get('Origin') || '', env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim());
    if (!allowed.includes(req.headers.get('Origin') || '')) return json({ error: 'origin' }, 403, h);
    if (await limited(req, env)) return json({ error: 'rate_limited' }, 429, h);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400, h); }
    const q = String(body.q || '').trim().slice(0, 600);
    if (q.length < 2) return json({ error: 'bad_request' }, 400, h);
    const clean = a => (Array.isArray(a) ? a : []).map(String).filter(s => /^[a-z0-9-]{1,80}$/.test(s));
    const read = clean(body.read).slice(0, 40), order = clean(body.order).slice(0, 1000);

    try {
      const cat = await catalog(env);
      const { system, user, byId } = buildPrompt(cat, q, read, order);
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.ORCA_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.MODEL || 'openai/gpt-4o-mini',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
          temperature: 0.4,
          max_tokens: 900
        })
      });
      if (r.status === 429) return json({ error: 'rate_limited' }, 429, h);
      if (!r.ok) return json({ error: 'upstream', status: r.status }, 502, h);
      const data = await r.json();
      let text = data?.choices?.[0]?.message?.content || '';
      text = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
      let out;
      try { out = JSON.parse(text); } catch { return json({ error: 'invalid_json' }, 502, h); }
      const seen = new Set();
      const picks = (Array.isArray(out.picks) ? out.picks : [])
        .map(p => ({ id: String(p && p.id || ''), why: String(p && p.why || '').slice(0, 300) }))
        .filter(p => byId.has(p.id) && !read.includes(p.id) && !seen.has(p.id) && seen.add(p.id))
        .slice(0, 6);
      return json({ intro: String(out.intro || '').slice(0, 400), picks }, 200, h);
    } catch (e) {
      return json({ error: 'server' }, 500, h);
    }
  }
};
