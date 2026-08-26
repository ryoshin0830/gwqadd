#!/usr/bin/env node
// Regenerates the three word lists in bin/gwqadd.mjs.
//
// Maintainer tool. It is in .npmignore, it is absent from package.json `files`,
// and nothing at install or run time calls it. Design and rationale:
// docs/superpowers/specs/2026-08-26-gwqadd-random-branch-names-design.md
//
//   adjectives, nouns  glitchdotcom/friendly-words   MIT (c) 2018 Glitch
//   gerunds            dariusk/corpora               CC0
//   tone filter        cjhutto/vaderSentiment        MIT       build-time only
//   spelling           dwyl/english-words            Unlicense build-time only
//
// Only the first two contribute words. Usage:
//   node tools/build-words.mjs > /tmp/words.js
// then paste the three arrays into bin/gwqadd.mjs.

const FW = 'https://raw.githubusercontent.com/glitchdotcom/friendly-words/main/words/';
const CORPORA = 'https://raw.githubusercontent.com/dariusk/corpora/master/data/words/verbs_with_conjugations.json';
const VADER = 'https://raw.githubusercontent.com/cjhutto/vaderSentiment/master/vaderSentiment/vader_lexicon.txt';
const DICT = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

// Matching `claude -w` exactly: 216 * 109 * 407 = 9,582,408 names.
const COUNTS = { ADJECTIVES: 216, GERUNDS: 109, NOUNS: 407 };

// VADER scores sentiment, not taste, so words that are merely charmless get
// through it. Growing this list is expected maintenance, not a design failure.
const REJECT = new Set([
  'abrasive', 'banning', 'begging', 'concerning', 'groaning', 'harming',
  'itching', 'screeching', 'spoiling',
]);

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

const [predRaw, objRaw, verbsRaw, vaderRaw, dictRaw] = await Promise.all(
  [`${FW}predicates.txt`, `${FW}objects.txt`, CORPORA, VADER, DICT].map(text),
);

const negative = new Set(
  lines(vaderRaw)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && Number(p[1]) < 0)
    .map((p) => p[0]),
);
// Check the stems too: "harming" is not in VADER, "harm" is.
const pleasant = (w) =>
  ![w, w.slice(0, -1), w.slice(0, -2), w.slice(0, -3), `${w.slice(0, -3)}e`]
    .some((s) => negative.has(s));

const spelled = new Set(lines(dictRaw));

// The spelling check is what kills "claping" (a misspelling that ships in
// corpora) and "aerosteon" / "agustinia" (dinosaur genera that friendly-words
// counts as objects).
const keep = (words, shape) =>
  [...new Set(words)]
    .filter((w) => shape.test(w) && spelled.has(w) && pleasant(w) && !REJECT.has(w))
    .sort();

const predicates = lines(predRaw);
const adjectives = keep(predicates.filter((w) => !w.endsWith('ing')), /^[a-z]{3,9}$/);
const nouns = keep(lines(objRaw), /^[a-z]{3,9}$/);
// friendly-words carries only 84 -ing words, short of the 109 needed, so the
// gerunds are topped up from corpora and filtered harder.
const gerunds = keep(
  [
    ...predicates.filter((w) => w.endsWith('ing')),
    ...JSON.parse(verbsRaw).map((v) => v.gerund?.[0]?.toLowerCase()).filter(Boolean),
  ],
  /^[a-z]{5,10}$/,
).filter((w) => w.endsWith('ing'));

// Stride sampling: deterministic in any language, no seed to reproduce, and it
// spreads the selection across the alphabet instead of taking one clump of it.
function stride(pool, n) {
  if (pool.length < n) throw new Error(`pool of ${pool.length} cannot yield ${n}`);
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[Math.floor((i * pool.length) / n)]);
  if (new Set(out).size !== n) throw new Error('stride sampling produced duplicates');
  return out;
}

// Wrap so the arrays read like the rest of the file rather than one long line.
function wrap(words, width = 76) {
  const out = [];
  let line = '';
  for (const w of words.map((x) => `'${x}'`)) {
    const next = line ? `${line}, ${w}` : w;
    if (next.length > width) { out.push(`${line},`); line = w; } else { line = next; }
  }
  if (line) out.push(line);
  return out.join('\n  ');
}

process.stderr.write(
  `pools: ${adjectives.length} adjectives, ${gerunds.length} gerunds, ${nouns.length} nouns\n`,
);
for (const [name, pool] of [
  ['ADJECTIVES', adjectives], ['GERUNDS', gerunds], ['NOUNS', nouns],
]) {
  process.stdout.write(`const ${name} = [\n  ${wrap(stride(pool, COUNTS[name]))}\n];\n\n`);
}
