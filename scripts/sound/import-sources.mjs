// Copies the chosen downloaded source recordings (unmodified) into assets/sounds/_src and
// records where each came from in assets/sounds/sources.json.
//   node scripts/sound/import-sources.mjs <downloadRoot>
// <downloadRoot> holds fs_<id>/ folders (Freesound previews + info.json from the page) and
// kenney_*/x/ (extracted Kenney packs). Nothing in them is executed; files are only copied.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DL = process.argv[2];
const SRC = path.join(ROOT, "assets/sounds/_src");
const FREESOUND = `200273 96729 672696 486270 637780 202898 640651 628404 706532 573175 331222 733731 637547 581232 572443 567945 795412 361772 744723
807942 637523 637533 592572 238289 119468 483166 172411 274766 618084 618082 590171 506665 741366 250095 655380 688869 450214 558397
546823 437935 806574 521590 813622 548384 556002 521587 235252 501015 445159 722717 776446 675760 871766 393823 449013 655812 785942
807384 513818 69572 270383 858114 858147 437337 145513 573805 772279 826131 554655 139110 505264 434225
423799 486234 718918 667284 321488 194628 656439`.split(/\s+/).filter(Boolean);
const KENNEY = {
  kenney_rpg: ["cloth1", "cloth2", "cloth3", "cloth4", "clothBelt", "clothBelt2", "beltHandle1", "beltHandle2", "handleSmallLeather", "handleSmallLeather2", "creak1", "creak2", "creak3", "metalClick", "metalLatch", "dropLeather"],
  kenney_impact: [0, 1, 2, 3, 4].flatMap((i) => [`impactPunch_heavy_00${i}`, `impactSoft_heavy_00${i}`]),
};
const PACKS = {
  kenney_rpg: { title: "RPG Audio", url: "https://kenney.nl/assets/rpg-audio" },
  kenney_impact: { title: "Impact Sounds", url: "https://kenney.nl/assets/impact-sounds" },
};

const records = [];
fs.mkdirSync(path.join(SRC, "freesound"), { recursive: true });
for (const id of FREESOUND) {
  const dir = path.join(DL, `fs_${id}`);
  const info = JSON.parse(fs.readFileSync(path.join(dir, "info.json"), "utf8"));
  if (!/publicdomain\/zero/.test(info.licence)) throw new Error(`${id} is not CC0`);
  const file = `freesound/${id}.ogg`;
  fs.copyFileSync(path.join(dir, `${id}.ogg`), path.join(SRC, file));
  records.push({
    key: `fs:${id}`,
    file,
    title: info.title,
    author: info.pageUrl.split("/")[4],
    url: info.pageUrl,
    licence: "CC0 1.0 (Creative Commons Zero)",
    licenceUrl: info.licence,
    obtained: "Freesound high-quality OGG preview (lossy, about 192 kbps Vorbis); the original upload needs a login",
    originalDuration: info.duration,
    fetched: info.fetched,
  });
}
for (const [pack, names] of Object.entries(KENNEY)) {
  fs.mkdirSync(path.join(SRC, pack), { recursive: true });
  const licence = fs.readFileSync(path.join(DL, pack, "x", "License.txt"), "utf8");
  if (!/CC0|Creative Commons Zero/i.test(licence)) throw new Error(`${pack} licence`);
  fs.copyFileSync(path.join(DL, pack, "x", "License.txt"), path.join(SRC, pack, "License.txt"));
  for (const n of names) {
    const file = `${pack}/${n}.ogg`;
    fs.copyFileSync(path.join(DL, pack, "x", "Audio", `${n}.ogg`), path.join(SRC, file));
    records.push({ key: `${pack}:${n}`, file, title: `${PACKS[pack].title}: ${n}.ogg`, author: "Kenney (kenney.nl)", url: PACKS[pack].url, licence: "CC0 1.0 (Creative Commons Zero)", licenceUrl: "http://creativecommons.org/publicdomain/zero/1.0/", obtained: "Original pack file (OGG Vorbis)" });
  }
}
fs.writeFileSync(path.join(ROOT, "assets/sounds/sources.json"), JSON.stringify(records, null, 1));
console.log(`${records.length} sources copied`);
