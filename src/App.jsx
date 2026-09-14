import React, { useState, useEffect, useRef, useCallback } from "react";
import Courtroom, { Glossed } from "./Courtroom.jsx";
import { askWithRetry } from "./ai.js";
import {
  WITNESSES, witnessById, SEATS, other, JUDGE, DEFENDANT_LINES,
  GLOSSARY, PHASE_INFO, VERDICTS, TOTAL_SEC, WARN_SEC, TOTAL_MIN,
} from "./data.js";

const STORE = "trial-v3";
const MAX_WITNESS = 2;

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const longTime = (s) => `${Math.floor(s / 60)}분 ${Math.floor(s % 60)}초`;

/* turns: 재판에서 오간 모든 말.
   { who: "me" | "ai" | "witness" | "defendant", text, wid? } */
const blank = () => ({
  phase: "LOBBY",
  side: null,
  claim: "",
  ground: "",
  turns: [],
  witnesses: [],     // 부른 증인 id 목록
  wid: null,         // 지금 증인석에 선 증인
  wAsked: 0,         // 이 증인에게 내가 물은 횟수
  wFrom: 0,          // 이 증인이 선 뒤 오간 말이 시작되는 자리
  verdict: null,
  reasons: ["", ""],
  elapsed: 0,
  finishedAt: null,
  date: null,
  line: 0,           // 판사 대사에서 지금 몇 번째 줄인가
  base: 0,           // 이 단계에 들어올 때 오간 말의 수
  ack: 0,            // 여기까지의 말은 다 읽었다
});

