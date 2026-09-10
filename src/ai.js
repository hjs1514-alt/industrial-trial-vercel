/* 서버 중계 함수에만 말을 겁니다. API 키는 이 파일에 없습니다. */

export async function ask(payload, passcode) {
  const r = await fetch("/api/trial", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, passcode }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data.text;
}

/* 한 번 더 시도해 보고 그래도 안 되면 포기합니다. */
export async function askTwice(payload, passcode) {
  try {
    return await ask(payload, passcode);
  } catch (e) {
    if (String(e.message).includes("암호")) throw e;
    await new Promise((s) => setTimeout(s, 1500));
    return await ask(payload, passcode);
  }
}
