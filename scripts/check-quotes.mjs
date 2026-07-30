#!/usr/bin/env node
// Deutsche Anführungszeichen: „ (U+201E) öffnet, " (U+201C) schließt.
// Falsch sind Paare, die mit " (U+201D) oder ASCII-" schließen. Ausgenommen:
// Code-Fences (```) und ASCII-" direkt vor einem Wortzeichen (Zoll, Inline-Code).
//
//   node scripts/check-quotes.mjs [--fix] [dateien...]
//
// Ohne Dateiliste werden die von Git getrackten Dateien gescannt; --fix
// korrigiert in place (es wird nur der Closer-Glyph getauscht, sonst nichts).
import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { execFileSync } from "node:child_process";

const LOW9 = "„", LEFT = "“", RIGHT = "”", ASCII = '"';
const SPECIALS = new Set([LOW9, LEFT, RIGHT, ASCII]);
const WORD = /[0-9A-Za-zäöüÄÖÜß]/;
const EXTS = new Set([".md", ".mdx", ".ts", ".tsx", ".js", ".jsx", ".html"]);

// Zeichen-Offsets innerhalb von ```-Fences (dort wird nie angefasst).
function fencedPositions(content) {
  const pos = new Set();
  let offset = 0, inBlock = false;
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("```")) inBlock = !inBlock;
    else if (!inBlock) { offset += line.length + 1; continue; }
    for (let k = offset; k < offset + line.length + 1; k += 1) pos.add(k);
    offset += line.length + 1;
  }
  return pos;
}

// Ein Durchlauf: findet falsche Paare und korrigiert sie optional gleich.
function scan(content) {
  const fenced = fencedPositions(content);
  const chars = content.split("");
  const findings = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== LOW9 || fenced.has(i)) { i += 1; continue; }
    let j = i + 1;
    while (j < chars.length && !SPECIALS.has(chars[j])) j += 1;
    if (j >= chars.length) break;
    const closer = chars[j];
    if (closer === LOW9) { i = j; continue; } // neuer Opener, kein Closer davor
    if (closer === RIGHT || (closer === ASCII && !WORD.test(chars[j + 1] ?? ""))) {
      findings.push({ line: content.slice(0, i).split("\n").length, at: j });
    }
    i = j + 1;
  }
  for (const f of findings) chars[f.at] = LEFT;
  return { fixedContent: chars.join(""), findings };
}

// Die Dateiliste kommt von Git, nicht aus einem Baum-Walk: ein Walk erfasst
// auch ignorierte Verzeichnisse (_local/ und andere Notizen), die nie ins Repo
// wandern — im pre-push blockierten deren Anführungszeichen sonst den Push.
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((f) => f !== "" && EXTS.has(extname(f)));
}

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const named = args.filter((a) => a !== "--fix");
const files = named.length > 0 ? named.filter((f) => EXTS.has(extname(f))) : trackedFiles();

let total = 0;
for (const file of files) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { continue; }
  if (src.includes("\0")) continue; // binär
  const { fixedContent, findings } = scan(src);
  if (findings.length === 0) continue;
  total += findings.length;
  if (fix) {
    writeFileSync(file, fixedContent, "utf8");
    console.log(`fixed: ${findings.length} Paar(e) in ${file}`);
  } else {
    for (const f of findings) console.log(`${file}:${f.line}: falscher Quote-Closer (erwartet ")`);
  }
}

if (total === 0) console.log(`Anführungszeichen ok (${files.length} Datei(en) geprüft).`);
else if (fix) console.log(`${total} Paar(e) korrigiert.`);
else {
  console.log(`${total} falsche(s) Paar(e). Auto-Fix: node scripts/check-quotes.mjs --fix`);
  process.exit(1);
}
