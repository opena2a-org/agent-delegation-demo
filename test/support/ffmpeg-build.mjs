// Prints, as one line of JSON, where Playwright's own registry looks for its
// ffmpeg build, read from the installed playwright-core. A test of the
// launcher shape loads no package, so it starts this file in a process of its
// own, under one profile with the boundary's terms.

import path from 'node:path';

const m = await import('playwright-core/lib/server/registry/index');
const registry = m.registry ?? m.default.registry;
const registryDirectory = m.registryDirectory ?? m.default.registryDirectory;
const ffmpegBuild = registry.findExecutable('ffmpeg').executablePath();
process.stdout.write(`${JSON.stringify({ registryDirectory, ffmpegBuild, ffmpegBuildInCache: path.relative(registryDirectory, ffmpegBuild) })}\n`);
