// OBL merges only: materialize missing Oogatron contributors before the site build.
// Existing handles AND GitHub aliases always win, including a just-merged custom file.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCharacters } from "./characters.mjs";
import { MAX_CHARACTERS, contributorRows, readContributorSnapshot } from "../worker/src/contributor-policy.js";
import { checkCharacterIdentities, mergedPull } from "./contributor-pr.mjs";
import { declaredIdentity } from "./character-identity.mjs";
import { CharacterRejection, parseSafeCharacter } from "./character-safety.mjs";
import { createGitHub } from "./character-github.mjs";
import { queuedCharacters } from "./character-submissions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const missingCharacters = (rows, existing, pending = []) => {
  const taken = new Set();
  for (const row of [...existing, ...pending.map((entry) => entry.character)]) {
    taken.add(row.handle.toLowerCase());
    if (row.github) taken.add(row.github.toLowerCase());
  }
  return rows.filter((row) => !taken.has(row.handle.toLowerCase()));
};
export const characterSource = (row) => `// Default Ooga from Oogatron; customize this file to give it a look or voice.
(() => {
  "use strict";
  const BL = window.BL;
  BL.characters.add({
    handle: ${JSON.stringify(row.handle)},
    joined: ${row.joined},
    lastCommit: ${row.lastCommit}
  });
})();
`;

// Recover a default created while a new custom character waited in a bundle.
// Existing-profile edits keep their base; only exact, untouched generator output
// for an identity reserved by a queued addition can be withdrawn automatically.
export const queuedDefaults = (pending, sourceFor) => {
  const retired = [];
  for (const entry of pending) {
    if (entry.base !== null) continue;
    const identity = entry.character;
    for (const name of new Set([identity.handle, identity.github].filter(Boolean).map((key) => key.toLowerCase()))) {
      const file = `${name}.js`, source = sourceFor(file);
      if (!source || retired.some((row) => row.file === file)) continue;
      let row;
      try { row = parseSafeCharacter(source); }
      catch (error) { if (!(error instanceof CharacterRejection)) throw error; continue; }
      if (source === characterSource(row) && row.handle.toLowerCase() === name) retired.push({ file, source });
    }
  }
  return retired;
};

// Only untouched generated aliases may retire, and only when their confirmed
// owner already has a character. A custom look/voice/source is never removed.
export const retiredCharacters = (existing, sourceFor) => {
  const retired = [];
  for (const row of existing) {
    const owner = globalThis.BL.contributorIdentities.ownerOf(row.handle);
    if (owner === row.handle || !existing.some((c) => c !== row && [c.handle, c.github].some((key) => key?.toLowerCase() === owner.toLowerCase()))) continue;
    const file = `${row.handle.toLowerCase()}.js`, source = sourceFor(file);
    if (source === characterSource(row)) retired.push({ file, source });
  }
  return retired;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(root, "untracked", "new-characters"), retirement = join(out, "retired.json");
  const sourceFor = (file) => { const path = join(root, "src", "characters", file); return existsSync(path) ? readFileSync(path, "utf8") : null; };
  const readQueued = () => queuedCharacters(createGitHub(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN), process.env.CHARACTER_BOT_LOGIN);
  if (process.argv[2] === "--retired-artifact") {
    const records = existsSync(retirement) ? JSON.parse(readFileSync(retirement, "utf8")) : [];
    if (!Array.isArray(records) || records.length > MAX_CHARACTERS || new Set(records.map((r) => r?.file)).size !== records.length) throw new Error("Invalid retired character artifact");
    // The writer holds credentials: parse declarations as text, never run them.
    const identities = readdirSync(join(root, "src", "characters")).filter((file) => file.endsWith(".js")).map((file) => declaredIdentity(sourceFor(file)));
    const queued = queuedDefaults(await readQueued(), sourceFor);
    const allowed = [...retiredCharacters([...records.map((r) => parseSafeCharacter(r.source)), ...identities], sourceFor), ...queued];
    if (records.some((r) => !allowed.some((a) => a.file === r.file && a.source === r.source))) throw new Error("Retired character artifact does not match an untouched alias or queued default");
    for (const file of new Set([...records, ...queued].map((row) => row.file))) rmSync(join(root, "src", "characters", file));
    process.exit(0);
  }
  let changed = [], pending = [];
  if (process.argv[2] === "--merge") {
    const pr = await mergedPull();
    if (!pr) { console.log("characters: not an OBL PR merge; no reconciliation"); process.exit(0); }
    changed = await checkCharacterIdentities(pr, true);
    pending = await readQueued();
  }
  // A saved raw snapshot is useful for a reproducible build; the baked jumbotron
  // deliberately omits first_seen_at and is not an onboarding source.
  const stats = process.argv[2] && process.argv[2] !== "--merge" ? JSON.parse(readFileSync(process.argv[2], "utf8")) : await readContributorSnapshot();
  const existing = readCharacters(), missing = missingCharacters(contributorRows(stats), existing, pending);
  const retired = retiredCharacters(existing, sourceFor);
  for (const row of queuedDefaults(pending, sourceFor)) if (!retired.some((old) => old.file === row.file)) retired.push(row);
  if (existing.length - retired.length + missing.length > MAX_CHARACTERS) throw new Error(`Character capacity ${MAX_CHARACTERS} exceeded; review crew and NPC frame budgets before increasing it`);
  for (const row of missing) {
    // Exclusive creation is a second guard: never overwrite even an unregistered file.
    writeFileSync(join(root, "src", "characters", `${row.handle}.js`), characterSource(row), { flag: "wx" });
  }
  for (const row of retired) rmSync(join(root, "src", "characters", row.file));
  changed = changed.filter((file) => !retired.some((row) => row.file === file));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify([...changed, ...missing.map((row) => `${row.handle}.js`)]) + "\n");
  writeFileSync(retirement, JSON.stringify(retired) + "\n");
  for (const row of missing) writeFileSync(join(out, `${row.handle}.js`), characterSource(row));
  for (const file of changed) writeFileSync(join(out, file), readFileSync(join(root, "src", "characters", file)));
  console.log(`characters: added ${missing.length}, retired ${retired.length} untouched aliases or queued defaults, preserved custom profiles`);
}
