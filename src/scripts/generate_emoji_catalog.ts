import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type EmojiEntry = {
  label?: string;
  hexcode: string;
  emoji?: string;
  tags?: string[];
  group?: number;
  subgroup?: number;
  version?: number;
  type?: number;
  skins?: EmojiEntry[];
};

type EmojiMessages = {
  groups?: Array<{ order: number; message: string }>;
  subgroups?: Array<{ order: number; message: string }>;
};

type CatalogRow = {
  emoji: string;
  hexcode: string;
  unicodeVersion: number | null;
  labelEn: string;
  labelEs: string;
  labelPt: string;
  tagsEn: string[];
  tagsEs: string[];
  tagsPt: string[];
  groupEn: string;
  groupEs: string;
  groupPt: string;
  subgroupEn: string;
  subgroupEs: string;
  subgroupPt: string;
  whatsappIOS: boolean;
  whatsappAndroid: boolean;
  whatsappNote: string;
};

function fromHexcode(hexcode: string): string {
  const points = String(hexcode ?? "")
    .split("-")
    .map((part) => parseInt(part, 16))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (points.length === 0) return "";
  try {
    return String.fromCodePoint(...points);
  } catch {
    return "";
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function csvCell(value: string): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function asMapByHex(rows: EmojiEntry[]): Map<string, EmojiEntry> {
  const map = new Map<string, EmojiEntry>();
  for (const row of rows) {
    map.set(String(row.hexcode), row);
  }
  return map;
}

function flattenEntries(rows: EmojiEntry[]): EmojiEntry[] {
  const out: EmojiEntry[] = [];
  const walk = (entry: EmojiEntry): void => {
    out.push(entry);
    if (Array.isArray(entry.skins)) {
      for (const skin of entry.skins) walk(skin);
    }
  };
  for (const row of rows) walk(row);
  return out;
}

function messageByOrder(
  list: Array<{ order: number; message: string }> | undefined,
  order: number | undefined
): string {
  if (!list || !Number.isFinite(Number(order))) return "";
  const hit = list.find((x) => Number(x.order) === Number(order));
  return hit?.message ?? "";
}

function buildCsv(rows: CatalogRow[]): string {
  const header = [
    "emoji",
    "hexcode",
    "unicodeVersion",
    "label_en",
    "label_es",
    "label_pt",
    "tags_en",
    "tags_es",
    "tags_pt",
    "group_en",
    "group_es",
    "group_pt",
    "subgroup_en",
    "subgroup_es",
    "subgroup_pt",
    "whatsapp_ios",
    "whatsapp_android",
    "whatsapp_note"
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.emoji,
        row.hexcode,
        row.unicodeVersion == null ? "" : String(row.unicodeVersion),
        row.labelEn,
        row.labelEs,
        row.labelPt,
        row.tagsEn.join("|"),
        row.tagsEs.join("|"),
        row.tagsPt.join("|"),
        row.groupEn,
        row.groupEs,
        row.groupPt,
        row.subgroupEn,
        row.subgroupEs,
        row.subgroupPt,
        String(row.whatsappIOS),
        String(row.whatsappAndroid),
        row.whatsappNote
      ].map(csvCell).join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const packagePath = require.resolve("emojibase-data/package.json");
  const base = dirname(packagePath);
  const enData = flattenEntries(readJson<EmojiEntry[]>(join(base, "en", "data.json")));
  const esData = flattenEntries(readJson<EmojiEntry[]>(join(base, "es", "data.json")));
  const ptData = flattenEntries(readJson<EmojiEntry[]>(join(base, "pt", "data.json")));
  const enMsgs = readJson<EmojiMessages>(join(base, "en", "messages.json"));
  const esMsgs = readJson<EmojiMessages>(join(base, "es", "messages.json"));
  const ptMsgs = readJson<EmojiMessages>(join(base, "pt", "messages.json"));

  const byHexEs = asMapByHex(esData);
  const byHexPt = asMapByHex(ptData);

  const catalog: CatalogRow[] = enData.map((en) => {
    const es = byHexEs.get(en.hexcode);
    const pt = byHexPt.get(en.hexcode);
    const emoji = String(en.emoji || fromHexcode(en.hexcode) || "");
    const version = Number.isFinite(Number(en.version)) ? Number(en.version) : null;
    const requiresNewerOS = version != null && version > 13;
    return {
      emoji,
      hexcode: en.hexcode,
      unicodeVersion: version,
      labelEn: String(en.label ?? ""),
      labelEs: String(es?.label ?? ""),
      labelPt: String(pt?.label ?? ""),
      tagsEn: Array.isArray(en.tags) ? en.tags.map(String) : [],
      tagsEs: Array.isArray(es?.tags) ? es!.tags!.map(String) : [],
      tagsPt: Array.isArray(pt?.tags) ? pt!.tags!.map(String) : [],
      groupEn: messageByOrder(enMsgs.groups, en.group),
      groupEs: messageByOrder(esMsgs.groups, en.group),
      groupPt: messageByOrder(ptMsgs.groups, en.group),
      subgroupEn: messageByOrder(enMsgs.subgroups, en.subgroup),
      subgroupEs: messageByOrder(esMsgs.subgroups, en.subgroup),
      subgroupPt: messageByOrder(ptMsgs.subgroups, en.subgroup),
      whatsappIOS: true,
      whatsappAndroid: true,
      whatsappNote: requiresNewerOS
        ? "Rendered in WhatsApp when iOS/Android Unicode support includes this version."
        : "Widely supported in WhatsApp on modern iOS/Android."
    };
  });

  const outDir = resolve("generated", "emoji");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, "whatsapp_emoji_catalog_all.json");
  const csvPath = join(outDir, "whatsapp_emoji_catalog_all.csv");
  const readmePath = join(outDir, "README.md");

  writeFileSync(jsonPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, buildCsv(catalog), "utf8");

  const newer = catalog.filter((row) => (row.unicodeVersion ?? 0) > 13).length;
  const readme = [
    "# WhatsApp Emoji Catalog (iOS + Android)",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Total rows: ${catalog.length}`,
    `Rows requiring newer OS Unicode support (version > 13): ${newer}`,
    "",
    "Files:",
    `- ${jsonPath}`,
    `- ${csvPath}`,
    "",
    "Notes:",
    "- This is derived from Unicode/CLDR emoji data (Emojibase).",
    "- WhatsApp transports Unicode emoji; visual rendering depends on OS emoji font support.",
    "- Labels and tags are provided in English, Spanish, and Portuguese."
  ].join("\n");
  writeFileSync(readmePath, `${readme}\n`, "utf8");

  process.stdout.write(`Emoji catalog generated: ${catalog.length} rows\n`);
  process.stdout.write(`- ${jsonPath}\n`);
  process.stdout.write(`- ${csvPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`generate_emoji_catalog failed: ${String((error as Error)?.message ?? error)}\n`);
  process.exit(1);
});
