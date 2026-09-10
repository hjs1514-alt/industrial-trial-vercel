import React from "react";
import { WITNESSES, witnessById } from "./data.js";

/* ============================================================
   법정 무대.
   배경 그림 위에 인물 그림을 얹습니다.
   인물마다 '가림선'이 있어 판사석·증인석·탁자 뒤에 선 것처럼 보입니다.
   숫자는 모두 화면 대비 비율이라 어떤 크기에서도 같은 자리에 섭니다.
   ============================================================ */

const IMG = (n) => `${import.meta.env.BASE_URL}img/${n}.webp`;

/* cx 가로중심 · headY 머리끝 · h 키 · clipY 이 선 아래는 가려짐 */
const MARK = {
  judge: { cx: 0.5, headY: 0.14, h: 0.47, clipY: 0.352 },
  witness: { cx: 0.655, headY: 0.205, h: 0.46, clipY: 0.412 },
  left: { cx: 0.205, headY: 0.25, h: 0.61, clipY: 0.545 },
  right: { cx: 0.8, headY: 0.25, h: 0.61, clipY: 0.545 },
  defendant: { cx: 0.5, headY: 0.3, h: 0.4, clipY: 0.72 },
};

function Actor({ img, mark, dim, label }) {
  return (
    <div
      className={`actor ${dim ? "dim" : ""}`}
      style={{
        left: `${mark.cx * 100}%`,
        top: `${mark.headY * 100}%`,
        height: `${(mark.clipY - mark.headY) * 100}%`,
      }}
    >
      <img
        src={IMG(img)}
        alt={label}
        draggable="false"
        style={{ height: `${(mark.h / (mark.clipY - mark.headY)) * 100}%` }}
      />
    </div>
  );
}

/* 피고인 「산업혁명」은 사람이 아니라서 그림이 없습니다.
   증기와 톱니로 된 형체로 세웁니다. */
function Defendant({ dim, speaking }) {
  const m = MARK.defendant;
  return (
    <div
      className={`actor defendant ${dim ? "dim" : ""} ${speaking ? "alive" : ""}`}
      style={{
        left: `${m.cx * 100}%`,
        top: `${m.headY * 100}%`,
        height: `${(m.clipY - m.headY) * 100}%`,
      }}
      aria-label="피고인 산업혁명"
    >
      <svg viewBox="0 0 120 300" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id="smoke" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6E625A" stopOpacity="0.14" />
            <stop offset="45%" stopColor="#453B34" stopOpacity="0.72" />
            <stop offset="100%" stopColor="#2A231E" stopOpacity="0.92" />
          </linearGradient>
        </defs>
        <path
          d="M60 8 C40 30 34 52 40 74 C22 96 16 140 22 190 C26 232 34 268 38 296
             L82 296 C86 268 94 232 98 190 C104 140 98 96 80 74 C86 52 80 30 60 8 Z"
          fill="url(#smoke)"
        />
        <circle cx="60" cy="52" r="17" fill="#3A322C" opacity="0.85" />
        <g stroke="#C9A227" strokeWidth="3" fill="none" opacity="0.75">
          <circle cx="60" cy="150" r="19" />
          <circle cx="60" cy="150" r="5" fill="#C9A227" />
          {[0, 45, 90, 135].map((a) => (
            <line
              key={a}
              x1={60 + 19 * Math.cos((a * Math.PI) / 180)}
              y1={150 + 19 * Math.sin((a * Math.PI) / 180)}
              x2={60 + 25 * Math.cos((a * Math.PI) / 180)}
              y2={150 + 25 * Math.sin((a * Math.PI) / 180)}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

export default function Courtroom({
  active,
  side,
  standWitness,
  usedWitnesses = [],
  picking = false,
  onCallWitness,
}) {
  const meLeft = side !== "prosecution";
  const meMark = meLeft ? MARK.left : MARK.right;
  const aiMark = meLeft ? MARK.right : MARK.left;
  const w = standWitness ? witnessById(standWitness) : null;
  const off = (who) => Boolean(active) && active !== who;

  return (
    <div className="court">
      <img className="court-bg" src={IMG("courtroom")} alt="법정" draggable="false" />

      <Actor img="judge" mark={MARK.judge} dim={off("judge")} label="판사" />
      {w && <Actor img={w.img} mark={MARK.witness} dim={off("witness")} label={`증인 ${w.name}`} />}
      <Defendant dim={off("defendant")} speaking={active === "defendant"} />
      <Actor img="lawyer-a" mark={meMark} dim={off("me")} label="나" />
      <Actor img="lawyer-b" mark={aiMark} dim={off("ai")} label="상대편" />

      <span className="tag" style={{ left: `${meMark.cx * 100}%` }}>
        {side === "prosecution" ? "검사" : "변호인"} · 나
      </span>
      <span className="tag foe" style={{ left: `${aiMark.cx * 100}%` }}>
        {side === "prosecution" ? "변호인" : "검사"} · 상대편
      </span>
      {w && (
        <span className="tag wit" style={{ left: `${MARK.witness.cx * 100}%` }}>
          증인 · {w.name}
        </span>
      )}

      {picking && (
        <div className="waiting">
          <p className="waiting-head">증인 대기실</p>
          <p className="waiting-sub">부르고 싶은 사람을 고르세요</p>
          <div className="waiting-row">
            {WITNESSES.map((wt) => {
              const used = usedWitnesses.includes(wt.id);
              return (
                <button
                  key={wt.id}
                  className={`cand ${used ? "used" : ""}`}
                  disabled={used}
                  onClick={() => onCallWitness(wt.id)}
                >
                  <span className="cand-art">
                    <img src={IMG(wt.img)} alt="" draggable="false" />
                    {used && <em>증언 마침</em>}
                  </span>
                  <b>{wt.name}</b>
                  <span className="cand-era">{wt.era}</span>
                  <span className="cand-tags">{wt.tags.slice(0, 3).join(" · ")}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
