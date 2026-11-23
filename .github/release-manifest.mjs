// Writes release/latest.json and release/notes.md: what the app reads to know whether a newer build
// exists, what changed since the build before it, and the SHA-256 of each installer.
//   node .github/release-manifest.mjs <release dir> [previous latest.json]
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, previousFile] = process.argv.slice(2);
const commit = process.env.GITHUB_SHA ?? "";
const build = Number(process.env.GITHUB_RUN_NUMBER ?? 0);

let previous = null;
try {
  if (previousFile && existsSync(previousFile)) previous = JSON.parse(readFileSync(previousFile, "utf8"));
} catch {}

const log = (range) => {
  try {
    return execFileSync("git", ["log", "--no-merges", "--format=%s", ...range], { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
};
// What changed since the last published build; without one (or if its commit is gone), the latest few.
const since = /^[0-9a-f]{40}$/.test(previous?.commit ?? "") ? log([`${previous.commit}..HEAD`]) : null;
const notes = (since ?? log(["-10"]) ?? []).filter((line) => !/^(ci|chore|test)(\(|:)/.test(line)).slice(0, 30);

const sha256 = {};
for (const name of readdirSync(dir)) {
  if (name === "latest.json" || name === "latest.json.sig" || name === "notes.md") continue;
  sha256[name] = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
}

const manifest = { build, commit, date: new Date().toISOString(), notes, sha256 };
const text = JSON.stringify(manifest, null, 2);
writeFileSync(join(dir, "latest.json"), text);
// The app ignores a manifest that is not signed with the release key (update.rs), so publishing without it is refused.
if (!process.env.RELEASE_SIGNING_KEY) throw new Error("RELEASE_SIGNING_KEY is not set: the release would be ignored by every installed app");
writeFileSync(join(dir, "latest.json.sig"), sign(null, Buffer.from(text), createPrivateKey(process.env.RELEASE_SIGNING_KEY)).toString("base64"));
writeFileSync(
  join(dir, "notes.md"),
  [
    `Killio App build ${build}, from ${commit.slice(0, 7)}.`,
    "",
    ...(notes.length ? ["What changed:", "", ...notes.map((n) => `- ${n}`), ""] : []),
    "Windows and macOS builds are not code-signed; the Android build is a preview.",
  ].join("\n"),
);
console.log(JSON.stringify(manifest, null, 2));
