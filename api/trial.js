import { buildSystem, buildPrompt, ROLES, WITNESS_PERSONA } from "./_prompts.js";

/* ============================================================
   브라우저 → 이 함수 → OpenAI
   API 키는 이 파일 밖으로 나가지 않습니다.
   프롬프트도 서버에서 조립하므로, 학생이 요청을 조작해
   이 앱을 일반 챗봇으로 바꿔 쓸 수 없습니다.
   ============================================================ */

const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const KEY = process.env.OPENAI_API_KEY;
const PASSCODE = process.env.TRIAL_PASSCODE || "";
const ENDPOINT = "https://api.openai.com/v1/chat/completions";

/* 실수로 인한 폭주를 막는 브레이크입니다.
   서버리스 인스턴스가 재활용될 때만 유지되므로 완벽한 방어는 아닙니다. */
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;

function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 허용됩니다." });
  if (!KEY) return res.status(500).json({ error: "서버에 OPENAI_API_KEY 가 설정되지 않았습니다." });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (tooMany(ip)) {
    return res.status(429).json({ error: "잠시 뒤에 다시 시도해 주세요. 요청이 너무 빠릅니다." });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

  if (PASSCODE && body.passcode !== PASSCODE) {
    return res.status(401).json({ error: "입장 암호가 올바르지 않습니다." });
  }

  const { role } = body;
  if (!ROLES.includes(role)) return res.status(400).json({ error: "알 수 없는 역할입니다." });

  /* 클라이언트가 보낸 값을 그대로 믿지 않고 형태와 길이를 잘라 냅니다. */
  const side = body.side === "prosecution" ? "prosecution" : "defense";
  const aiSide = side === "prosecution" ? "defense" : "prosecution";
  const witnessId = WITNESS_PERSONA[body.witnessId] ? body.witnessId : null;

  if ((role === "witness" || role === "ai_cross") && !witnessId) {
    return res.status(400).json({ error: "증인이 지정되지 않았습니다." });
  }

  const ctx = {
    aiSide,
    witnessId,
    round: body.round === 2 ? 2 : 1,
    question: clip(body.question, 1200),
    witnessLog: clip(body.witnessLog, 6000),
    record: clip(body.record, 12000),
    trial: {
      side,
      opening: clip(body.trial?.opening, 2000),
      evidence: [0, 1, 2].map((i) => clip(body.trial?.evidence?.[i], 1000)),
    },
  };

  /* 증인과 피고인은 앞선 문답을 이어받아 인격을 유지합니다. */
  const messages = [{ role: "system", content: buildSystem(role, ctx) }];
  if (Array.isArray(body.history)) {
    for (const turn of body.history.slice(-16)) {
      messages.push({
        role: turn.role === "assistant" ? "assistant" : "user",
        content: clip(turn.text, 1500),
      });
    }
  }
  messages.push({ role: "user", content: buildPrompt(role, ctx) });

  try {
    const text = await callOpenAI(messages);
    return res.status(200).json({ text });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith("429")) {
      return res.status(429).json({ error: "지금 요청이 몰려 있습니다. 20초쯤 뒤에 다시 시도해 주세요." });
    }
    if (msg.startsWith("401")) {
      return res.status(500).json({ error: "API 키가 올바르지 않습니다. 선생님께 알려 주세요." });
    }
    return res.status(502).json({ error: "법정 기록을 불러오지 못했습니다. 다시 시도해 주세요." });
  }
}

/* 모델 세대에 따라 받아들이는 파라미터 이름이 다릅니다.
   거절당하면 문제되는 항목을 하나씩 빼고 다시 시도합니다.
   덕분에 OPENAI_MODEL 을 바꿔도 코드를 고칠 일이 거의 없습니다. */
async function callOpenAI(messages, attempt = 0, opts = { tokenKey: "max_completion_tokens", temp: true }) {
  const payload = { model: MODEL, messages };
  payload[opts.tokenKey] = 1000;
  if (opts.temp) payload.temperature = 0.7;  // 논리를 잇는 말이라 너무 높이지 않습니다

  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(payload),
  });

  if (r.status === 400) {
    const detail = await r.text();
    if (detail.includes("max_completion_tokens") && opts.tokenKey === "max_completion_tokens") {
      return callOpenAI(messages, attempt, { ...opts, tokenKey: "max_tokens" });
    }
    if (detail.includes("temperature") && opts.temp) {
      return callOpenAI(messages, attempt, { ...opts, temp: false });
    }
    throw new Error("400 " + detail.slice(0, 200));
  }

  if (r.status === 429 || r.status >= 500) {
    if (attempt < 2) {
      await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
      return callOpenAI(messages, attempt + 1, opts);
    }
    throw new Error(String(r.status));
  }
  if (!r.ok) throw new Error(String(r.status));

  const data = await r.json();
  const text = (data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("빈 응답");
  return text;
}
