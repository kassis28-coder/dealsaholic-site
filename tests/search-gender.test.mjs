import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const functionNames = ['searchTokens', 'matchesSearchToken', 'matchesSearch'];
const source = functionNames.map((name) => {
  const match = html.match(new RegExp(`function ${name}\\([^\\n]+`));
  assert.ok(match, `${name} should exist in public/index.html`);
  return match[0];
}).join('\n');

const context = {
  storeOf: () => 'amazon',
  detectCategory: () => 'fashion',
};
vm.createContext(context);
vm.runInContext(source, context);

test('men fashion excludes women fashion products', () => {
  assert.equal(context.matchesSearch({ title: "Women's summer fashion dress" }, 'men fashion'), false);
  assert.equal(context.matchesSearch({ title: "Men's casual fashion shirt" }, 'men fashion'), true);
});

test('women fashion still finds women products', () => {
  assert.equal(context.matchesSearch({ title: "Women's summer fashion dress" }, 'women fashion'), true);
  assert.equal(context.matchesSearch({ title: "Men's casual fashion shirt" }, 'women fashion'), false);
});
