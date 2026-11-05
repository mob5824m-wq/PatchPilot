#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'java-parser';

/**
 * Parses every Java source in `android/` so a syntax error fails in seconds
 * instead of after a Gradle build.
 *
 * This is a parser, not a compiler: it proves the files are well-formed Java and
 * nothing more. Types, imports and Android API levels are still only checked by
 * `gradle assembleRelease`.
 *
 *   node scripts/check-java.mjs
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function javaFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...javaFiles(path));
    else if (entry.endsWith('.java')) found.push(path);
  }
  return found;
}

const files = javaFiles(join(root, 'android'));
if (!files.length) {
  console.error('No Java sources found under android/ — did the layout change?');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const relative = file.slice(root.length + 1);
  try {
    parse(readFileSync(file, 'utf8'));
    console.log(`ok   ${relative}`);
  } catch (error) {
    failures += 1;
    const message = String(error.message ?? error).split('\n').slice(0, 3).join('\n     ');
    console.error(`FAIL ${relative}\n     ${message}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} Java files parsed`);
process.exit(failures ? 1 : 0);
