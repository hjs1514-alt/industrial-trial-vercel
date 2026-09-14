import { buildSystem, buildPrompt, ROLES, WITNESS_PERSONA } from "./_prompts.js";

/* ============================================================
   브라우저 → 이 함수 → OpenAI
   API 키는 이 파일 밖으로 나가지 않습니다.
   프롬프트도 서버에서 조립하므로, 학생이 요청을 조작해
   이 앱을 일반 챗봇으로 바꿔 쓸 수 없습니다.

   응답은 스트리밍입니다. OpenAI가 글자를 만들어 내는 대로
   한 줄에 JSON 하나씩(NDJSON) 브라우저로 흘려보냅니다.
     {"t":"글자 조각"}   본문 조각
     {"done":true}       끝
     {"error":"..."}     중간에 실패
   요청마다 스트림을 따로 만들고 전역 상태를 공유하지 않으므로
   학생 서른 명이 동시에 받아도 서로 섞이지 않습니다.
   ============================================================ */

const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const KEY = process.env.OPENAI_API_KEY;
const PASSCODE = process.env.TRIAL_PASSCODE || "";
const ENDPOINT = "https://api.openai.com/v1/chat/completions";

/* 폭주를 막는 브레이크.
   학교 와이파이에서는 한 반 전체가 바깥에서 같은 공인 IP 하나로 보입니다.
   그래서 IP 하나를 학생 한 명으로 치지 않고, 반 전체(30명 × 분당 4회)에
   여유를 두어 잡습니다. 대신 브라우저마다 스스로 만든 무작위 id 로
   한 기기의 폭주를 따로 막습니다.
   서버리스 인스턴스가 재활용될 때만 유지되므로 완벽한 방어는 아닙니다. */
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_IP = 240;       // 같은 공인 IP 전체 (학급 하나가 분당 90~120회를 써도 남습니다)
const MAX_PER_CLIENT = 15;    // 브라우저 하나 (학생 한 명이 분당 2~4회 + 재시도)

function tooMany(key, max) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 2000) hits.clear();
  return list.length > max;
}

const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const BUSY_MSG = "현재 여러 명이 동시에 재판에 참여하고 있습니다. 잠시 후 다시 시도합니다.";

