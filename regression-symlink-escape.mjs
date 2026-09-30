import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import decompress from './index.js';

// Regression test for GHSA-hrh2-vp3x-79xf: symlink entries whose targets
// resolve outside the output directory must not allow writing outside it.

const makeSandbox = t => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'decompress-ghsa-hrh2-vp3x-79xf-'));
	t.after(() => {
		fs.rmSync(base, {recursive: true, force: true});
	});
	return {base, output: path.join(base, 'out')};
};

const plugin = entries => () => Promise.resolve(entries.map(entry => ({...entry})));

const file = (entryPath, data) => ({
	type: 'file',
	path: entryPath,
	data: Buffer.from(data),
	mode: 0o644,
	mtime: new Date(),
});

test('refuses symlink chain (a -> ., b -> a/..) that escapes the output directory', async t => {
	const {base, output} = makeSandbox(t);

	const entries = [
		{type: 'symlink', path: 'a', linkname: '.'},
		{type: 'symlink', path: 'b', linkname: 'a/..'},
		file('b/escape.txt', 'pwned'),
	];

	await t.assert.rejects(decompress(Buffer.from('x'), output, {plugins: [plugin(entries)]}), /Refusing/v);
	t.assert.strictEqual(fs.existsSync(path.join(base, 'escape.txt')), false, 'file was written outside the output directory');
});

test('refuses relative symlink pointing outside the output directory', async t => {
	const {base, output} = makeSandbox(t);
	const outside = path.join(base, 'outside');
	fs.mkdirSync(outside);

	const entries = [
		{type: 'symlink', path: 'evil', linkname: '../outside'},
		file('evil/escape.txt', 'pwned'),
	];

	await t.assert.rejects(decompress(Buffer.from('x'), output, {plugins: [plugin(entries)]}), /Refusing/v);
	t.assert.strictEqual(fs.existsSync(path.join(outside, 'escape.txt')), false, 'file was written outside the output directory');
});

test('refuses absolute symlink pointing outside the output directory', async t => {
	const {base, output} = makeSandbox(t);
	const outside = path.join(base, 'elsewhere');
	fs.mkdirSync(outside);

	const entries = [
		{type: 'symlink', path: 'evil', linkname: outside},
		file('evil/escape.txt', 'pwned'),
	];

	await t.assert.rejects(decompress(Buffer.from('x'), output, {plugins: [plugin(entries)]}), /Refusing/v);
	t.assert.strictEqual(fs.existsSync(path.join(outside, 'escape.txt')), false, 'file was written outside the output directory');
});

test('refuses symlink through a not-yet-existing path (c -> d/.., then d -> .)', async t => {
	const {output} = makeSandbox(t);

	const entries = [
		{type: 'symlink', path: 'c', linkname: 'd/..'},
		{type: 'symlink', path: 'd', linkname: '.'},
	];

	await t.assert.rejects(decompress(Buffer.from('x'), output, {plugins: [plugin(entries)]}), /Refusing/v);
	const escaped = fs.existsSync(path.join(output, 'c')) && fs.realpathSync.native(path.join(output, 'c')) !== output;
	t.assert.strictEqual(escaped, false, 'symlink resolving outside the output directory was created');
});
