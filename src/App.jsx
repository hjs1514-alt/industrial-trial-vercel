import React, { useState, useEffect, useRef, useCallback } from "react";
import Courtroom from "./Courtroom.jsx";
import { askTwice } from "./ai.js";
import {
  WITNESSES,
  witnessById,
  SEATS,
  other,
  JUDGE,
  DEFENDANT_LINES,
  GLOSSARY,
  PHASE_INFO,
  VERDICTS,
  TOTAL_SEC,
  WARN_SEC,
  TOTAL_MIN,
} from "./data.js";

const STORE = "trial-v2";
const mmss = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const longTime = (s) => `${Math.floor(s / 60)}분 ${Math.floor(s % 60)}초`;

const blank = () => ({
  phase: "LOBBY",
  side: null,
  opening: "",
  aiOpening: "",
  evidence: ["", "", ""],
  aiEvidence: "",
  witnesses: [], // {id, direct:[{q,a}], cross:[{q,a}], redirect:{q,a}|null}
  wi: 0,
  defQ: { mine: null, ai: null }, // {q,a}
  aiClosing: "",
  closing: "",
  lastWord: "",
  verdict: null,
  reasons: ["", ""],
  elapsed: 0,
  finishedAt: null,
  date: null,
});

/* 판사 대사를 순서대로 흘려보내는 훅 */
function useScript() {
  const [lines, setLines] = useState([]);
  const [idx, setIdx] = useState(0);
  const play = useCallback((arr) => {
    setLines(arr);
    setIdx(0);
  }, []);
  const next = () => setIdx((i) => i + 1);
  const done = idx >= lines.length - 1;
  return { line: lines[Math.min(idx, lines.length - 1)] || "", play, next, done, count: lines.length };
}