export async function POST(request) {
  if (!KEY) return json(500, { error: "서버에 OPENAI_API_KEY 가 설정되지 않았습니다." });

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  if (!body || typeof body !== "object") body = {};

  /* 브라우저가 만든 무작위 id. 로그인이 아니라 폭주 방지용 꼬리표일 뿐입니다. */
  const client = clip(body.client, 64).replace(/[^\w-]/g, "") || ip;
  if (tooMany(`ip:${ip}`, MAX_PER_IP) || tooMany(`client:${client}`, MAX_PER_CLIENT)) {
    return json(429, { error: BUSY_MSG });
  }

  if (PASSCODE && body.passcode !== PASSCODE) {
    return json(401, { error: "입장 암호가 올바르지 않습니다." });
  }

  const { role } = body;
  if (!ROLES.includes(role)) return json(400, { error: "알 수 없는 역할입니다." });

  /* 클라이언트가 보낸 값을 그대로 믿지 않고 형태와 길이를 잘라 냅니다. */
  const side = body.side === "prosecution" ? "prosecution" : "defense";
  const aiSide = side === "prosecution" ? "defense" : "prosecution";
  const witnessId = WITNESS_PERSONA[body.witnessId] ? body.witnessId : null;

  if ((role === "witness" || role === "ai_cross") && !witnessId) {
    return json(400, { error: "증인이 지정되지 않았습니다." });
  }

  const ctx = {
    aiSide,
    witnessId,
    question: clip(body.question, 1200),
    witnessLog: clip(body.witnessLog, 6000),
    record: clip(body.record, 12000),
  };

  /* 앞선 문답은 필요한 만큼만 받습니다. 브라우저가 단계별로 골라 보내고,
     여기서도 마지막 16개, 한 개 1500자로 자릅니다. */
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

  /* OpenAI 에 연결합니다. 여기서 실패하면 아직 아무것도 보내지 않았으므로
     상태 코드로 알리고, 다시 시도할지는 브라우저가 정합니다(간격을 두고). */
  let upstream;
  try {
    upstream = await openStream(messages, request.signal);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith("429")) return json(429, { error: BUSY_MSG });
    if (msg.startsWith("401")) return json(500, { error: "API 키가 올바르지 않습니다. 선생님께 알려 주세요." });
    if (msg.startsWith("4")) return json(502, { error: "요청을 만들지 못했습니다. 다시 시도해 주세요." });
    return json(502, { error: "법정 기록을 불러오지 못했습니다. 다시 시도해 주세요." });
  }

  return new Response(relay(upstream.body), {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/* 모델 세대에 따라 받아들이는 파라미터 이름이 다릅니다.
   거절당하면 문제되는 항목을 하나씩 빼고 다시 부릅니다. (실패 재시도가 아니라
   호환성 확인이며, 본문이 시작되기 전에만 일어납니다.)
   덕분에 OPENAI_MODEL 을 바꿔도 코드를 고칠 일이 거의 없습니다. */
async function openStream(messages, signal, opts = { tokenKey: "max_completion_tokens", temp: true }) {
  const payload = { model: MODEL, messages, stream: true };
  payload[opts.tokenKey] = 1000;
  if (opts.temp) payload.temperature = 0.7;  // 논리를 잇는 말이라 너무 높이지 않습니다

  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(payload),
    signal,
  });

  if (r.status === 400) {
    const detail = await r.text();
    if (detail.includes("max_completion_tokens") && opts.tokenKey === "max_completion_tokens") {
      return openStream(messages, signal, { ...opts, tokenKey: "max_tokens" });
    }
    if (detail.includes("temperature") && opts.temp) {
      return openStream(messages, signal, { ...opts, temp: false });
    }
    throw new Error("400 " + detail.slice(0, 200));
  }
  if (!r.ok || !r.body) throw new Error(String(r.status));
  return r;
}

/* OpenAI 의 SSE(`data: {...}` 줄들)를 읽어 본문 조각만 NDJSON 으로 바꿉니다. */
function relay(source) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const line = (obj) => enc.encode(JSON.stringify(obj) + "\n");

  return new ReadableStream({
    async start(controller) {
      /* 학생이 창을 닫아 이미 끊긴 스트림에 쓰면 예외가 나므로 감쌉니다. */
      const push = (obj) => { try { controller.enqueue(line(obj)); return true; } catch (e) { return false; } };
      const reader = source.getReader();
      let buf = "";
      let sent = 0;
      let finished = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const raw of lines) {
            const l = raw.trim();
            if (!l.startsWith("data:")) continue;
            const data = l.slice(5).trim();
            if (data === "[DONE]") { finished = true; break; }
            let ev;
            try { ev = JSON.parse(data); } catch (e) { continue; }
            if (ev.error) throw new Error(ev.error.message || "upstream error");
            const t = ev.choices?.[0]?.delta?.content;
            if (t) { sent += t.length; if (!push({ t })) throw new Error("client gone"); }
            if (ev.choices?.[0]?.finish_reason) finished = true;
          }
          if (finished) break;
        }
        if (sent === 0) throw new Error("빈 응답");
        push({ done: true });
      } catch (e) {
        /* 이미 200으로 시작했으므로 상태 코드 대신 마지막 줄로 알립니다.
           브라우저는 받은 만큼은 남기고, 자동으로 다시 붙이지 않습니다. */
        push({ error: "AI 응답이 중간에 중단되었습니다." });
      } finally {
        try { await reader.cancel(); } catch (e) {}
        try { controller.close(); } catch (e) {}
      }
    },
  });
}
