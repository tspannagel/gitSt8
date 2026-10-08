import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildCommitPrompt, cleanModelOutput, truncateDiff, usesConventionalCommits } from '../commitPrompt';

const file = (name: string, body: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`;

test('detects conventional commits', () => {
  assert.equal(usesConventionalCommits(['feat: a', 'fix(x): b', 'chore: c', 'Merge branch']), true);
  assert.equal(usesConventionalCommits(['Add a', 'Fix b', 'Update c']), false);
  assert.equal(usesConventionalCommits(['feat: a']), false);
});

test('prompt keeps stat, branch and style hints', () => {
  const p = buildCommitPrompt({ diff: file('a.ts', '+x'), stat: ' a.ts | 1 +', recentSubjects: ['feat: a', 'fix: b', 'docs: c'], branch: 'main', maxChars: 10000 });
  assert.match(p, /Conventional Commits/);
  assert.match(p, /72 characters/);
  assert.match(p, /a\.ts \| 1 \+/);
  assert.match(p, /Branch: main/);
  assert.doesNotMatch(p, /truncated/);
});

test('plain style when subjects are not conventional', () => {
  const p = buildCommitPrompt({ diff: '', stat: '', recentSubjects: ['Add x', 'Fix y', 'Update z'], branch: '', maxChars: 1000 });
  assert.match(p, /style of the recent commit subjects/);
  assert.match(p, /detached HEAD/);
});

test('truncation is per file, small files stay intact, truncation is noted', () => {
  const big = file('big.ts', '+' + 'x'.repeat(5000));
  const small = file('small.ts', '+y');
  const { text, truncated } = truncateDiff(big + small, 600);
  assert.deepEqual(truncated, ['big.ts']);
  assert.ok(text.includes('diff --git a/small.ts b/small.ts'));
  assert.ok(text.includes('+y'));
  assert.ok(text.length < 900);
  const p = buildCommitPrompt({ diff: big + small, stat: ' 2 files', recentSubjects: [], branch: 'b', maxChars: 600 });
  assert.match(p, /truncated: big\.ts/);
  assert.match(p, /2 files/);
});

test('cleanModelOutput strips fences, quotes and labels', () => {
  assert.equal(cleanModelOutput('```\nfeat: x\n\nbody\n```'), 'feat: x\n\nbody');
  assert.equal(cleanModelOutput('```text\nfix: y\n```'), 'fix: y');
  assert.equal(cleanModelOutput('"fix: y"'), 'fix: y');
  assert.equal(cleanModelOutput('Commit message: fix: y'), 'fix: y');
  assert.equal(cleanModelOutput('Here is the commit message:\n\nfix: y'), 'fix: y');
  assert.equal(cleanModelOutput('  fix: y\n'), 'fix: y');
});
