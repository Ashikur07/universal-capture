// Settings: command line options and the .env file.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const DEVICES = Object.freeze({
  mobile: { width: 420, height: 900, scale: 3, mobile: true },
  tablet: { width: 820, height: 1180, scale: 2, mobile: true },
  desktop: { width: 1440, height: 900, scale: 2, mobile: false },
});

export const HELP = `
Universal Screenshot Capture
Browse a website normally; a screenshot is saved every time the screen changes.

Usage
  node src/cli.js [url] [options]

Options
  -e, --env <file>      settings file to use (default: .env)
  -d, --device <name>   mobile | tablet | desktop | custom
  -m, --manual          save only when you press F8
  -f, --full-page       capture the whole scrollable page
  -h, --help            show this help
  -v, --version         show the version

Keys inside the browser
  F8  save the current screen      F9  pause / resume
  Close the browser, or press Ctrl+C here, to finish.

Settings are explained in .env.example and README.md.
`;

export class UserError extends Error {}

export function parseCli(argv) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        env: { type: 'string', short: 'e' },
        device: { type: 'string', short: 'd' },
        manual: { type: 'boolean', short: 'm' },
        'full-page': { type: 'boolean', short: 'f' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        headless: { type: 'boolean' },        // for automated tests
        seconds: { type: 'string' },          // for automated tests: stop after N seconds
      },
    });
    if (positionals.length > 1) throw new UserError('Give only one website link.');
    return { ...values, url: positionals[0] };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`${error.message}\nRun with --help to see the options.`);
  }
}

export function parseEnv(text) {
  const values = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    values[line.slice(0, at).trim().toUpperCase()] = line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

/** Turn .env values plus command line options into checked settings. */
export function buildSettings(env, cli, rootDir) {
  const text = (key) => env[key] ?? '';

  const device = (cli.device || text('DEVICE') || 'mobile').toLowerCase();
  if (!Object.hasOwn(DEVICES, device) && device !== 'custom') {
    throw new UserError(`DEVICE must be mobile, tablet, desktop or custom (found "${device}").`);
  }
  const base = DEVICES[device] ?? DEVICES.desktop;

  const number = (key, fallback, min, max, whole = false) => {
    if (!text(key)) return fallback;
    const n = Number(text(key));
    if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
      throw new UserError(`${key} must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max} (found "${text(key)}").`);
    }
    return n;
  };

  const flag = (key) => {
    const value = text(key).toLowerCase();
    if (['', 'false', 'no', '0', 'off'].includes(value)) return false;
    if (['true', 'yes', '1', 'on'].includes(value)) return true;
    throw new UserError(`${key} must be true or false (found "${text(key)}").`);
  };

  const mode = cli.manual ? 'manual' : (text('CAPTURE_MODE') || 'auto').toLowerCase();
  if (!['auto', 'manual'].includes(mode)) throw new UserError(`CAPTURE_MODE must be auto or manual (found "${mode}").`);

  return {
    url: cli.url || text('URL'),
    projectName: text('PROJECT_NAME'),
    device,
    view: {
      width: number('WIDTH', base.width, 200, 3840, true),
      height: number('HEIGHT', base.height, 200, 3840, true),
      scale: number('SCALE', base.scale, 1, 4),
      mobile: base.mobile,
    },
    mode,
    fullPage: Boolean(cli['full-page']) || flag('FULL_PAGE'),
    keepLogin: flag('KEEP_LOGIN'),
    waitMs: number('WAIT_MS', 1000, 300, 10000, true),
    blur: text('BLUR'),
    outputDir: path.resolve(rootDir, text('OUTPUT_DIR') || 'screenshots'),
    browserPath: text('BROWSER_PATH'),
    headless: Boolean(cli.headless),
    seconds: Number(cli.seconds ?? 0),
  };
}

export function loadSettings(cli, rootDir) {
  const envPath = path.resolve(rootDir, cli.env ?? '.env');
  if (!fs.existsSync(envPath)) {
    if (cli.env) throw new UserError(`Settings file not found: ${envPath}`);
    fs.copyFileSync(path.join(rootDir, '.env.example'), envPath);
    console.log('Created a new .env file from .env.example');
  }
  return buildSettings(parseEnv(fs.readFileSync(envPath, 'utf8')), cli, rootDir);
}

export function normalizeUrl(input) {
  const value = String(input).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new UserError('No website link was given. Put it after URL= in the .env file.');
  let candidate = value;
  if (/^[a-z]:[\\/]/i.test(value)) {
    candidate = `file:///${value.replace(/\\/g, '/')}`;
  } else if (!/^(https?|file):/i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) {
      throw new UserError(`Only http, https and file links are supported (found "${value}").`);
    }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(value);
    candidate = `${local ? 'http' : 'https'}://${value}`;
  }
  try {
    return new URL(candidate).href;
  } catch {
    throw new UserError(`This is not a valid website link: "${value}"`);
  }
}

/** A string that is safe to use as a file or folder name on every system. */
export function safeName(text, max = 50) {
  const name = String(text ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f#%&]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, max)
    .replace(/^\.+|[.-]+$/g, '');
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? `_${name}` : name;
}
