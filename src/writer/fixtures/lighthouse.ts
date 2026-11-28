import { plotIds, type People, type Skeleton } from "../plot";

/**
 * A handwritten plot with twenty suspects: "The Lamp Went Out" / 《灯灭之夜》.
 *
 * It is what the model is asked to write, done by hand, so the compiler and the gates can
 * be tested without a model. Four people hold the key and have a motive. One of them,
 * Cormac Brandt, was in the lamp room at 22:20. Edmund Soler was there too and holds a
 * key, but has no motive; Isidore Abara was there without a key. The lamp was out, so the
 * two of them saw nothing: the scene description says so, or a player would rightly ask why
 * two people in the room did not see the blow.
 */
const PEOPLE: [given: string, family: string, zh: string, roleEn: string, roleZh: string][] = [
  ["Aldric", "Varga", "魏立群", "Keeper", "灯塔看守"],
  ["Beatrix", "Okonkwo", "欧碧翠", "Cook", "厨师"],
  ["Cormac", "Brandt", "柏康默", "Assistant keeper", "看守助手"],
  ["Delphine", "Marchetti", "马黛芬", "Surveyor", "测量员"],
  ["Edmund", "Soler", "苏艾蒙", "Mechanic", "机修工"],
  ["Fenella", "Nakamura", "纪菲娜", "Radio operator", "报务员"],
  ["Gideon", "Petrov", "裴吉登", "Supply captain", "补给船长"],
  ["Helena", "Lindqvist", "林海伦", "Doctor", "医生"],
  ["Isidore", "Abara", "阿伊多", "Painter", "油漆工"],
  ["Jocasta", "Castell", "卡乔莎", "Inspector's clerk", "督察文书"],
  ["Kasimir", "Dufresne", "杜卡西", "Deckhand", "水手"],
  ["Leonie", "Eklund", "艾莱昂", "Bookkeeper", "账房"],
  ["Magnus", "Farrow", "法马南", "Stoker", "司炉"],
  ["Nerissa", "Galvez", "高妮莎", "Botanist", "植物学者"],
  ["Octavia", "Hadley", "哈奥薇", "Schoolteacher", "教师"],
  ["Percival", "Ivers", "易柏西", "Carpenter", "木匠"],
  ["Quentin", "Jurado", "胡昆廷", "Chaplain", "牧师"],
  ["Rosalind", "Kessler", "柯罗琳", "Photographer", "摄影师"],
  ["Sebastian", "Lorne", "洛赛邦", "Apprentice", "学徒"],
  ["Tamsin", "Mendes", "孟谭欣", "Guest", "客人"],
];

export const lighthouseSkeleton: Skeleton = {
  title: { en: "The Lamp Went Out", zh: "灯灭之夜" },
  setting: { en: "A lighthouse on a rock, cut off by a storm.", zh: "礁石上的一座灯塔，被风暴困住。" },
  slots: ["22:00", "22:20", "22:40"],
  rooms: [
    { name: { en: "Lamp room", zh: "灯室" }, doors: ["Gallery"] },
    { name: { en: "Gallery", zh: "回廊" }, doors: ["Lamp room", "Kitchen"] },
    { name: { en: "Kitchen", zh: "厨房" }, doors: ["Gallery", "Cellar", "Boathouse"] },
    { name: { en: "Cellar", zh: "地窖" }, doors: ["Kitchen"] },
    { name: { en: "Boathouse", zh: "船屋" }, doors: ["Kitchen"] },
  ],
  victim: {
    name: { en: "Mr. Hale", zh: "何先生" },
    cause: {
      en: "Found at the foot of the lamp, struck with the winding handle. The lamp room was locked. The lamp had gone out, and in the dark no one in the room could see who struck.",
      zh: "倒在灯座下，被摇柄击中。灯室当时锁着。当时灯灭了，屋里一片漆黑，在场的人看不见是谁动的手。",
    },
  },
  means: { en: "A key to the lamp room", zh: "灯室钥匙" },
  motives: [
    { en: "Stood to lose their post in the inspector's report.", zh: "督察的报告会让此人丢掉职位。" },
    { en: "Owed the victim money that was due this week.", zh: "欠死者一笔本周到期的钱。" },
    { en: "Had been refused a share of the salvage.", zh: "打捞所得的分成被拒绝。" },
  ],
  suspects: PEOPLE.map(([given, family, zh, roleEn, roleZh], i) => ({
    name: { en: `${given} ${family}`, zh },
    role: { en: roleEn, zh: roleZh },
    persona: i % 2 === 0 ? { en: "Blunt and unhurried.", zh: "直来直去，不紧不慢。" } : { en: "Careful, and fond of detail.", zh: "谨慎，爱讲细节。" },
  })),
};

const ids = plotIds(lighthouseSkeleton);
const [LAMP, GALLERY, KITCHEN, CELLAR, BOAT] = ids.rooms as [string, string, string, string, string];
const stays = (room: string) => ids.slots.map((slot) => ({ slot, room }));

/** s-01, s-03, s-07 and s-12 hold a key and have a motive. s-03 is the culprit. */
const holdsKey = new Set(["s-01", "s-03", "s-05", "s-07", "s-12"]);
const motives: Record<string, string> = { "s-01": "mo-01", "s-03": "mo-02", "s-07": "mo-03", "s-12": "mo-01", "s-15": "mo-02" };
const places: Record<string, { slot: string; room: string }[]> = {
  "s-01": stays(GALLERY),
  "s-03": [
    { slot: "22:00", room: GALLERY },
    { slot: "22:20", room: LAMP },
    { slot: "22:40", room: GALLERY },
  ],
  "s-05": stays(LAMP),
  "s-07": stays(BOAT),
  "s-09": stays(LAMP),
  "s-12": stays(CELLAR),
};

export const lighthousePeople: People = {
  culprit: "s-03",
  suspects: ids.suspects.map((id) => ({ id, whereabouts: places[id] ?? stays(KITCHEN), has_means: holdsKey.has(id), motive: motives[id] ?? "none" })),
};