export default function App() {
  const [s, setS] = useState(blank);
  const [booted, setBooted] = useState(false);
  const [resume, setResume] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState("");
  const [term, setTerm] = useState(null);
  const [pass, setPass] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [stream, setStream] = useState(null);   // 지금 흘러들어오는 AI 의 말 { who, wid, text, interrupted? }
  const [retry, setRetry] = useState(null);     // 실패한 요청을 같은 내용으로 다시 보내는 함수
  const abortRef = useRef(null);
  const running = useRef(false);
  const tail = useRef(null);
  const panelRef = useRef(null);

  /* 단계(또는 증인)가 바뀌면 판사 대사는 첫 줄부터, 기준점은 그 순간의 말 수로 맞춥니다. */
  const set = useCallback((p) => setS((o) => {
    const nx = { ...o, ...(typeof p === "function" ? p(o) : p) };
    if (nx.phase !== o.phase || nx.wid !== o.wid) { nx.line = 0; nx.base = nx.turns.length; }
    return nx;
  }), []);

  /* ── 저장과 타이머 ── */
  useEffect(() => {
    try {
      const r = localStorage.getItem(STORE);
      if (r) { const v = JSON.parse(r); if (v?.phase && v.phase !== "LOBBY") setResume(v); }
    } catch (e) {}
    setBooted(true);
  }, []);

  useEffect(() => {
    if (!booted || s.phase === "LOBBY") return;
    const t = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) {} }, 500);
    return () => clearTimeout(t);
  }, [s, booted]);

  useEffect(() => {
    if (s.phase === "LOBBY" || s.phase === "RECORD") return;
    const t = setInterval(() => setS((p) => ({ ...p, elapsed: p.elapsed + 1 })), 1000);
    return () => clearInterval(t);
  }, [s.phase]);

  useEffect(() => {
    if (showLog) tail.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [s.turns.length, showLog]);

  const overtime = s.elapsed >= TOTAL_SEC;
  const warning = s.elapsed >= WARN_SEC && !overtime;
  const info = PHASE_INFO[s.phase] || PHASE_INFO.LOBBY;

  /* ── 판사 대사 ──
     증인 신청 때의 대사는 증인 대기실 화면에 바로 적혀 있어서 여기서는 뺍니다. */
  const SCRIPT = {
    OPEN: JUDGE.open, IDENTIFY: JUDGE.identified, SEAT: JUDGE.seat, OPENING: JUDGE.opening,
    W_ASK: JUDGE.witnessAsk,
    CLOSING: JUDGE.closing, VERDICT: JUDGE.verdict, SENTENCE: JUDGE.sentence,
  };
  const script = SCRIPT[s.phase] || null;
  const playing = Boolean(script) && s.line < script.length;

  /* ── 대화창에 보일 한 줄 ──
     법정 그림 위의 자막에는 한 사람의 말만 보입니다. 순서는
     ① 아직 읽지 않은 말 → ② 판사 대사 → ③ 가장 최근 말(또는 판사의 마지막 말)입니다.
     내가 한 말은 따로 읽을 필요가 없어서 건너뜁니다. */
  const n = s.turns.length;
  const queueAt = (() => {
    let a = s.ack;
    while (a < n - 1 && s.turns[a].who === "me") a++;
    if (a >= n) return -1;                        // 다 읽었음
    if (a < n - 1) return a;                      // 뒤에 아직 읽지 않은 말이 있음
    if (playing && a < s.base) return a;          // 판사가 말하기 전에 먼저 읽어야 할 말
    return -1;
  })();

  const advanceJudge = () => {
    // 아직 남은 줄이 있으면 다음 줄로
    if (s.line < script.length - 1) { set({ line: s.line + 1 }); return; }
    // 개정 마지막 줄에서는 피고인이 이름을 답합니다
    if (s.phase === "OPEN") {
      set({
        turns: [{ who: "defendant", text: `${DEFENDANT_LINES.name} ${DEFENDANT_LINES.origin}` }],
        phase: "IDENTIFY",
      });
      return;
    }
    // 그 밖에는 대사를 닫고 아래 입력부를 엽니다
    set({ line: s.line + 1 });
    // 마지막 말 단계에서는 판사 말이 끝난 뒤에야 상대편·피고인의 말을 받습니다
    if (s.phase === "CLOSING" && s.turns.length <= s.base) startClosing();
  };

  const cue = (() => {
    if (stream)
      return { ...speaker({ who: stream.who, wid: stream.wid, text: stream.text }, s.side),
        streaming: !stream.interrupted, interrupted: Boolean(stream.interrupted) };
    if (queueAt >= 0 && (!playing || queueAt < s.base))
      return { ...speaker(s.turns[queueAt], s.side), next: () => set({ ack: queueAt + 1 }) };
    if (playing) return { who: "판사", cls: "judge", text: script[s.line], next: advanceJudge };
    if (script && n <= s.base)
      return { who: "판사", cls: "judge", text: script[script.length - 1] };
    if (n > 0) return speaker(s.turns[n - 1], s.side);
    return null;
  })();

  /* 입력부가 열려 있다는 것은 지금까지의 말을 다 읽었다는 뜻입니다. */
  const panelOpen = !playing && !busy && queueAt < 0;
  useEffect(() => {
    setStream((st) => (st?.interrupted ? null : st));
    setRetry(null);
  }, [s.phase]);
  useEffect(() => { if (panelOpen && s.ack !== n) set({ ack: n }); }, [panelOpen, n, s.ack, set]);
  useEffect(() => {
    if (panelOpen) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [panelOpen, s.phase]);

  /* ── AI 호출 ──
     AI 한 사람의 말을 스트리밍으로 받아 자막에 바로 흘립니다.
     성공하면 완성된 글을 돌려주고, 실패하면 null 을 돌려줍니다.
     끊기기 전까지 받은 글은 자막에 남기고(interrupted), 기록에는 넣지 않습니다. */
  const speak = async ({ who, wid = null, label, payload }) => {
    setErr(null);
    setRetry(null);
    setStream({ who, wid, text: "" });
    setBusy(label);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const text = await askWithRetry({ side: s.side, ...payload }, pass, {
        signal: ctrl.signal,
        onChunk: (_, all) => setStream((st) => (st ? { ...st, text: all } : st)),
        onWait: (e) => setBusy(e.status === 429
          ? "현재 여러 명이 동시에 재판에 참여하고 있습니다. 잠시 후 다시 시도합니다."
          : "연결이 고르지 않습니다. 잠시 후 다시 시도합니다."),
      });
      setStream(null);
      return text;
    } catch (e) {
      if (ctrl.signal.aborted) { setStream(null); return null; }
      setStream((st) => (st && st.text ? { ...st, interrupted: true } : null));
      setErr(e.partial
        ? "AI 응답이 중간에 중단되었습니다. 다시 시도하면 이 답변을 새로 생성합니다."
        : e.retryable ? "AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요." : e.message);
      return null;
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  /* 버튼 한 번 = 요청 한 번. 응답 중에는 같은 동작을 다시 시작하지 않습니다. */
  const guarded = (fn) => async (...args) => {
    if (running.current) return;
    running.current = true;
    try { await fn(...args); }
    finally { running.current = false; }
  };

  /* 완성된 말을 기록에 넣습니다. 자막으로 이미 다 본 말이므로 읽은 것으로 칩니다. */
  const pushRead = (t, extra = {}) =>
    set((o) => ({ ...o, turns: [...o.turns, t], ack: o.turns.length + 1, ...extra }));

  /* 토론 이력을 AI 대화 형식으로 */
  const history = (turns) => turns.map((t) => {
    if (t.who === "ai") return { role: "assistant", text: t.text };
    if (t.who === "witness") return { role: "user", text: `[증인 ${witnessById(t.wid).name}의 증언] ${t.text}` };
    if (t.who === "defendant") return { role: "user", text: `[피고인 산업혁명] ${t.text}` };
    return { role: "user", text: t.text };
  });

  /* 상대편 반박에 보내는 이력: 첫 주장(입장·주장·까닭)은 늘, 그 뒤는 최근 8마디만.
     증인 기록 전체를 매번 붙이지 않습니다. */
  const rebutHistory = (turns) => {
    if (turns.length <= 9) return history(turns);
    return history([turns[0], ...turns.slice(-8)]);
  };

  /* 증인에게 보내는 이력: 이 증인이 증인석에 선 뒤 오간 문답만.
     증인의 말은 assistant, 묻는 쪽(나·상대편)은 user. */
  const witnessHistory = (turns, from) => turns.slice(from).map((t) =>
    t.who === "witness" ? { role: "assistant", text: t.text } : { role: "user", text: t.text });

  const recordText = () => {
    const seat = SEATS[s.side];
    const L = [`[학생이 맡은 자리] ${seat?.title} — ${seat?.claim}`,
               `[학생의 첫 주장] ${s.claim}`, `[학생이 든 까닭] ${s.ground}`];
    s.turns.forEach((t) => {
      const who = { me: "학생", ai: "상대편", defendant: "피고인 산업혁명" }[t.who]
        || `증인 ${witnessById(t.wid).name}`;
      L.push(`${who}: ${t.text}`);
    });
    return L.join("\n");
  };

  /* AI가 한 차례 반박 */
  const aiRebut = guarded(async (turns, latest) => {
    const text = await speak({
      who: "ai", label: "상대편이 반박을 준비합니다",
      payload: { role: "ai_rebut", question: latest, history: rebutHistory(turns) },
    });
    if (text == null) { setRetry(() => () => aiRebut(turns, latest)); return; }
    pushRead({ who: "ai", text }, { phase: "DEBATE" });
  });

  /* 첫 주장 제출 */
  const submitOpening = () => {
    if (s.claim.trim().length < 15) return setErr("주장을 조금 더 자세히 써 주세요.");
    if (s.ground.trim().length < 10) return setErr("그렇게 보는 까닭도 한 가지 써 주세요.");
    setErr(null);
    const first = `${s.claim.trim()}\n그렇게 보는 까닭은 이렇습니다. ${s.ground.trim()}`;
    const turns = [{ who: "me", text: first }];
    set({ turns, phase: "DEBATE" });
    aiRebut([], first);
  };

  /* 상대편 응답이 실패했을 때 마지막 내 발언으로 다시 시도 */
  const retryRebut = () => {
    const last = [...s.turns].reverse().find((t) => t.who === "me");
    if (!last) return;
    setErr(null);
    aiRebut(s.turns.slice(0, s.turns.lastIndexOf(last)), last.text);
  };

  /* 내 반박 제출 */
  const submitRebut = () => {
    const t = draft.trim();
    if (t.length < 10) return setErr("반박을 조금 더 써 주세요.");
    setErr(null);
    const turns = [...s.turns, { who: "me", text: t }];
    set({ turns });
    setDraft("");
    aiRebut(s.turns, t);
  };

  /* 증인 부르기. wFrom 은 이 증인이 선 뒤 오간 말이 어디서 시작하는지. */
  const callWitness = (id) =>
    set((o) => ({ ...o, witnesses: [...o.witnesses, id], wid: id, wAsked: 0, wFrom: o.turns.length, phase: "W_ASK" }));

  /* 증인에게 묻기. again 은 실패한 질문을 다시 보낼 때 — 질문을 다시 기록하거나 횟수를 세지 않습니다. */
  const askWitness = guarded(async (again = null) => {
    const q = (again ?? draft).trim();
    if (q.length < 4) { setErr("질문을 적어 주세요."); return; }
    setErr(null);
    if (again == null) {
      setDraft("");
      set((o) => ({ ...o, turns: [...o.turns, { who: "me", text: q }], wAsked: o.wAsked + 1 }));
    }
    const wt = witnessById(s.wid);
    const prior = again == null ? s.turns : s.turns.slice(0, -1);   // 이번 질문은 question 으로 따로 보냅니다
    const text = await speak({
      who: "witness", wid: s.wid, label: `${wt.name}이(가) 증언합니다`,
      payload: { role: "witness", witnessId: s.wid, question: q, history: witnessHistory(prior, s.wFrom) },
    });
    if (text == null) { setRetry(() => () => askWitness(q)); return; }
    pushRead({ who: "witness", text, wid: s.wid });
  });

  /* 반대편이 같은 증인에게 한 가지 묻고, 증인이 답합니다. 두 번의 호출을 이어서. */
  const crossAnswer = async (q) => {
    const wt = witnessById(s.wid);
    const a = await speak({
      who: "witness", wid: s.wid, label: `${wt.name}이(가) 증언합니다`,
      payload: { role: "witness", witnessId: s.wid, question: q, history: witnessHistory(s.turns, s.wFrom) },
    });
    if (a == null) { setRetry(() => () => retryCrossAnswer(q)); return; }
    pushRead({ who: "witness", text: a, wid: s.wid }, { phase: "W_DONE" });
  };
  const retryCrossAnswer = guarded(crossAnswer);

  const crossWitness = guarded(async () => {
    set({ phase: "W_CROSS" });
    const log = s.turns.slice(s.wFrom)
      .slice(-6).map((t) => `${t.who === "witness" ? "증언" : "질문"}: ${t.text}`).join("\n");
    const raw = await speak({
      who: "ai", label: "상대편이 증인에게 물을 것을 고릅니다",
      payload: { role: "ai_cross", witnessId: s.wid, witnessLog: log },
    });
    if (raw == null) { setRetry(() => () => crossWitness()); return; }
    const q = raw.replace(/^["「]|["」]$/g, "");
    pushRead({ who: "ai", text: q });
    await crossAnswer(q);
  });

  /* 마지막 말. 「재판 마치기」를 누르면 판사가 먼저 말하고,
     그 대사가 끝날 때(advanceJudge) 상대편과 피고인의 말을 차례로 받습니다. */
  const runClosing = () => set({ phase: "CLOSING" });

  const closingDefendant = async (rec) => {
    const d = await speak({
      who: "defendant", label: "피고인이 마지막 말을 고릅니다",
      payload: {
        role: "defendant",
        question: `재판이 끝나갑니다. 아래가 오늘 법정에서 오간 전부입니다.\n\n${rec}\n\n피고인으로서 마지막으로 하고 싶은 말을 하십시오. 오늘 나온 이야기 가운데 마음에 걸린 것을 짚으며 말하십시오.`,
      },
    });
    if (d == null) { setRetry(() => () => retryClosingDefendant(rec)); return; }
    pushRead({ who: "defendant", text: d });
  };
  const retryClosingDefendant = guarded(closingDefendant);

  const startClosing = guarded(async () => {
    const rec = recordText();
    const a = await speak({
      who: "ai", label: "상대편이 마지막 말을 정리합니다",
      payload: { role: "ai_closing", record: rec },
    });
    if (a == null) { setRetry(() => () => startClosing()); return; }
    pushRead({ who: "ai", text: a });
    await closingDefendant(rec);
  });

  /* ── 조명 ── 자막에 나온 사람을 밝힙니다. */
  const actor = (() => {
    if (playing && cue?.cls === "judge") return "judge";
    if (busy?.includes("증언")) return "witness";
    if (busy?.includes("피고인")) return "defendant";
    if (busy?.includes("상대편")) return "ai";
    if (cue?.turn) return cue.turn.who;
    if (s.phase === "W_ASK" || s.phase === "W_CROSS" || s.phase === "W_DONE") return "witness";
    return "me";
  })();

  if (!booted) return <div className="boot" />;

  /* ── 입장 화면 ── */
  if (s.phase === "LOBBY") {
    return (
      <div className="lobby">
        {resume && (
          <Modal title="진행하던 재판이 있습니다."
            sub={`${PHASE_INFO[resume.phase]?.label} · ${longTime(resume.elapsed || 0)} 지남`}
            actions={[
              { label: "이어서 하기", main: true,
                onClick: () => {
                  // 예전 저장본에는 읽은 자리가 없으니 지금까지의 말은 다 읽은 것으로 칩니다.
                  const t = resume.turns || [];
                  setS({ ...blank(), ...resume, ack: resume.ack ?? t.length });
                  setResume(null);
                } },
              { label: "처음부터 새로", onClick: () => { localStorage.removeItem(STORE); setResume(null); } },
            ]} />
        )}
        <div className="lobby-in">
          <p className="lobby-eyebrow">1760 — 1850 · 영국</p>
          <h1 className="lobby-title">산업혁명<span>역사재판</span></h1>
          <p className="lobby-charge">
            피고인 산업혁명은 인류를 끌어올렸는가,<br />아니면 수많은 사람을 짓밟았는가.
          </p>
          <p className="lobby-desc">
            오늘 여러분은 이 재판의 당사자입니다. 산업혁명을 변호할지 고발할지 고르고,
            상대편과 주장을 주고받습니다. 그 시대를 살았던 사람을 증인으로 부를 수도 있습니다.
            마지막에는 스스로 판단을 내립니다.
          </p>
          <input className="pass" placeholder="입장 암호 (선생님이 알려 주신 경우에만)"
            value={pass} onChange={(e) => setPass(e.target.value)} />
          <button className="btn main big"
            onClick={() => set({ phase: "OPEN", date: new Date().toLocaleDateString("ko-KR") })}>
            법정에 들어가기
          </button>
          <p className="lobby-note">
            {TOTAL_MIN}분 · 증인 두 명까지 · 로그인 없음<br />
            상대편과 증인, 피고인은 AI가 연기합니다. 실제 인물의 발언이 아닙니다.
          </p>
        </div>
      </div>
    );
  }

  if (s.phase === "RECORD")
    return <Record s={s} onNew={() => { localStorage.removeItem(STORE); setS(blank()); }} />;

  const canWitness = s.witnesses.length < MAX_WITNESS && !overtime;
  const myTurn = s.phase === "DEBATE" && s.turns[s.turns.length - 1]?.who !== "me";

  return (
    <div className="app">
      <header className="top">
        <div className="top-l">
          <b className="phase">{info.label}</b>
          <span className="phase-desc">{info.desc}</span>
        </div>
        <div className={`clock ${overtime ? "over" : warning ? "warn" : ""}`}>
          {mmss(s.elapsed)} <span>/ {TOTAL_MIN}:00</span>
        </div>
      </header>
      <div className="rail"><i style={{ width: `${Math.min(100, (s.elapsed / TOTAL_SEC) * 100)}%` }} /></div>

      {(warning || overtime) && (
        <p className={`banner ${overtime ? "over" : ""}`}>
          {overtime ? "시간이 다 되었습니다. 새 증인은 부를 수 없습니다. 마무리해 주세요."
            : "끝나기까지 5분쯤 남았습니다. 슬슬 정리할 준비를 하세요."}
        </p>
      )}

      <div className="stage">
        <Courtroom
          active={actor}
          side={s.side}
          standWitness={["W_ASK", "W_CROSS", "W_DONE"].includes(s.phase) ? s.wid : null}
          usedWitnesses={s.witnesses}
          picking={s.phase === "W_PICK"}
          onCallWitness={callWitness}
          cue={cue}
          busy={busy}
          onTerm={setTerm}
          logCount={n}
          logOpen={showLog}
          onToggleLog={() => setShowLog((v) => !v)}
        />
      </div>

      <section className="dock">
        {/* 지난 말 전체. 자막에는 한 줄만 보이므로 펼쳐서 다시 읽을 수 있게 둡니다. */}
        {showLog && n > 0 && (
          <div className="talk">
            <p className="talk-head">
              <span>지금까지 오간 말</span>
              <button className="btn tiny" onClick={() => setShowLog(false)}>접기</button>
            </p>
            {s.turns.map((t, i) => <Turn key={i} t={t} side={s.side} onTerm={setTerm} />)}
            <div ref={tail} />
          </div>
        )}

        {err && (
          <div className="err"><span>{err}</span>
            {retry && !busy && <button className="btn tiny main" onClick={retry}>다시 시도</button>}
            <button className="btn tiny" onClick={() => { setErr(null); setRetry(null); }}>닫기</button></div>
        )}

        {panelOpen && (
          <div ref={panelRef}>
            <Panel {...{ s, set, draft, setDraft, setErr, canWitness, myTurn, retry,
              submitOpening, submitRebut, askWitness, crossWitness, runClosing, retryRebut }} />
          </div>
        )}
      </section>

      {term && <Modal title={term} sub={GLOSSARY[term]}
        actions={[{ label: "알겠습니다", main: true, onClick: () => setTerm(null) }]} />}
    </div>
  );
}

/* ============================================================ */

/* 한 마디를 이름표·색·본문으로 풀어 줍니다. 자막과 지난 말 목록이 같이 씁니다. */
function speaker(t, side) {
  const map = {
    me: { who: `${SEATS[side]?.title} · 나`, cls: "me" },
    ai: { who: `${SEATS[other(side)]?.title} · 상대편`, cls: "ai" },
    witness: { who: `증인 · ${t.wid ? witnessById(t.wid).name : ""}`, cls: "wit" },
    defendant: { who: "피고인 · 산업혁명", cls: "defendant" },
  }[t.who];
  return { ...map, text: t.text, turn: t };
}

function Turn({ t, side, onTerm }) {
  const m = speaker(t, side);
  return <Bubble who={m.who} cls={m.cls} text={m.text} onTerm={onTerm} />;
}

function Panel({ s, set, draft, setDraft, setErr, canWitness, myTurn, retry,
  submitOpening, submitRebut, askWitness, crossWitness, runClosing, retryRebut }) {

  switch (s.phase) {
    case "SEAT":
      return (
        <div className="pad">
          <div className="seats">
            {Object.values(SEATS).map((seat) => (
              <button key={seat.id} className="seat"
                onClick={() => set({ side: seat.id, phase: "OPENING" })}>
                <b>{seat.title}</b>
                <span className="seat-plain">{seat.plain}</span>
                <span className="seat-claim">{seat.claim}</span>
                <span className="seat-goal">{seat.goal}</span>
              </button>
            ))}
          </div>
        </div>
      );

    case "OPENING":
      return (
        <div className="pad">
          <p className="w-title">첫 주장을 말하세요</p>
          <p className="w-hint">길게 쓰지 않아도 됩니다. 두세 문장이면 충분합니다. 나머지는 토론하면서 채우면 됩니다.</p>
          <label className="fld"><span>나는 산업혁명을 이렇게 본다</span>
            <textarea rows={3} value={s.claim} placeholder="예: 산업혁명은 사람들을 더 잘 살게 만든 변화였다."
              onChange={(e) => set({ claim: e.target.value })} /></label>
          <label className="fld"><span>그렇게 보는 까닭 한 가지</span>
            <textarea rows={3} value={s.ground} placeholder="예: 기계가 생기면서 옷값이 싸져서 가난한 사람도 옷을 사 입을 수 있게 됐다."
              onChange={(e) => set({ ground: e.target.value })} /></label>
          <button className="btn main big" onClick={submitOpening}>주장 말하기</button>
        </div>
      );

    case "DEBATE":
      return (
        <div className="pad">
          {myTurn ? (
            <>
              <p className="w-title">반박하세요</p>
              <p className="w-hint">상대편이 던진 질문에 답하면서, 왜 내 생각이 여전히 맞는지 말하면 좋습니다.</p>
              <textarea rows={4} value={draft} placeholder="상대편 말 중 어디에 동의할 수 없는지부터 써 보세요."
                onChange={(e) => setDraft(e.target.value)} />
              <div className="row">
                <button className="btn main" onClick={submitRebut}>반박하기</button>
              </div>
            </>
          ) : (
            <div className="center">
              <p className="w-hint">상대편의 말을 받지 못했습니다.</p>
              {!retry && <button className="btn main" onClick={retryRebut}>다시 시도</button>}
            </div>
          )}
          <div className="row extras">
            {canWitness && (
              <button className="btn" onClick={() => set({ phase: "W_PICK" })}>
                증인 부르기 ({s.witnesses.length}/{MAX_WITNESS})
              </button>
            )}
            <button className="btn" onClick={runClosing}>재판 마치기</button>
          </div>
        </div>
      );

    case "IDENTIFY":
      return (
        <div className="pad center">
          <button className="btn main big" onClick={() => set({ phase: "SEAT" })}>자리 고르러 가기</button>
        </div>
      );

    case "W_CROSS":
      return (
        <div className="pad center">
          <p className="w-hint">상대편의 질문을 받지 못했습니다.</p>
          <div className="row center">
            {!retry && <button className="btn main" onClick={crossWitness}>다시 시도</button>}
            <button className="btn" onClick={() => set({ phase: "W_DONE" })}>건너뛰기</button>
          </div>
        </div>
      );

    case "W_PICK":
      return (
        <div className="pad center">
          <button className="btn" onClick={() => set({ phase: "DEBATE" })}>역시 부르지 않겠습니다</button>
        </div>
      );

    case "W_ASK":
      return (
        <div className="pad">
          <p className="w-title">증인에게 묻습니다 ({3 - s.wAsked}번 남음)</p>
          <p className="w-hint">이 사람이 직접 겪었을 법한 일을 물어야 좋은 답이 옵니다. 나라 전체 이야기는 이 사람이 모릅니다.</p>
          {s.wAsked < 3 && (
            <>
              <textarea rows={2} value={draft} placeholder="예: 하루에 몇 시간을 일했고, 그때 몸은 어땠습니까?"
                onChange={(e) => setDraft(e.target.value)} />
              <div className="row"><button className="btn main" onClick={() => askWitness()}>질문하기</button></div>
            </>
          )}
          {s.wAsked > 0 && (
            <div className="row extras">
              <button className="btn" onClick={crossWitness}>그만 묻고 상대편에게 넘기기</button>
            </div>
          )}
        </div>
      );

    case "W_DONE":
      return (
        <div className="pad center">
          <p className="w-hint">증인이 물러갔습니다. 방금 들은 증언을 근거로 다시 다투세요.</p>
          <button className="btn main big" onClick={() => set({ phase: "DEBATE", wid: null })}>토론으로 돌아가기</button>
        </div>
      );

    case "CLOSING":
      return (
        <div className="pad center">
          <button className="btn main big" onClick={() => set({ phase: "VERDICT" })}>이제 내가 판단하기</button>
        </div>
      );

    case "VERDICT":
      return <Verdict s={s} set={set} setErr={setErr} />;

    case "SENTENCE":
      return (
        <div className="pad center">
          <button className="btn main big"
            onClick={() => set({ phase: "RECORD", finishedAt: s.elapsed })}>재판 기록 보기</button>
        </div>
      );

    default:
      return null;
  }
}

function Verdict({ s, set, setErr }) {
  return (
    <div className="pad">
      <p className="w-title">이제 내가 판단합니다</p>
      <p className="w-hint">생각이 처음과 달라져도 괜찮습니다. 달라진 것보다 무엇이 나를 바꾸었는지가 더 중요합니다.</p>
      <div className="verdicts">
        {VERDICTS.map((v) => (
          <button key={v.id} className={`vbtn ${s.verdict === v.id ? "on" : ""}`}
            onClick={() => set({ verdict: v.id })}>
            <b>{v.label}</b><span>{v.note}</span>
          </button>
        ))}
      </div>
      <label className="fld"><span>왜 그렇게 판단했나요? 오늘 들은 것 가운데 결정적이었던 것을 들어 말하세요.</span>
        <textarea rows={4} value={s.reasons[0]}
          onChange={(e) => set((p) => ({ ...p, reasons: [e.target.value, p.reasons[1]] }))} /></label>
      <label className="fld"><span>상대편이나 증인의 말 중에 인정하게 된 것이 있나요?</span>
        <textarea rows={3} value={s.reasons[1]}
          onChange={(e) => set((p) => ({ ...p, reasons: [p.reasons[0], e.target.value] }))} /></label>
      <button className="btn main big" onClick={() => {
        if (!s.verdict) return setErr("유죄, 일부 유죄, 무죄 중 하나를 고르세요.");
        if (s.reasons[0].trim().length < 15) return setErr("판단한 까닭을 조금 더 써 주세요.");
        setErr(null);
        set({ phase: "SENTENCE", finishedAt: s.elapsed });
      }}>판단 내리기</button>
    </div>
  );
}

/* ── 조각 ── */

function Modal({ title, sub, actions }) {
  return (
    <div className="mask"><div className="modal">
      <h3>{title}</h3>{sub && <p>{sub}</p>}
      <div className="modal-btns">
        {actions.map((a) => (
          <button key={a.label} className={`btn ${a.main ? "main" : ""}`} onClick={a.onClick}>{a.label}</button>
        ))}
      </div>
    </div></div>
  );
}

function Bubble({ who, cls, text, onTerm, children }) {
  return (
    <div className={`bubble ${cls}`}>
      <span className="plate">{who}</span>
      <p className="say"><Glossed text={text} onTerm={onTerm} /></p>
      {children && <div className="bubble-act">{children}</div>}
    </div>
  );
}

/* ── 기록 화면 ── */

function Record({ s, onNew }) {
  const seat = SEATS[s.side];
  const v = VERDICTS.find((x) => x.id === s.verdict);
  return (
    <div className="record-page">
      <div className="rec-screen">
        <h2>재판이 끝났습니다.</h2>
        <p className="rec-time">총 {longTime(s.finishedAt ?? s.elapsed)} · {s.date}</p>
        <div className="rec-compare">
          <div><span>재판을 시작할 때 나는</span><b>{seat?.title}</b><p>{s.claim}</p></div>
          <div><span>재판을 끝내고 나는</span><b>{v?.label}</b><p>{s.reasons[0]}</p></div>
        </div>
        <p className="rec-note">이 기록은 채점되지 않습니다. 생각이 어떻게 움직였는지 보기 위한 것입니다.</p>
        <div className="row center">
          <button className="btn main big" onClick={() => window.print()}>재판 기록 PDF로 저장</button>
          <button className="btn" onClick={onNew}>새 재판 시작</button>
        </div>
      </div>
      <PrintDoc s={s} />
    </div>
  );
}

function PrintDoc({ s }) {
  const seat = SEATS[s.side];
  const v = VERDICTS.find((x) => x.id === s.verdict);
  const R = ({ l, children }) => (
    <div className="prow"><div className="plabel">{l}</div><div className="pval">{children}</div></div>
  );
  const name = (t) => ({ me: "나", ai: "상대편", defendant: "피고인 산업혁명" }[t.who]
    || `증인 ${witnessById(t.wid).name}`);
  return (
    <div className="print">
      <h1>산업혁명 역사재판 기록</h1>
      <p className="ptopic">산업혁명은 인류를 끌어올렸는가, 아니면 수많은 사람을 짓밟았는가</p>
      <div className="pmeta">
        <span>날짜 {s.date}</span>
        <span>재판 시간 {longTime(s.finishedAt ?? s.elapsed)}</span>
        <span>이름 ____________</span>
      </div>
      <h2>1. 내가 맡은 자리와 첫 주장</h2>
      <R l="자리">{seat?.title} — {seat?.claim}</R>
      <R l="첫 주장">{s.claim}</R>
      <R l="든 까닭">{s.ground}</R>
      <h2>2. 오간 말</h2>
      {s.turns.map((t, i) => <R key={i} l={name(t)}>{t.text}</R>)}
      <h2>3. 나의 판단</h2>
      <R l="판단">{v?.label} — {v?.note}</R>
      <R l="그렇게 본 까닭">{s.reasons[0]}</R>
      <R l="인정하게 된 것">{s.reasons[1]}</R>
      <h2>4. 생각의 변화</h2>
      <div className="pcompare">
        <div><strong>재판을 시작할 때</strong><p>{seat?.title}로서</p><p>{s.claim}</p></div>
        <div><strong>재판을 끝내고</strong><p>{v?.label}</p><p>{s.reasons[0]}</p></div>
      </div>
    </div>
  );
}
