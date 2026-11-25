#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { HELP, loadSettings, parseCli, UserError } from './config.js';
import { record } from './recorder.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new UserError(`Node.js 20 or newer is needed (you have ${process.versions.node}).`);

  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return console.log(HELP);
  if (cli.version) {
    return console.log(JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version);
  }

  const settings = loadSettings(cli, rootDir);
  if (!settings.url) {
    if (!process.stdin.isTTY) throw new UserError('No website link was given. Put it after URL= in the .env file.');
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    settings.url = await prompt.question('Website link (paste it and press Enter): ');
    prompt.close();
  }

  const { folder, shots } = await record(settings, { rootDir });
  console.log(`\n  Finished: ${shots.length} screenshot(s).`);
  if (shots.length) {
    console.log(`  Folder : ${folder}`);
    console.log(`  Gallery: ${path.join(folder, 'gallery.html')}`);
  }
}

main().catch((error) => {
  console.error(`\nError: ${error instanceof UserError ? error.message : error.stack}`);
  process.exitCode = 1;
});
