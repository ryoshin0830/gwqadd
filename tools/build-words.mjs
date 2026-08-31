#!/usr/bin/env node
// Regenerates the three word lists in bin/gwqadd.mjs.
//
// Maintainer tool. It is in .npmignore, it is absent from package.json `files`,
// and nothing at install or run time calls it. Design and rationale:
// docs/superpowers/specs/2026-08-26-gwqadd-random-branch-names-design.md
//
//   adjectives, nouns  glitchdotcom/friendly-words   MIT (c) 2018 Glitch
//   gerunds            dariusk/corpora               CC0
//   easy-word filter   EFF short wordlist #1         eff.org terms, build-time only
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
// EFF built this one for diceware, from Ghent University's word-familiarity
// data: at most 5 characters, no homophones, nothing hard to spell, nothing
// offensive. That is the definition of "easy word" this tool wants, already
// curated by someone else, so easiness is a membership test rather than a
// frequency threshold we would have to pick a cutoff for. Adjectives and nouns
// are tested against it directly; gerunds cannot be, and are tested through
// their infinitive — see the comment above `gerunds` below.
const EASY = 'https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt';

// VADER scores sentiment, not taste, so words that are merely charmless get
// through it. Growing this list is expected maintenance, not a design failure.
// A smaller pool also means each survivor is offered more often, which is why
// 'mugging' and 'punching' were worth naming here at one in 132 gerunds and
// were not at one in 109 sampled out of 542.
const REJECT = new Set([
  'abrasive', 'banning', 'begging', 'concerning', 'frown', 'groaning',
  'harming', 'itching', 'mugging', 'punching', 'scowl', 'screeching', 'snarl',
  'spoiling',
]);

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

const [predRaw, objRaw, verbsRaw, vaderRaw, dictRaw, easyRaw] = await Promise.all(
  [`${FW}predicates.txt`, `${FW}objects.txt`, CORPORA, VADER, DICT, EASY].map(text),
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

// "1111\tacid" — the roll is the diceware index, the word is the last field.
// Four digits, because the short list is 6^4; the large one is 6^5 and five.
const easy = new Set(lines(easyRaw).map((l) => l.split(/\s+/).pop().toLowerCase()));

// The spelling check is what kills "claping" (a misspelling that ships in
// corpora) and "aerosteon" / "agustinia" (dinosaur genera that friendly-words
// counts as objects).
const keep = (words, shape) =>
  [...new Set(words)]
    .filter((w) => shape.test(w) && spelled.has(w) && pleasant(w) && !REJECT.has(w))
    .sort();

const easyOnly = (words) => words.filter((w) => easy.has(w));

const predicates = lines(predRaw);
const adjectives = keep(
  easyOnly(predicates.filter((w) => !w.endsWith('ing'))), /^[a-z]{3,9}$/,
);
const nouns = keep(easyOnly(lines(objRaw)), /^[a-z]{3,9}$/);
// The gerunds cannot be filtered like the other two: a list of short familiar
// words holds "cook" and never "cooking", so testing the -ing form against it
// leaves almost nothing. They are conjugated instead from the corpora verbs
// whose INFINITIVE is easy, which is also what makes them verbs — the -ing
// words in friendly-words are adjectives in disguise ("amazing", "charming")
// as often as not, so that source is dropped here.
const gerunds = keep(
  JSON.parse(verbsRaw)
    .filter((v) => easy.has(v.infinitive?.[0]))
    .map((v) => v.gerund?.[0]?.toLowerCase())
    .filter(Boolean),
  // {5,10}, not {3,10}: the real range is 6-9, and the floor is the only thing
  // standing between `endsWith('ing')` and a corpora entry whose `gerund[0]` is
  // wrongly an infinitive — `king`, `ring`, `sing`, `wing` all end in "ing".
  /^[a-z]{5,10}$/,
).filter((w) => w.endsWith('ing'));

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

// The whole pool ships. Earlier revisions stride-sampled it down to 216 / 109 /
// 407 so the namespace matched `claude -w` exactly; once the easy-word filter
// decides which words are allowed at all, that target has nothing behind it,
// and throwing away two thirds of an already small pool only costs names.
process.stderr.write(
  `pools: ${adjectives.length} adjectives, ${gerunds.length} gerunds, `
  + `${nouns.length} nouns = `
  + `${(adjectives.length * gerunds.length * nouns.length).toLocaleString('en-US')} names\n`,
);
for (const [name, pool] of [
  ['ADJECTIVES', adjectives], ['GERUNDS', gerunds], ['NOUNS', nouns],
]) {
  process.stdout.write(`const ${name} = [\n  ${wrap(pool)}\n];\n\n`);
}