export default function App() {
  const [s, setS] = useState(blank);
  const [booted, setBooted] = useState(false);
  const [resume, setResume] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState("");
  const [term, setTerm] = useState(null);
  const [pass, setPass] = useState("");
  const running = useRef(false);
  const script = useScript();

  const set = useCallback((patch) => {
    setS((p) => ({ ...p, ...(typeof patch === "function" ? patch(p) : patch) }));
  }, []);

  /* ── 부팅과 자동 저장 ── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const v = JSON.parse(raw);
        if (v && v.phase && v.phase !== "LOBBY") setResume(v);
      }
    } catch (e) {}
    setBooted(true);
  }, []);

  useEffect(() => {
    if (!booted || s.phase === "LOBBY") return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify(s));
      } catch (e) {}
    }, 500);
    return () => clearTimeout(t);
  }, [s, booted]);

  useEffect(() => {
    if (s.phase === "LOBBY" || s.phase === "RECORD") return;
    const t = setInterval(() => setS((p) => ({ ...p, elapsed: p.elapsed + 1 })), 1000);
    return () => clearInterval(t);
  }, [s.phase]);

  const overtime = s.elapsed >= TOTAL_SEC;
  const warning = s.elapsed >= WARN_SEC && !overtime;
  const cur = s.witnesses[s.wi];
  const info = PHASE_INFO[s.phase] || PHASE_INFO.LOBBY;

  /* ── 전체 기록을 글로 ── */
  const recordText = useCallback(() => {
    const seat = SEATS[s.side];
    const L = [];
    L.push(`[학생이 맡은 자리] ${seat?.title} — ${seat?.claim}`);
    L.push(`[학생 모두진술] ${s.opening}`);
    s.evidence.forEach((e, i) => L.push(`[증 제${i + 1}호증] ${e}`));
    if (s.aiOpening) L.push(`\n[상대편 모두진술]\n${s.aiOpening}`);
    if (s.aiEvidence) L.push(`\n[상대편 증거 인부]\n${s.aiEvidence}`);
    s.witnesses.forEach((w, i) => {
      L.push(`\n[증인 ${i + 1} · ${witnessById(w.id).name}]`);
      w.direct.forEach((qa) => {
        L.push(`주신문: ${qa.q}`);
        if (qa.a) L.push(`증언: ${qa.a}`);
      });
      w.cross.forEach((qa) => {
        L.push(`반대신문: ${qa.q}`);
        if (qa.a) L.push(`증언: ${qa.a}`);
      });
      if (w.redirect) {
        L.push(`재주신문: ${w.redirect.q}`);
        L.push(`증언: ${w.redirect.a}`);
      }
    });
    if (s.defQ.mine) L.push(`\n[피고인 신문 · 내 질문] ${s.defQ.mine.q}\n피고인: ${s.defQ.mine.a}`);
    if (s.defQ.ai) L.push(`[피고인 신문 · 상대편 질문] ${s.defQ.ai.q}\n피고인: ${s.defQ.ai.a}`);
    if (s.closing) L.push(`\n[내 최종 진술]\n${s.closing}`);
    if (s.aiClosing) L.push(`\n[상대편 최종 진술]\n${s.aiClosing}`);
    return L.join("\n");
  }, [s]);

  const witnessHistory = (w) => {
    const h = [];
    w.direct.forEach((qa) => {
      h.push({ role: "user", text: qa.q });
      if (qa.a) h.push({ role: "assistant", text: qa.a });
    });
    w.cross.forEach((qa) => {
      h.push({ role: "user", text: qa.q });
      if (qa.a) h.push({ role: "assistant", text: qa.a });
    });
    if (w.redirect?.a) {
      h.push({ role: "user", text: w.redirect.q });
      h.push({ role: "assistant", text: w.redirect.a });
    }
    return h;
  };

  const call = (payload) => askTwice({ side: s.side, ...payload }, pass);

  /* ── 단계 진입 시 판사 대사 ── */
  useEffect(() => {
    const map = {
      OPEN: JUDGE.open,
      IDENTIFY: JUDGE.identify,
      SEAT: JUDGE.seat,
      OPENING: JUDGE.opening,
      EVIDENCE: JUDGE.evidence,
      W_CALL: JUDGE.witnessCall,
      W_OATH: JUDGE.oath,
      W_DIRECT: JUDGE.direct,
      W_CROSS: JUDGE.cross,
      W_REDIRECT: JUDGE.redirect,
      DEF_STUDENT: JUDGE.defendantExam,
      CLOSING_STUDENT: JUDGE.closing,
      LAST_WORD: JUDGE.lastWord,
      VERDICT: JUDGE.verdict,
      SENTENCE: JUDGE.sentence,
    };
    if (map[s.phase]) script.play(map[s.phase]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase, s.wi]);

  const judgeSpeaking = script.count > 0 && !script.done;

  /* ── 각 AI 순서 ── */
  const runAiOpening = async () => {
    if (running.current) return;
    running.current = true;
    setBusy("상대편이 모두진술을 준비합니다");
    try {
      const t = await call({ role: "ai_opening", trial: { opening: s.opening } });
      set({ aiOpening: t, phase: "AI_OPENING" });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
      running.current = false;
    }
  };

  const runAiEvidence = async () => {
    if (running.current) return;
    running.current = true;
    set({ phase: "AI_EVIDENCE" });
    setBusy("상대편이 증거를 살펴봅니다");
    try {
      const t = await call({
        role: "ai_evidence",
        trial: { opening: s.opening, evidence: s.evidence },
      });
      set({ aiEvidence: t });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
      running.current = false;
    }
  };

  const askWitness = async (q, kind) => {
    const idx = s.wi;
    const w = s.witnesses[idx];
    const wt = witnessById(w.id);
    const stamp = (list) => {
      set((p) => {
        const ws = [...p.witnesses];
        ws[idx] = list(ws[idx]);
        return { ...p, witnesses: ws };
      });
    };
    if (kind === "direct") stamp((t) => ({ ...t, direct: [...t.direct, { q, a: null }] }));
    if (kind === "redirect") stamp((t) => ({ ...t, redirect: { q, a: null } }));
    setBusy(`${wt.name}이(가) 증언합니다`);
    try {
      const a = await call({
        role: "witness",
        witnessId: w.id,
        question: q,
        history: witnessHistory(w),
      });
      if (kind === "direct")
        stamp((t) => {
          const d = [...t.direct];
          d[d.length - 1] = { q, a };
          return { ...t, direct: d };
        });
      if (kind === "redirect") stamp((t) => ({ ...t, redirect: { q, a } }));
    } catch (e) {
      setErr(e.message);
      if (kind === "direct") stamp((t) => ({ ...t, direct: t.direct.filter((x) => x.a) }));
      if (kind === "redirect") stamp((t) => ({ ...t, redirect: null }));
    } finally {
      setBusy(null);
    }
  };

  const runCross = async () => {
    if (running.current) return;
    running.current = true;
    const idx = s.wi;
    let w = s.witnesses[idx];
    const wt = witnessById(w.id);
    const push = (snap) =>
      set((p) => {
        const ws = [...p.witnesses];
        ws[idx] = snap;
        return { ...p, witnesses: ws };
      });
    try {
      for (let round = 1; round <= 2; round++) {
        setBusy("상대편이 반대신문을 준비합니다");
        const log = [...w.direct, ...w.cross]
          .filter((x) => x.a)
          .map((x) => `질문: ${x.q}\n증언: ${x.a}`)
          .join("\n\n");
        const q = (
          await call({ role: "ai_cross", witnessId: w.id, witnessLog: log, round })
        ).replace(/^["「]|["」]$/g, "");
        w = { ...w, cross: [...w.cross, { q, a: null }] };
        push(w);

        setBusy(`${wt.name}이(가) 증언합니다`);
        const a = await call({
          role: "witness",
          witnessId: w.id,
          question: q,
          history: witnessHistory({ ...w, cross: w.cross.slice(0, -1) }),
        });
        const c = [...w.cross];
        c[c.length - 1] = { q, a };
        w = { ...w, cross: c };
        push(w);
      }
      set({ phase: "W_REDIRECT" });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
      running.current = false;
    }
  };

  useEffect(() => {
    if (s.phase === "W_CROSS" && cur && cur.cross.length === 0 && !running.current) runCross();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase]);

  const askDefendant = async (q, who) => {
    setBusy("피고인이 답합니다");
    try {
      const hist = [];
      if (s.defQ.mine) {
        hist.push({ role: "user", text: s.defQ.mine.q });
        hist.push({ role: "assistant", text: s.defQ.mine.a });
      }
      const a = await call({ role: "defendant", question: q, history: hist });
      set((p) => ({ ...p, defQ: { ...p.defQ, [who]: { q, a } } }));
      return true;
    } catch (e) {
      setErr(e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const runAiDefendantQ = async () => {
    if (running.current) return;
    running.current = true;
    set({ phase: "DEF_AI" });
    setBusy("상대편이 피고인에게 물을 것을 고릅니다");
    try {
      const q = await call({ role: "ai_defendant_question", record: recordText() });
      setBusy("피고인이 답합니다");
      const ok = await askDefendant(q.replace(/^["「]|["」]$/g, ""), "ai");
      if (!ok) return;
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
      running.current = false;
    }
  };

  const runAiClosing = async () => {
    if (running.current) return;
    running.current = true;
    set({ phase: "CLOSING_AI" });
    setBusy("상대편이 최종 진술을 정리합니다");
    try {
      const t = await call({ role: "ai_closing", record: recordText() });
      set({ aiClosing: t });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
      running.current = false;
    }
  };

  const runLastWord = async () => {
    if (running.current) return;
    running.current = true;
    set({ phase: "LAST_WORD" });
    setBusy("피고인이 마지막 말을 고릅니다");
    try {
      const t = await call({
        role: "defendant",
        question: `재판이 모두 끝났습니다. 아래가 오늘 법정에서 오간 전부입니다.\n\n${recordText()}\n\n피고인으로서 최후진술을 하십시오. 오늘 나온 이야기 중 마음에 걸린 것을 짚으며 말하십시오.`,
      });
      set({ lastWord: t });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
      running.current = false;
    }
  };

  /* ── 조명 대상 ── */
  const activeActor = (() => {
    if (judgeSpeaking) return "judge";
    switch (s.phase) {
      case "IDENTIFY":
      case "LAST_WORD":
      case "DEF_STUDENT":
      case "DEF_AI":
        return "defendant";
      case "SEAT":
      case "OPENING":
      case "EVIDENCE":
      case "CLOSING_STUDENT":
      case "VERDICT":
        return "me";
      case "AI_OPENING":
      case "AI_EVIDENCE":
      case "CLOSING_AI":
        return "ai";
      case "W_CALL":
        return "bench";
      case "W_DIRECT":
      case "W_CROSS":
      case "W_REDIRECT":
        return "witness";
      case "SENTENCE":
        return "judge";
      default:
        return null;
    }
  })();

  /* ── 대화상자에 띄울 말 ── */
  const bubble = (() => {
    if (judgeSpeaking) return { who: "판사", cls: "judge", text: script.line };
    switch (s.phase) {
      case "OPEN":
        return { who: "판사", cls: "judge", text: script.line };
      case "IDENTIFY":
        return { who: "피고인 · 산업혁명", cls: "defendant", text: `${DEFENDANT_LINES.name} ${DEFENDANT_LINES.origin}` };
      case "AI_OPENING":
        return { who: `${SEATS[other(s.side)].title} · 상대편`, cls: "ai", text: s.aiOpening };
      case "AI_EVIDENCE":
        return { who: `${SEATS[other(s.side)].title} · 상대편`, cls: "ai", text: s.aiEvidence };
      case "CLOSING_AI":
        return { who: `${SEATS[other(s.side)].title} · 상대편`, cls: "ai", text: s.aiClosing };
      case "LAST_WORD":
        return { who: "피고인 · 산업혁명", cls: "defendant", text: s.lastWord };
      case "SENTENCE":
        return { who: "판사", cls: "judge", text: script.line };
      default:
        return script.count ? { who: "판사", cls: "judge", text: script.line } : null;
    }
  })();

  /* ── 화면 ── */
  if (!booted) return <div className="boot" />;

  if (s.phase === "LOBBY") {
    return (
      <div className="lobby">
        {resume && (
          <Modal
            title="진행하던 재판이 있습니다."
            sub={`${PHASE_INFO[resume.phase]?.label} 단계 · ${longTime(resume.elapsed || 0)} 지남`}
            actions={[
              { label: "이어서 하기", main: true, onClick: () => { setS(resume); setResume(null); } },
              {
                label: "처음부터 새로",
                onClick: () => {
                  localStorage.removeItem(STORE);
                  setResume(null);
                },
              },
            ]}
          />
        )}
        <div className="lobby-in">
          <p className="lobby-eyebrow">1760 — 1850 · 영국</p>
          <h1 className="lobby-title">
            산업혁명
            <span>역사재판</span>
          </h1>
          <p className="lobby-charge">
            피고인 산업혁명은 인류를 끌어올렸는가,<br />아니면 수많은 사람을 짓밟았는가.
          </p>
          <p className="lobby-desc">
            오늘 여러분은 이 재판의 당사자입니다. 산업혁명을 변호할지 고발할지 직접 고르고,
            증거를 내고, 그 시대를 살았던 사람을 증인으로 불러 묻습니다. 마지막에는 배심원이
            되어 스스로 판단을 내립니다.
          </p>
          <input
            className="pass"
            placeholder="입장 암호 (선생님이 알려 주신 경우에만)"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          <button className="btn main big" onClick={() => set({ phase: "OPEN", date: new Date().toLocaleDateString("ko-KR") })}>
            법정에 들어가기
          </button>
          <p className="lobby-note">
            {TOTAL_MIN}분 · 증인 다섯 중 두 명 · 로그인 없음<br />
            상대편과 증인, 피고인은 AI가 연기합니다. 실제 인물의 발언이 아닙니다.
          </p>
        </div>
      </div>
    );
  }

  if (s.phase === "RECORD") return <Record s={s} onNew={() => { localStorage.removeItem(STORE); setS(blank()); }} />;

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
          {overtime
            ? "재판 시간이 다 되었습니다. 새 증인은 부를 수 없습니다. 지금까지 들은 것으로 마무리하세요."
            : "재판이 끝나기까지 5분쯤 남았습니다. 슬슬 정리할 준비를 하세요."}
        </p>
      )}

      <div className="stage">
        <Courtroom
          active={activeActor}
          side={s.side}
          standWitness={["W_OATH", "W_DIRECT", "W_CROSS", "W_REDIRECT"].includes(s.phase) ? cur?.id : null}
          usedWitnesses={s.witnesses.map((w) => w.id)}
          picking={s.phase === "W_CALL" && !overtime && s.witnesses.length < 2}
          onCallWitness={(id) =>
            set((p) => ({
              ...p,
              witnesses: [...p.witnesses, { id, direct: [], cross: [], redirect: null }],
              wi: p.witnesses.length,
              phase: "W_OATH",
            }))
          }
        />
      </div>

      <section className="dock">
        {busy && <Loading label={busy} />}
        {err && (
          <div className="err">
            <span>{err}</span>
            <button className="btn tiny" onClick={() => { setErr(null); }}>닫기</button>
          </div>
        )}

        {!busy && bubble && (
          <Bubble who={bubble.who} cls={bubble.cls} text={bubble.text} onTerm={setTerm}>
            {judgeSpeaking ? (
              <button className="btn main" onClick={script.next}>다음</button>
            ) : (
              <Advance s={s} set={set} script={script} runAiEvidence={runAiEvidence} runAiClosing={runAiClosing} runLastWord={runLastWord} />
            )}
          </Bubble>
        )}

        {!busy && !judgeSpeaking && (
          <Input
            s={s}
            set={set}
            cur={cur}
            draft={draft}
            setDraft={setDraft}
            setErr={setErr}
            overtime={overtime}
            askWitness={askWitness}
            askDefendant={askDefendant}
            runAiOpening={runAiOpening}
            runAiEvidence={runAiEvidence}
            runAiDefendantQ={runAiDefendantQ}
            runAiClosing={runAiClosing}
            onFinish={() => set({ phase: "RECORD", finishedAt: s.elapsed })}
          />
        )}
      </section>

      {term && <Modal title={term} sub={GLOSSARY[term]} actions={[{ label: "알겠습니다", main: true, onClick: () => setTerm(null) }]} />}
    </div>
  );
}

/* ============================================================
   조각 컴포넌트
   ============================================================ */

function Loading({ label }) {
  return (
    <div className="loading">
      <i /><i /><i />
      <span>{label}</span>
    </div>
  );
}

function Modal({ title, sub, actions }) {
  return (
    <div className="mask">
      <div className="modal">
        <h3>{title}</h3>
        {sub && <p>{sub}</p>}
        <div className="modal-btns">
          {actions.map((a) => (
            <button key={a.label} className={`btn ${a.main ? "main" : ""}`} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* 어려운 말에 밑줄을 그어 누르면 뜻이 뜨게 합니다. */
function Glossed({ text, onTerm }) {
  const keys = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${keys.join("|")})`, "g");
  return (
    <>
      {String(text || "")
        .split(re)
        .map((part, i) =>
          GLOSSARY[part] ? (
            <button key={i} className="term" onClick={() => onTerm(part)}>
              {part}
            </button>
          ) : (
            <React.Fragment key={i}>{part}</React.Fragment>
          )
        )}
    </>
  );
}

function Bubble({ who, cls, text, onTerm, children }) {
  return (
    <div className={`bubble ${cls}`}>
      <span className="plate">{who}</span>
      <p className="say"><Glossed text={text} onTerm={onTerm} /></p>
      <div className="bubble-act">{children}</div>
    </div>
  );
}

/* 판사 대사가 끝난 뒤 다음 순서로 밀어 주는 버튼 */
function Advance({ s, set, runAiEvidence, runAiClosing, runLastWord }) {
  const go = (patch) => () => set(patch);
  switch (s.phase) {
    case "OPEN":
      return <button className="btn main" onClick={go({ phase: "IDENTIFY" })}>다음</button>;
    case "IDENTIFY":
      return <button className="btn main" onClick={go({ phase: "SEAT" })}>다음</button>;
    case "AI_OPENING":
      return <button className="btn main" onClick={go({ phase: "EVIDENCE" })}>증거조사로</button>;
    case "AI_EVIDENCE":
      return <button className="btn main" onClick={go({ phase: "W_CALL" })}>증인 신청하기</button>;
    case "CLOSING_AI":
      return <button className="btn main" onClick={runLastWord}>피고인의 마지막 말 듣기</button>;
    case "LAST_WORD":
      return <button className="btn main" onClick={go({ phase: "VERDICT" })}>평결하러 가기</button>;
    default:
      return null;
  }
}

/* ── 하단 입력부 ── */
function Input({
  s, set, cur, draft, setDraft, setErr, overtime,
  askWitness, askDefendant, runAiOpening, runAiEvidence, runAiDefendantQ, runAiClosing, onFinish,
}) {
  const need = (msg) => { setErr(msg); return false; };
  const clear = () => { setDraft(""); setErr(null); };

  switch (s.phase) {
    case "SEAT":
      return (
        <div className="pad">
          <div className="seats">
            {Object.values(SEATS).map((seat) => (
              <button key={seat.id} className="seat" onClick={() => set({ side: seat.id, phase: "OPENING" })}>
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
        <Writer
          title="모두진술을 하십시오"
          hint="오늘 무엇을 다툴 것인지, 왜 그렇게 보는지 내 말로 씁니다. 아직 증거를 다 꺼낼 필요는 없습니다."
          ph="예: 저는 산업혁명이 ○○했다고 봅니다. 왜냐하면…"
          value={draft} setValue={setDraft}
          cta="진술하기"
          onSubmit={() => {
            if (draft.trim().length < 20) return need("조금 더 자세히 써 주세요. 두 문장 이상이면 좋습니다.");
            set({ opening: draft.trim() });
            clear();
            runAiOpening();
          }}
        />
      );

    case "EVIDENCE": {
      const i = s.evidence.findIndex((e) => !e);
      const n = i === -1 ? 3 : i + 1;
      if (i === -1)
        return (
          <div className="pad center">
            <button className="btn main big" onClick={runAiEvidence}>증거 제출을 마치고 상대편 의견 듣기</button>
          </div>
        );
      return (
        <Writer
          title={`증 제${n}호증을 진술하십시오`}
          hint="내 주장을 받쳐 줄 역사 속 사실을 하나 씁니다. 수업에서 배운 사건, 법, 기록, 사람들의 생활 변화 모두 증거가 됩니다."
          ph={["예: 어떤 기계나 기술의 등장", "예: 사람들의 생활이 달라진 모습", "예: 그때 만들어진 법이나 벌어진 사건"][n - 1]}
          value={draft} setValue={setDraft}
          cta={`증 제${n}호증 제출`}
          rows={3}
          onSubmit={() => {
            if (draft.trim().length < 5) return need("증거 내용을 적어 주세요.");
            set((p) => {
              const ev = [...p.evidence];
              ev[i] = draft.trim();
              return { ...p, evidence: ev };
            });
            clear();
          }}
        />
      );
    }

    case "W_CALL": {
      const canMore = s.witnesses.length < 2 && !overtime;
      if (canMore && s.witnesses.length === 0) return null;
      return (
        <div className="pad center">
          {overtime && <p className="w-hint">시간이 지나 새 증인은 부를 수 없습니다.</p>}
          <button className="btn main" onClick={() => set({ phase: "DEF_STUDENT" })}>
            증인 신문을 마치고 피고인 신문으로
          </button>
        </div>
      );
    }

    case "W_OATH":
      return (
        <div className="pad center">
          <button className="btn main big" onClick={() => set({ phase: "W_DIRECT" })}>주신문 시작</button>
        </div>
      );

    case "W_DIRECT": {
      const left = 3 - (cur?.direct.length || 0);
      return (
        <>
          <Log w={cur} />
          {left > 0 ? (
            <Writer
              title={`증인에게 묻습니다 (${left}번 남음)`}
              hint="증인이 직접 겪었을 법한 일을 물어야 좋은 답이 옵니다. 통계나 나라 전체 이야기는 이 사람이 모릅니다."
              ph="예: 하루에 몇 시간을 일했고, 그때 몸은 어땠습니까?"
              value={draft} setValue={setDraft}
              cta="질문하기"
              rows={2}
              onSubmit={() => {
                if (draft.trim().length < 4) return need("질문을 적어 주세요.");
                const q = draft.trim();
                clear();
                askWitness(q, "direct");
              }}
              extra={
                cur.direct.length > 0 && (
                  <button className="btn" onClick={() => set({ phase: "W_CROSS" })}>여기서 끝내고 반대신문 받기</button>
                )
              }
            />
          ) : (
            <div className="pad center">
              <button className="btn main big" onClick={() => set({ phase: "W_CROSS" })}>반대신문 받기</button>
            </div>
          )}
        </>
      );
    }

    case "W_CROSS":
      return <Log w={cur} />;

    case "W_REDIRECT":
      return (
        <>
          <Log w={cur} />
          {cur?.redirect?.a ? (
            <div className="pad center">
              <NextWitness s={s} set={set} overtime={overtime} runAiDefendantQ={runAiDefendantQ} />
            </div>
          ) : (
            <Writer
              title="재주신문 하시겠습니까?"
              hint="반대신문 때문에 흔들린 부분이 있다면 한 가지만 더 물어 바로잡을 수 있습니다. 그냥 넘어가도 됩니다."
              ph="예: 방금 그 대답이 당신 생각 전부는 아니지요?"
              value={draft} setValue={setDraft}
              cta="한 가지 더 묻기"
              rows={2}
              onSubmit={() => {
                if (draft.trim().length < 4) return need("질문을 적어 주세요.");
                const q = draft.trim();
                clear();
                askWitness(q, "redirect");
              }}
              extra={<NextWitness s={s} set={set} overtime={overtime} runAiDefendantQ={runAiDefendantQ} skip />}
            />
          )}
        </>
      );

    case "DEF_STUDENT":
      return s.defQ.mine ? (
        <div className="pad">
          <QA q={s.defQ.mine.q} a={s.defQ.mine.a} who="피고인" />
          <div className="center"><button className="btn main big" onClick={runAiDefendantQ}>상대편의 질문 듣기</button></div>
        </div>
      ) : (
        <Writer
          title="피고인 산업혁명에게 직접 묻습니다"
          hint="한 가지만 물을 수 있습니다. 지금까지 들은 것 중 가장 확인하고 싶은 것을 고르세요."
          ph="예: 당신은 그 아이들의 손가락을 알고 있었습니까?"
          value={draft} setValue={setDraft}
          cta="신문하기"
          rows={2}
          onSubmit={async () => {
            if (draft.trim().length < 4) return need("질문을 적어 주세요.");
            const q = draft.trim();
            clear();
            await askDefendant(q, "mine");
          }}
        />
      );

    case "DEF_AI":
      return s.defQ.ai ? (
        <div className="pad">
          <QA q={s.defQ.ai.q} a={s.defQ.ai.a} who="피고인" from="상대편" />
          <div className="center"><button className="btn main big" onClick={() => set({ phase: "CLOSING_STUDENT" })}>최종 진술로</button></div>
        </div>
      ) : null;

    case "CLOSING_STUDENT":
      return (
        <Writer
          title="최종 진술을 하십시오"
          hint="오늘 법정에서 나온 이야기를 정리해 마지막으로 주장합니다. 상대편 말 중 인정할 것이 있으면 인정하고, 그래도 왜 내 주장이 맞는지 밝히면 좋습니다."
          ph="재판장님. 오늘 이 법정에서 우리는…"
          value={draft} setValue={setDraft}
          cta="진술 마치기"
          rows={6}
          onSubmit={() => {
            if (draft.trim().length < 30) return need("조금 더 써 주세요. 오늘 들은 이야기를 정리해 보세요.");
            set({ closing: draft.trim() });
            clear();
            runAiClosing();
          }}
        />
      );

    case "VERDICT":
      return <Verdict s={s} set={set} setErr={setErr} onFinish={onFinish} />;

    case "SENTENCE":
      return (
        <div className="pad center">
          <button className="btn main big" onClick={onFinish}>재판 기록 보기</button>
        </div>
      );

    default:
      return null;
  }
}

function NextWitness({ s, set, overtime, runAiDefendantQ, skip }) {
  const canMore = s.witnesses.length < 2 && !overtime;
  return (
    <div className="row">
      {canMore && (
        <button className="btn main" onClick={() => set({ phase: "W_CALL" })}>
          {skip ? "재주신문 없이 다음 증인" : "다음 증인 부르기"}
        </button>
      )}
      <button className={`btn ${canMore ? "" : "main"}`} onClick={() => set({ phase: "DEF_STUDENT" })}>
        증인 신문을 마치고 피고인 신문으로
      </button>
    </div>
  );
}

function Writer({ title, hint, ph, value, setValue, cta, onSubmit, rows = 4, extra }) {
  return (
    <div className="pad">
      <p className="w-title">{title}</p>
      <p className="w-hint">{hint}</p>
      <textarea rows={rows} value={value} placeholder={ph} onChange={(e) => setValue(e.target.value)} />
      <div className="row">
        <button className="btn main" onClick={onSubmit}>{cta}</button>
        {extra}
      </div>
    </div>
  );
}

function QA({ q, a, who, from }) {
  return (
    <div className="qa">
      <p className="q">{from ? `${from}의 질문` : "내 질문"} — {q}</p>
      <p className="a"><b>{who}</b> {a}</p>
    </div>
  );
}

function Log({ w }) {
  if (!w) return null;
  const wt = witnessById(w.id);
  const rows = [
    ...w.direct.map((x) => ({ ...x, k: "내 주신문" })),
    ...w.cross.map((x) => ({ ...x, k: "상대편 반대신문" })),
    ...(w.redirect ? [{ ...w.redirect, k: "내 재주신문" }] : []),
  ].filter((x) => x.a);
  if (!rows.length) return null;
  return (
    <div className="log">
      <p className="log-head">증인 · {wt.name}</p>
      {rows.map((r, i) => (
        <div key={i} className="qa">
          <p className="q">{r.k} — {r.q}</p>
          <p className="a"><b>증인</b> {r.a}</p>
        </div>
      ))}
    </div>
  );
}

function Verdict({ s, set, setErr, onFinish }) {
  return (
    <div className="pad">
      <p className="w-title">배심원으로서 평결을 내리십시오</p>
      <p className="w-hint">
        생각이 처음과 달라져도 괜찮습니다. 달라진 것보다 무엇이 나를 바꾸었는지가 더 중요합니다.
      </p>
      <div className="verdicts">
        {VERDICTS.map((v) => (
          <button
            key={v.id}
            className={`vbtn ${s.verdict === v.id ? "on" : ""}`}
            onClick={() => set({ verdict: v.id })}
          >
            <b>{v.label}</b>
            <span>{v.note}</span>
          </button>
        ))}
      </div>
      <label className="fld">
        <span>왜 그렇게 판단했습니까? 오늘 법정에서 들은 것 가운데 결정적이었던 것을 들어 말하세요.</span>
        <textarea rows={4} value={s.reasons[0]} onChange={(e) => set((p) => ({ ...p, reasons: [e.target.value, p.reasons[1]] }))} />
      </label>
      <label className="fld">
        <span>상대편이나 증인의 말 중에 인정하게 된 것이 있습니까?</span>
        <textarea rows={3} value={s.reasons[1]} onChange={(e) => set((p) => ({ ...p, reasons: [p.reasons[0], e.target.value] }))} />
      </label>
      <div className="row">
        <button
          className="btn main big"
          onClick={() => {
            if (!s.verdict) return setErr("유죄, 일부 유죄, 무죄 중 하나를 고르세요.");
            if (s.reasons[0].trim().length < 20) return setErr("판단한 이유를 조금 더 써 주세요.");
            setErr(null);
            set({ phase: "SENTENCE", finishedAt: s.elapsed });
          }}
        >
          평결 제출
        </button>
      </div>
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
        <p className="rec-time">
          총 {longTime(s.finishedAt ?? s.elapsed)} · {s.date}
        </p>
        <div className="rec-compare">
          <div>
            <span>재판을 시작할 때 나는</span>
            <b>{seat?.title}</b>
            <p>{seat?.claim}</p>
          </div>
          <div>
            <span>재판을 끝내고 나는</span>
            <b>{v?.label}</b>
            <p>{v?.note}</p>
          </div>
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
  return (
    <div className="print">
      <h1>산업혁명 역사재판 기록</h1>
      <p className="ptopic">피고인 산업혁명은 인류를 끌어올렸는가, 아니면 수많은 사람을 짓밟았는가</p>
      <div className="pmeta">
        <span>날짜 {s.date}</span>
        <span>재판 시간 {longTime(s.finishedAt ?? s.elapsed)}</span>
        <span>이름 ____________</span>
      </div>

      <h2>1. 내가 맡은 자리</h2>
      <R l="자리">{seat?.title} — {seat?.claim}</R>
      <R l="모두진술">{s.opening}</R>

      <h2>2. 내가 낸 증거</h2>
      {s.evidence.map((e, i) => <R key={i} l={`증 제${i + 1}호증`}>{e}</R>)}
      <R l="상대편 모두진술">{s.aiOpening}</R>
      <R l="상대편 증거 인부">{s.aiEvidence}</R>

      {s.witnesses.map((w, i) => (
        <div key={i}>
          <h2>{3 + i}. 증인 {i + 1} · {witnessById(w.id).name}</h2>
          {w.direct.filter((x) => x.a).map((x, j) => (
            <div key={"d" + j}><R l="주신문">{x.q}</R><R l="증언">{x.a}</R></div>
          ))}
          {w.cross.filter((x) => x.a).map((x, j) => (
            <div key={"c" + j}><R l="반대신문">{x.q}</R><R l="증언">{x.a}</R></div>
          ))}
          {w.redirect?.a && (<><R l="재주신문">{w.redirect.q}</R><R l="증언">{w.redirect.a}</R></>)}
        </div>
      ))}

      <h2>{3 + s.witnesses.length}. 피고인 신문</h2>
      {s.defQ.mine && (<><R l="내 질문">{s.defQ.mine.q}</R><R l="피고인">{s.defQ.mine.a}</R></>)}
      {s.defQ.ai && (<><R l="상대편 질문">{s.defQ.ai.q}</R><R l="피고인">{s.defQ.ai.a}</R></>)}

      <h2>{4 + s.witnesses.length}. 최종 진술</h2>
      <R l="내 최종 진술">{s.closing}</R>
      <R l="상대편 최종 진술">{s.aiClosing}</R>
      <R l="피고인 최후진술">{s.lastWord}</R>

      <h2>{5 + s.witnesses.length}. 내 평결</h2>
      <R l="평결">{v?.label} — {v?.note}</R>
      <R l="그렇게 판단한 이유">{s.reasons[0]}</R>
      <R l="인정하게 된 것">{s.reasons[1]}</R>

      <h2>{6 + s.witnesses.length}. 생각의 변화</h2>
      <div className="pcompare">
        <div><strong>재판을 시작할 때</strong><p>{seat?.title}로서 {seat?.claim}</p><p>{s.opening}</p></div>
        <div><strong>재판을 끝내고</strong><p>{v?.label} — {v?.note}</p><p>{s.reasons[0]}</p></div>
      </div>
    </div>
  );
}
