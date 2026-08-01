#!/usr/bin/env node
'use strict';

const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const requireFromHere = createRequire(__filename);

function loadKeyringEntryClass() {
  try {
    return requireFromHere('@napi-rs/keyring').Entry;
  } catch (loaderError) {
    const suffixes = getNativeBindingSuffixes(process.platform, process.arch);
    let lastError;
    for (const suffix of suffixes) {
      try {
        const packageJsonPath = requireFromHere.resolve(`@napi-rs/keyring-${suffix}/package.json`);
        return requireFromHere(join(dirname(packageJsonPath), `keyring.${suffix}.node`)).Entry;
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(`Failed to load @napi-rs/keyring in recovery helper: ${lastError?.message ?? loaderError.message}`);
    error.cause = loaderError;
    throw error;
  }
}

function getNativeBindingSuffixes(platform, arch) {
  if (platform === 'linux') {
    if (arch === 'arm64') return ['linux-arm64-gnu', 'linux-arm64-musl'];
    if (arch === 'arm') return ['linux-arm-gnueabihf'];
    if (arch === 'riscv64') return ['linux-riscv64-gnu'];
    if (arch === 'x64') return ['linux-x64-gnu', 'linux-x64-musl'];
  }
  return [];
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (input.length > 1024 * 1024) {
        reject(new Error('request too large'));
        process.stdin.destroy();
      }
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(input));
  });
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

(async () => {
  try {
    const request = JSON.parse(await readStdin());
    if (!request || typeof request !== 'object') throw new Error('invalid request');
    const { operation, service, account, payload } = request;
    if (!['read', 'write', 'remove'].includes(operation)) throw new Error('invalid operation');
    if (typeof service !== 'string' || !service) throw new Error('invalid service');
    if (typeof account !== 'string' || !account) throw new Error('invalid account');

    const Entry = loadKeyringEntryClass();
    const entry = new Entry(service, account);

    if (operation === 'read') {
      const value = entry.getPassword();
      writeResponse(value === null ? { ok: true, found: false } : { ok: true, found: true, value });
      return;
    }
    if (operation === 'write') {
      if (typeof payload !== 'string') throw new Error('invalid payload');
      entry.setPassword(payload);
      writeResponse({ ok: true });
      return;
    }

    entry.deleteCredential();
    writeResponse({ ok: true });
  } catch (error) {
    writeResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
})();
