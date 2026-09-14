/* 서버 중계 함수에만 말을 겁니다. API 키는 이 파일에 없습니다.

   서버는 답을 한 줄에 JSON 하나씩(NDJSON) 흘려보냅니다.
     {"t":"글자 조각"} / {"done":true} / {"error":"..."}
   여기서는 그것을 읽어 조각이 올 때마다 onChunk 로 넘기고,
   끝나면 완성된 글 전체를 돌려줍니다. */

/* 브라우저마다 한 번 만들어 두는 무작위 꼬리표.
   로그인이 아니라, 서버가 한 기기의 폭주를 따로 막기 위한 것입니다.
   학교 와이파이에서는 반 전체가 같은 IP 로 보여서 IP 만으로는 구분할 수 없습니다. */
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem("trial-client");
    if (!id) {
      id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36))
        .replace(/-/g, "");
      localStorage.setItem("trial-client", id);
    }
    return id;
  } catch (e) { return "anon"; }
})();

const FIRST_BYTE_MS = 20000;  // 응답이 시작될 때까지 기다리는 시간
const IDLE_MS = 15000;        // 스트리밍 중 새 조각이 오지 않아도 참는 시간

/* 실패 하나를 설명하는 오류.
   partial   — 끊기기 전까지 받은 글. 있으면 자동으로 다시 시도하지 않습니다.
   retryable — 응답이 시작되기 전에 난 실패라 잠시 뒤 다시 시도해도 되는가. */
export class TrialError extends Error {
  constructor(message, { status = 0, partial = "", retryable = false } = {}) {
    super(message);
    this.status = status;
    this.partial = partial;
    this.retryable = retryable;
  }
}

const FRIENDLY = {
  429: "현재 여러 명이 동시에 재판에 참여하고 있습니다. 잠시 후 다시 시도합니다.",
  401: "입장 암호가 올바르지 않습니다.",
};

/* 한 번 묻고 스트리밍으로 받습니다. */
export async function askStream(payload, passcode, { onChunk, signal } = {}) {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onOuterAbort);

  let timer = null;
  let timedOut = false;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  };

  let text = "";
  try {
    arm(FIRST_BYTE_MS);
    const r = await fetch("/api/trial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, passcode, client: CLIENT_ID }),
      signal: ctrl.signal,
    });

    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const retryable = r.status === 429 || r.status === 408 || r.status >= 500;
      throw new TrialError(FRIENDLY[r.status] || data.error || "요청에 실패했습니다.", { status: r.status, retryable });
    }
    if (!r.body) throw new TrialError("이 브라우저에서는 스트리밍을 받을 수 없습니다.", { status: r.status });

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = false;

    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
      arm(IDLE_MS);
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.t) { text += msg.t; onChunk?.(msg.t, text); }
        if (msg.error) throw new TrialError(msg.error, { partial: text, retryable: !text });
        if (msg.done) { done = true; break; }
      }
    }

    if (!done) throw new TrialError("AI 응답이 중간에 중단되었습니다.", { partial: text, retryable: !text });
    if (!text.trim()) throw new TrialError("AI 가 빈 답을 보냈습니다.", { retryable: true });
    return text;
  } catch (e) {
    if (e instanceof TrialError) throw e;
    if (signal?.aborted) throw new TrialError("취소되었습니다.", { partial: text });
    if (text) throw new TrialError("AI 응답이 중간에 중단되었습니다.", { partial: text });
    throw new TrialError(timedOut ? "AI 응답이 늦어지고 있습니다." : "연결에 실패했습니다.", { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 응답이 시작되기도 전에 실패하면 잠시 쉬었다가 다시 시도합니다.
   2초, 4초에 무작위 0~0.5초를 더합니다 — 서른 명이 같은 순간에 다시 몰리지 않게.
   글자가 한 조각이라도 온 뒤의 실패는 자동으로 다시 시도하지 않습니다.
   (같은 질문에 다른 답이 이어 붙는 일을 막기 위해 학생이 직접 다시 시도합니다.) */
const BACKOFF_MS = [2000, 4000];

export async function askWithRetry(payload, passcode, { onChunk, onWait, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await askStream(payload, passcode, { onChunk, signal });
    } catch (e) {
      if (signal?.aborted || !e.retryable || e.partial || attempt >= BACKOFF_MS.length) throw e;
      const wait = BACKOFF_MS[attempt] + Math.random() * 500;
      onWait?.(e, wait, attempt + 1);
      await sleep(wait);
      if (signal?.aborted) throw e;
    }
  }
}
