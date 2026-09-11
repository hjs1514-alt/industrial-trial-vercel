/* 화면에 보이는 정보만 담습니다. AI 프롬프트는 서버(api/_prompts.js)에 있습니다. */

export const WITNESSES = [
  {
    id: "child",
    name: "아동 노동자",
    era: "실 잇는 아이 · 11세",
    img: "child",
    tags: ["새벽에 출근", "기계 밑 청소", "가족 생계를 도움", "학교에 못 감"],
  },
  {
    id: "woman",
    name: "여성 노동자",
    era: "방적공장 · 20대 기혼 여성",
    img: "woman",
    tags: ["남성보다 적은 임금", "일과 집안일", "처음 쥐어 본 내 돈"],
  },
  {
    id: "worker",
    name: "공장 노동자",
    era: "맨체스터 방직공장 · 30대 남성",
    img: "worker",
    tags: ["하루 12시간 넘게", "벌금 제도", "작업장 사고", "농촌에서 온 삶"],
  },
  {
    id: "owner",
    name: "공장 자본가",
    era: "면방직 공장 주인 · 40대",
    img: "owner",
    tags: ["기계에 큰돈 투자", "많이 빨리 만듦", "일자리를 만듦", "규제가 싫음"],
  },
  {
    id: "reformer",
    name: "사회개혁가",
    era: "의회 조사에 참여한 운동가",
    img: "reformer",
    tags: ["공장 실태 조사", "공장법 제정", "현장 증언 수집", "너무 늦은 개혁"],
  },
];

export const witnessById = (id) => WITNESSES.find((w) => w.id === id);

/* 학생이 앉을 자리 */
export const SEATS = {
  defense: {
    id: "defense",
    title: "변호인",
    plain: "산업혁명을 변호하는 자리",
    claim: "산업혁명은 인류의 삶을 크게 끌어올렸다",
    goal: "무죄를 주장한다",
  },
  prosecution: {
    id: "prosecution",
    title: "검사",
    plain: "산업혁명을 고발하는 자리",
    claim: "산업혁명은 노동자와 사회에 큰 피해를 남겼다",
    goal: "유죄를 주장한다",
  },
};

export const other = (side) => (side === "defense" ? "prosecution" : "defense");

/* 어려운 말은 눌러서 뜻을 볼 수 있게 합니다. */
export const GLOSSARY = {
  피고인: "재판에서 잘못했다고 지목되어 판단을 받는 쪽. 이 재판에서는 산업혁명이 피고인입니다.",
  변호인: "피고인을 감싸며 잘못이 없다고 주장하는 사람.",
  검사: "피고인이 잘못했다고 주장하며 고발하는 사람.",
  증인: "그 일을 직접 겪어서 법정에 나와 이야기해 주는 사람.",
  무죄: "잘못이 없다는 판단.",
  유죄: "잘못이 있다는 판단.",
};

/* 화면 위에 항상 떠 있는 절차 안내 */
export const PHASE_INFO = {
  LOBBY: { label: "입정 전", desc: "법정에 들어가기 전입니다." },
  OPEN: { label: "재판 시작", desc: "판사가 피고인을 확인합니다." },
  IDENTIFY: { label: "피고인 확인", desc: "누가 이 재판의 피고인인지 밝힙니다." },
  SEAT: { label: "자리 선택", desc: "산업혁명을 변호할지 고발할지 고릅니다." },
  OPENING: { label: "첫 주장", desc: "내 주장과 그 까닭 한 가지를 밝힙니다." },
  DEBATE: { label: "토론", desc: "상대편과 번갈아 주장을 주고받습니다." },
  W_PICK: { label: "증인 신청", desc: "그 시대를 살았던 사람을 부릅니다." },
  W_ASK: { label: "증인 심문", desc: "증인에게 직접 물어봅니다." },
  W_CROSS: { label: "증인 심문", desc: "반대편도 같은 증인에게 묻습니다." },
  W_DONE: { label: "증인 심문", desc: "증언이 끝났습니다." },
  CLOSING: { label: "마지막 말", desc: "양측이 마지막으로 정리합니다." },
  VERDICT: { label: "나의 판단", desc: "이제 내가 결론을 내립니다." },
  SENTENCE: { label: "재판 종료", desc: "판사가 재판을 끝냅니다." },
  RECORD: { label: "기록", desc: "재판이 끝났습니다." },
};

