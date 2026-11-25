import type { Case } from "../schema";

/**
 * The handwritten pair: "The Archive at Nine" / 《九点的档案室》.
 *
 * Eight suspects. The victim dies in the archive at 21:00. Ada and Ben both hold a key and both
 * have a motive; both say they were in the foyer. Six others were photographed at dinner.
 *
 * - `archivePass`: the attendance log can be inspected. It places Ada in the archive and Ben in
 *   the foyer, so only Ada still fits, and her foyer claim is contradicted by a record.
 * - `archiveFailTwin`: the same hidden truth and the same log, but the one action that reaches
 *   the log is gone. Ada and Ben both still fit. The solver must refuse this case even though
 *   its answer key is perfectly consistent.
 */
export function buildArchiveCase(options: { attendanceLogReachable: boolean }): Case {
  const diners = [
    { id: "s-clara", en: "Clara Voss", zh: "沃克拉", roleEn: "Cook", roleZh: "厨师" },
    { id: "s-dev", en: "Dev Rao", zh: "饶德", roleEn: "Driver", roleZh: "司机" },
    { id: "s-elin", en: "Elin Sato", zh: "佐藤艾琳", roleEn: "Editor", roleZh: "编辑" },
    { id: "s-farid", en: "Farid Aziz", zh: "阿齐兹", roleEn: "Florist", roleZh: "花艺师" },
    { id: "s-grace", en: "Grace Lund", zh: "伦格蕾", roleEn: "Guest", roleZh: "客人" },
    { id: "s-hugo", en: "Hugo Petit", zh: "佩雨果", roleEn: "Housekeeper", roleZh: "管家" },
  ];
  const everywhere = (location: string) => ({ "20:40": location, "21:00": location, "21:20": location });

  return {
    id: options.attendanceLogReachable ? "archive-pass" : "archive-fail-twin",
    title: { en: "The Archive at Nine", zh: "九点的档案室" },
    setting: {
      en: "A private library on the night of its founder's dinner.",
      zh: "一座私人图书馆，创办人晚宴的当晚。",
    },
    slots: ["20:40", "21:00", "21:20"],
    locations: [
      { id: "l-foyer", name: { en: "Foyer", zh: "门厅" }, adjacent: ["l-archive", "l-dining"] },
      { id: "l-archive", name: { en: "Archive", zh: "档案室" }, adjacent: ["l-foyer"] },
      { id: "l-dining", name: { en: "Dining hall", zh: "餐厅" }, adjacent: ["l-foyer"] },
    ],
    victim: {
      name: { en: "Mr. Shen", zh: "沈先生" },
      death: { slot: "21:00", location: "l-archive" },
      found: { slot: "21:20", location: "l-archive" },
      means: "m-key",
      cause: {
        en: "Struck from behind inside the locked archive. Only a key holder could have entered.",
        zh: "在上锁的档案室内被人从背后击倒。只有持钥匙的人才能进入。",
      },
    },
    means: [{ id: "m-key", name: { en: "A key to the archive", zh: "档案室钥匙" } }],
    motives: [
      { id: "mo-debt", text: { en: "Owed the victim a debt that was about to be called in.", zh: "欠死者一笔即将被追讨的债。" } },
      { id: "mo-will", text: { en: "Was about to be written out of the will.", zh: "即将被从遗嘱中除名。" } },
    ],
    suspects: [
      {
        id: "s-ada",
        name: { en: "Ada Marlow", zh: "马艾达" },
        role: { en: "Archivist's assistant", zh: "档案助理" },
        persona: { en: "Precise, quick to correct others, hates being rushed.", zh: "一丝不苟，爱纠正别人，讨厌被催。" },
        whereabouts: { "20:40": "l-foyer", "21:00": "l-archive", "21:20": "l-foyer" },
        means: ["m-key"],
        motives: ["mo-debt"],
        lies: ["a-ada-foyer-2100"],
      },
      {
        id: "s-ben",
        name: { en: "Ben Okafor", zh: "欧本" },
        role: { en: "Bookkeeper", zh: "账房" },
        persona: { en: "Dry, tired, answers in as few words as he can.", zh: "冷淡疲惫，能少说一个字就少说一个字。" },
        whereabouts: everywhere("l-foyer"),
        means: ["m-key"],
        motives: ["mo-will"],
        lies: [],
      },
      ...diners.map((d) => ({
        id: d.id,
        name: { en: d.en, zh: d.zh },
        role: { en: d.roleEn, zh: d.roleZh },
        persona: { en: "Polite and a little bored.", zh: "客气，略显无聊。" },
        whereabouts: everywhere("l-dining"),
        means: [],
        motives: [],
        lies: [],
      })),
    ],
    assertions: [
      { id: "a-ada-foyer-2100", prop: { kind: "at", subject: "s-ada", slot: "21:00", location: "l-foyer" } },
      { id: "a-ada-archive-2100", prop: { kind: "at", subject: "s-ada", slot: "21:00", location: "l-archive" } },
      { id: "a-ben-foyer-2100", prop: { kind: "at", subject: "s-ben", slot: "21:00", location: "l-foyer" } },
      { id: "a-ada-key", prop: { kind: "means", subject: "s-ada", means: "m-key", value: true } },
      { id: "a-ben-key", prop: { kind: "means", subject: "s-ben", means: "m-key", value: true } },
      { id: "a-ada-debt", prop: { kind: "motive", subject: "s-ada", motive: "mo-debt", value: true } },
      { id: "a-ben-will", prop: { kind: "motive", subject: "s-ben", motive: "mo-will", value: true } },
      ...diners.map((d) => ({
        id: `a-${d.id.slice(2)}-dining-2100`,
        prop: { kind: "at" as const, subject: d.id, slot: "21:00", location: "l-dining" },
      })),
    ],
    evidence: [
      {
        id: "e-key-register",
        kind: "record",
        authoritative: true,
        proves: ["a-ada-key", "a-ben-key"],
        text: { en: "Key register: archive keys are signed out to Ada Marlow and Ben Okafor.", zh: "钥匙登记簿：档案室钥匙由马艾达和欧本签领。" },
      },
      {
        id: "e-letters",
        kind: "record",
        authoritative: true,
        proves: ["a-ada-debt", "a-ben-will"],
        text: { en: "The victim's letters: a demand for Ada's debt, and a draft will that drops Ben.", zh: "死者的信件：向马艾达追债的催告，以及一份把欧本除名的遗嘱草稿。" },
      },
      {
        id: "e-dinner-photo",
        kind: "record",
        authoritative: true,
        proves: diners.map((d) => `a-${d.id.slice(2)}-dining-2100`),
        text: { en: "A timestamped photo of the dinner table at 21:00 showing six guests seated.", zh: "一张 21:00 的带时间戳的餐桌照片，六位客人都在座。" },
      },
      {
        id: "e-attendance-log",
        kind: "record",
        authoritative: true,
        proves: ["a-ada-archive-2100", "a-ben-foyer-2100"],
        text: { en: "Archive door log, 21:00: Ada Marlow's key opened the archive. Foyer desk log, 21:00: Ben Okafor signed for a parcel.", zh: "档案室门禁记录 21:00：马艾达的钥匙开了门。门厅前台记录 21:00：欧本签收了一个包裹。" },
      },
    ],
    briefing: { evidence: ["e-key-register", "e-letters", "e-dinner-photo"] },
    actions: {
      topics: [
        { id: "t-ada-2100", suspect: "s-ada", label: { en: "Where were you at 21:00?", zh: "21:00 你在哪里？" }, yields: ["a-ada-foyer-2100"] },
        { id: "t-ben-2100", suspect: "s-ben", label: { en: "Where were you at 21:00?", zh: "21:00 你在哪里？" }, yields: ["a-ben-foyer-2100"] },
      ],
      inspections: options.attendanceLogReachable
        ? [{ id: "i-attendance-log", label: { en: "Inspect the door and desk logs", zh: "查看门禁和前台记录" }, yields: ["e-attendance-log"] }]
        : [],
    },
    culprit: { suspect: "s-ada", motive: "mo-debt" },
    sessionCap: 40,
  };
}

export const archivePass: Case = buildArchiveCase({ attendanceLogReachable: true });
export const archiveFailTwin: Case = buildArchiveCase({ attendanceLogReachable: false });
