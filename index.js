'use strict';
const path = require('path');
const fs = require('graceful-fs');
const decompressTar = require('decompress-tar');
const decompressTarbz2 = require('decompress-tarbz2');
const decompressTargz = require('decompress-targz');
const decompressUnzip = require('decompress-unzip');
const makeDir = require('make-dir');
const pify = require('pify');
const stripDirs = require('strip-dirs');

const fsP = pify(fs);
// The non-native realpath normalizes `..` lexically before resolving symlinks, which can be abused to escape
const realpath = fs.realpath.native ? pify(fs.realpath.native) : fsP.realpath;

const runPlugins = (input, opts) => {
	if (opts.plugins.length === 0) {
		return Promise.resolve([]);
	}

	return Promise.all(opts.plugins.map(x => x(input, opts))).then(files => files.reduce((a, b) => a.concat(b)));
};

const isInside = (realOutputPath, p) => {
	const prefix = realOutputPath.endsWith(path.sep) ? realOutputPath : realOutputPath + path.sep;
	return p === realOutputPath || p.indexOf(prefix) === 0;
};

// Resolve a link target that may not exist yet: realpath the deepest existing ancestor and append the rest.
// A `..` after a missing component could later be redirected by another symlink, so it is refused.
const resolveTarget = target => {
	return realpath(target)
		.catch(error => {
			const parent = path.dirname(target);

			if (parent === target) {
				throw error;
			}

			if (path.basename(target) === '..') {
				throw new Error('Refusing to create a link through a missing path: ' + target);
			}

			return resolveTarget(parent).then(realParent => path.join(realParent, path.basename(target)));
		});
};

const safeMakeDir = (dir, realOutputPath) => {
	return realpath(dir)
		.catch(_ => {
			const parent = path.dirname(dir);
			return safeMakeDir(parent, realOutputPath);
		})
		.then(realParentPath => {
			if (!isInside(realOutputPath, realParentPath)) {
				throw (new Error('Refusing to create a directory outside the output path.'));
			}

			return makeDir(dir).then(realpath);
		});
};

const preventWritingThroughSymlink = (destination, realOutputPath) => {
	return fsP.readlink(destination)
		.catch(_ => {
			// Either no file exists, or it's not a symlink. In either case, this is
			// not an escape we need to worry about in this phase.
			return null;
		})
		.then(symlinkPointsTo => {
			if (symlinkPointsTo) {
				throw new Error('Refusing to write into a symlink');
			}

			// No symlink exists at `destination`, so we can continue
			return realOutputPath;
		});
};

const extractFile = (input, output, opts) => runPlugins(input, opts).then(files => {
	if (opts.strip > 0) {
		files = files
			.map(x => {
				x.path = stripDirs(x.path, opts.strip);
				return x;
			})
			.filter(x => x.path !== '.');
	}

	if (typeof opts.filter === 'function') {
		files = files.filter(opts.filter);
	}

	if (typeof opts.map === 'function') {
		files = files.map(opts.map);
	}

	if (!output) {
		return files;
	}

	const extracted = [];

	return files.reduce((previous, x) => previous.then(() => {
		const dest = path.join(output, x.path);
		const mode = x.mode & ~process.umask();
		const now = new Date();

		if (x.type === 'directory') {
			return makeDir(output)
				.then(outputPath => realpath(outputPath))
				.then(realOutputPath => safeMakeDir(dest, realOutputPath))
				.then(() => fsP.utimes(dest, now, x.mtime))
				.then(() => x);
		}

		let linkTarget;

		return makeDir(output)
			.then(outputPath => realpath(outputPath))
			.then(realOutputPath => {
				// Attempt to ensure parent directory exists (failing if it's outside the output dir)
				return safeMakeDir(path.dirname(dest), realOutputPath)
					.then(() => realOutputPath);
			})
			.then(realOutputPath => {
				if (x.type === 'file') {
					return preventWritingThroughSymlink(dest, realOutputPath);
				}

				return realOutputPath;
			})
			.then(realOutputPath => {
				return realpath(path.dirname(dest))
					.then(realDestinationDir => {
						if (!isInside(realOutputPath, realDestinationDir)) {
							throw (new Error('Refusing to write outside output directory: ' + realDestinationDir));
						}

						if (x.type !== 'link' && x.type !== 'symlink') {
							return;
						}

						// Hardlink targets are relative to the output directory, symlink targets to the link's directory
						const base = x.type === 'link' ? realOutputPath : realDestinationDir;
						const lexicalTarget = path.resolve(base, x.linkname);
						const rawTarget = path.isAbsolute(x.linkname) ? x.linkname : base + path.sep + x.linkname;

						return resolveTarget(rawTarget)
							.then(realTarget => {
								if (!isInside(realOutputPath, lexicalTarget) || !isInside(realOutputPath, realTarget)) {
									throw (new Error('Refusing to create a link outside the output directory: ' + x.linkname));
								}

								linkTarget = lexicalTarget;
							});
					});
			})
			.then(() => {
				if (x.type === 'link') {
					return fsP.link(linkTarget, dest);
				}

				if (x.type === 'symlink' && process.platform === 'win32') {
					return fsP.link(linkTarget, dest);
				}

				if (x.type === 'symlink') {
					return fsP.symlink(x.linkname, dest);
				}

				return fsP.writeFile(dest, x.data, {mode});
			})
			.then(() => x.type === 'file' && fsP.utimes(dest, now, x.mtime))
			.then(() => x);
	}).then(entry => {
		extracted.push(entry);
	}), Promise.resolve()).then(() => extracted);
});

module.exports = (input, output, opts) => {
	if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
		return Promise.reject(new TypeError('Input file required'));
	}

	if (typeof output === 'object') {
		opts = output;
		output = null;
	}

	opts = Object.assign({plugins: [
		decompressTar(),
		decompressTarbz2(),
		decompressTargz(),
		decompressUnzip()
	]}, opts);

	const read = typeof input === 'string' ? fsP.readFile(input) : Promise.resolve(input);

	return read.then(buf => extractFile(buf, output, opts));
};