/* 판사는 진행만 맡습니다. 대사는 전부 고정 대본이고 AI를 호출하지 않습니다.
   절차 이름을 말한 뒤에는 반드시 쉬운 풀이를 한 줄 붙입니다. */
export const JUDGE = {
  open: [
    "모두 자리에 앉아 주십시오.",
    "지금부터 「산업혁명」에 대한 재판을 시작합니다.",
    "피고인은 앞으로 나오십시오. 성명이 무엇입니까?",
  ],
  identified: [
    "오늘 이 법정이 가릴 것은 하나입니다.",
    "산업혁명은 인류를 끌어올렸는가, 아니면 사람들을 짓밟았는가.",
  ],
  seat: [
    "귀하는 어느 자리에 서겠습니까?",
    "한번 앉으면 재판이 끝날 때까지 그 자리를 지켜야 합니다.",
  ],
  opening: [
    "그럼 먼저 귀하의 주장을 말씀하십시오.",
    "산업혁명을 왜 그렇게 보는지, 그리고 그렇게 보는 까닭 한 가지를 함께 밝히시면 됩니다.",
  ],
  debate: [
    "이제 양측은 자유롭게 다투십시오.",
    "그 시대를 살았던 사람을 불러 묻고 싶으면 언제든 증인을 신청하실 수 있습니다.",
  ],
  witnessCall: ["증인을 신청하십시오. 오늘 부를 수 있는 증인은 두 사람까지입니다."],
  witnessAsk: ["증인에게 물으십시오."],
  witnessCross: ["반대편도 같은 증인에게 한 가지 묻겠습니다."],
  witnessDone: ["증인은 물러가셔도 좋습니다. 다시 다투십시오."],
  closing: ["이것으로 다툼을 마칩니다. 양측은 마지막으로 할 말을 하십시오."],
  verdict: [
    "그런데 이 법정에는 판단할 사람이 한 분뿐입니다.",
    "방금까지 저 자리에서 다투던 바로 그분입니다.",
    "귀하는 이제 자기가 싸운 사건을 스스로 판단해야 합니다.",
  ],
  sentence: [
    "판단을 확인했습니다.",
    "이 법정은 그 판단이 맞다 틀리다 말하지 않습니다.",
    "역사를 어떻게 볼지는 재판을 직접 겪은 사람이 정하는 것입니다.",
    "이상으로 재판을 마칩니다.",
  ],
};

export const DEFENDANT_LINES = {
  name: "산업혁명입니다.",
  origin:
    "잉글랜드 가운데의 탄광과 방직공장 마을에서, 1760년 무렵에 태어났습니다. 지금은 이 세상 거의 모든 곳에 제 흔적이 남아 있습니다.",
};

export const VERDICTS = [
  { id: "guilty", label: "유죄", note: "남긴 피해가 이룬 성과보다 무겁다" },
  { id: "partial", label: "일부 유죄", note: "성과와 피해가 함께 있고 어느 쪽도 지울 수 없다" },
  { id: "notguilty", label: "무죄", note: "이룬 성과가 치른 대가보다 크다" },
];

export const TOTAL_MIN = 45;                     // 재판 시간. 여기만 고치면 전부 따라옵니다.
export const TOTAL_SEC = TOTAL_MIN * 60;
export const WARN_SEC = (TOTAL_MIN - 5) * 60;    // 끝나기 5분 전 알림
