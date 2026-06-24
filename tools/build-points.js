// Сборка public/points.json из geo.txt.
// geo.txt — строки вида "(CODE [CODE2 ...]) lat,lon". Одна строка = одна
// физическая точка (1–2 кода — диапазоны 2.4/5 ГГц одной AP). Координаты
// заданы вручную по PDF-схеме рынка; часть пока приблизительна (поправим).
//
// Запуск: npm run build-points  (или node tools/build-points.js)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'geo.txt');
const OUT_DIR = join(ROOT, 'public');
const OUT = join(OUT_DIR, 'points.json');


const LINE = /^\(([^)]+)\)\s+([-\d.]+)\s*,\s*([-\d.]+)\s*$/;

function parse(text) {
  const points = [];
  const seenCode = new Map(); // code(lower) → id точки, для отлова дублей кодов
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(LINE);
    if (!m) {
      console.warn(`[build-points] строка ${lineNo} не распознана, пропуск: ${line}`);
      continue;
    }
    const codes = m[1].split(/\s+/).filter(Boolean);
    const lat = Number(m[2]);
    const lon = Number(m[3]);
    if (!codes.length || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.warn(`[build-points] строка ${lineNo}: пустые коды или координаты, пропуск`);
      continue;
    }
    const id = codes.join('+');
    for (const c of codes) {
      const key = c.toLowerCase();
      if (seenCode.has(key)) {
        console.warn(`[build-points] код ${c} повторяется (точки ${seenCode.get(key)} и ${id})`);
      } else {
        seenCode.set(key, id);
      }
    }
    points.push({ id, codes, lat, lon });
  }
  return points;
}

function main() {
  let text;
  try {
    text = readFileSync(SRC, 'utf8');
  } catch {
    console.error(`[build-points] не найден ${SRC}`);
    process.exit(1);
  }
  const points = parse(text);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(points, null, 2) + '\n', 'utf8');
  const codeCount = points.reduce((n, p) => n + p.codes.length, 0);
  console.log(`[build-points] точек: ${points.length}, кодов: ${codeCount} → ${OUT}`);
}

main();
