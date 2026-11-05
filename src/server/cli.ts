#!/usr/bin/env node
import { copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { DownloadJob } from '../shared/types.ts';
import { describeApk, verifyApk } from './apk/verify.ts';
import { BundleRegistry } from './bundles/registry.ts';
import { buildCatalog } from './catalog.ts';
import { dataDir, demoSourceEnabled, ensureDirs, libraryDir, loadSettings, offlineMode } from './config.ts';
import { JobManager } from './jobs.ts';
import { libraryFilePath } from './library.ts';
import { fileTypeLabel } from '../shared/labels.ts';

/**
 * Command line front end for the same machinery the web UI uses:
 *
 *   patchpilot list
 *   patchpilot versions com.google.android.youtube
 *   patchpilot get com.google.android.youtube --version 21.30.216
 *   patchpilot verify ~/Downloads/youtube.apk --package com.google.android.youtube
 */

interface Flags {
  [key: string]: string | boolean | undefined;
}

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument.startsWith('--')) {
      const [name, inline] = argument.slice(2).split('=');
      if (inline !== undefined) {
        flags[name] = inline;
      } else {
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
          flags[name] = next;
          index += 1;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(argument);
    }
  }
  return { positional, flags };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function header(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = positional[0] ?? 'help';

  ensureDirs();
  const registry = new BundleRegistry();
  await registry.init();
  const settings = await loadSettings();
  const catalog = buildCatalog(registry.getPayloads());

  switch (command) {
    case 'list': {
      header(`${catalog.appCount} apps · ${catalog.patchCount} patches · ${catalog.bundles.length} bundles`);
      const rows = catalog.apps
        .filter((app) => (flags.stable ? !app.experimentalOnly : true))
        .map((app) => [
          app.name,
          app.packageName,
          app.recommendedVersion ?? '—',
          String(app.targets.length),
          app.fileType ?? '—',
        ]);
      const widths = [30, 42, 16, 9, 16];
      console.log(
        `\x1b[2m${pad('APP', widths[0])}${pad('PACKAGE', widths[1])}${pad('RECOMMENDED', widths[2])}${pad('VERSIONS', widths[3])}FILE\x1b[0m`,
      );
      for (const row of rows) {
        console.log(row.map((cell, index) => pad(cell, widths[index])).join(''));
      }
      if (offlineMode) console.log('\x1b[2m(offline mode: using cached or bundled patch data)\x1b[0m');
      return;
    }

    case 'versions': {
      const packageName = positional[1];
      if (!packageName) throw new Error('Usage: patchpilot versions <package>');
      const app = catalog.apps.find((entry) => entry.packageName === packageName);
      if (!app) throw new Error(`No enabled bundle covers ${packageName}`);
      header(`${app.name} · ${app.packageName} · needs ${fileTypeLabel(app.fileType)}`);
      console.log(`patches: ${app.patchCount}   bundles: ${app.bundles.map((bundle) => bundle.name).join(', ')}`);
      if (app.signatures.length) console.log(`signing certs: ${app.signatures.join(', ')}`);
      console.log('');
      for (const target of app.targets) {
        const marks = [
          target.version === app.recommendedVersion ? '\x1b[32mrecommended\x1b[0m' : '',
          target.isExperimental ? '\x1b[33mexperimental\x1b[0m' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const codes = target.versionCodes ? ` (${Object.values(target.versionCodes)[0]})` : '';
        console.log(
          `  ${pad(target.version + codes, 26)}${pad(`${target.patchCount} patches`, 14)}${target.minSdk ? `minSdk ${target.minSdk}` : ''} ${marks}`,
        );
      }
      return;
    }

    case 'get': {
      const packageName = positional[1];
      if (!packageName) throw new Error('Usage: patchpilot get <package> [--version <v>] [--provider <id>] [--out <dir>]');
      const app = catalog.apps.find((entry) => entry.packageName === packageName);
      if (!app) throw new Error(`No enabled bundle covers ${packageName}`);

      const version = typeof flags.version === 'string' ? flags.version : app.recommendedVersion;
      if (!version) throw new Error('This app has no recommended version; pass --version');
      const target = app.targets.find((entry) => entry.version === version);
      if (!target) throw new Error(`${app.name} ${version} is not supported by the loaded patches`);

      console.log(`\x1b[1m${app.name}\x1b[0m ${version} as ${fileTypeLabel(app.fileType)}`);
      if (target.isExperimental) console.log('\x1b[33mNote: the bundle marks this version experimental.\x1b[0m');

      const manager = new JobManager(async () => settings);
      const providers = typeof flags.provider === 'string' ? [flags.provider] : undefined;
      if (providers) console.log(`\x1b[2msources restricted to: ${providers.join(', ')}\x1b[0m`);

      const created = manager.create({
        packageName: app.packageName,
        appName: app.name,
        version,
        versionCodes: target.versionCodes,
        fileType: app.fileType,
        signatures: app.signatures,
        providers,
      });

      let lastLogCount = 0;
      const render = (job: DownloadJob) => {
        for (const line of job.logs.slice(lastLogCount)) {
          const colour = line.level === 'error' ? '\x1b[31m' : line.level === 'warn' ? '\x1b[33m' : line.level === 'success' ? '\x1b[32m' : '\x1b[2m';
          console.log(`${colour}· ${line.message}\x1b[0m`);
        }
        lastLogCount = job.logs.length;
      };
      render(created);

      const job = await new Promise<DownloadJob>((resolveJob) => {
        const check = () => {
          const current = manager.get(created.id);
          if (!current) return;
          render(current);
          if (['done', 'failed', 'cancelled'].includes(current.state)) resolveJob(current);
        };
        manager.on('update', check);
        check();
      });

      if (job.state !== 'done' || !job.result) {
        console.error(`\n\x1b[31mFailed:\x1b[0m ${job.error ?? 'unknown error'}`);
        const manual = job.attempts.filter((attempt) => attempt.urls?.length);
        for (const attempt of manual) {
          for (const url of attempt.urls ?? []) console.log(`  open: ${url}`);
        }
        process.exitCode = 1;
        return;
      }

      const path = await libraryFilePath(job.result.libraryId);
      console.log(`\n\x1b[32m✓ Verified\x1b[0m ${job.result.verification.summary}`);
      for (const check of job.result.verification.checks) {
        const mark = check.status === 'pass' ? '\x1b[32m✓' : check.status === 'warn' ? '\x1b[33m!' : check.status === 'fail' ? '\x1b[31m✕' : '\x1b[2m·';
        console.log(`  ${mark}\x1b[0m ${check.label}: ${check.detail}`);
      }
      console.log(`\nSaved to ${path ?? join(libraryDir, '…')}`);

      if (typeof flags.out === 'string' && path) {
        const destination = join(resolve(flags.out), basename(path));
        await copyFile(path, destination);
        console.log(`Copied to ${destination}`);
      }
      return;
    }

    case 'verify': {
      const file = positional[1];
      if (!file) throw new Error('Usage: patchpilot verify <file.apk> [--package <pkg>] [--version <v>]');
      const path = resolve(file);
      const info = await describeApk(path);
      const packageName = typeof flags.package === 'string' ? flags.package : (info.packageName ?? '');
      const app = catalog.apps.find((entry) => entry.packageName === packageName);
      const version = typeof flags.version === 'string' ? flags.version : (info.versionName ?? null);
      const target = app?.targets.find((entry) => entry.version === version) ?? null;

      const result = verifyApk(info, {
        packageName,
        appName: app?.name,
        versionName: version,
        versionCodes: target?.versionCodes ?? null,
        fileType: app?.fileType ?? null,
        signatures: app?.signatures ?? [],
      });

      console.log(`${path} — ${fileTypeLabel(info.container)} · ${Math.round(info.sizeBytes / 1024)} KB`);
      console.log(`status: ${result.status.toUpperCase()}`);
      for (const check of result.checks) {
        console.log(`  [${check.status}] ${check.label}: ${check.detail}`);
      }
      if (result.status === 'fail') process.exitCode = 1;
      return;
    }

    case 'bundles': {
      if (flags.refresh) {
        console.log('Refreshing bundles from their repositories…');
        await registry.refresh();
      }
      header('Patch bundles');
      for (const info of registry.getInfos()) {
        console.log(
          `  ${pad(info.name, 34)}${pad(info.version ?? '—', 12)}${pad(`${info.patchCount} patches`, 14)}${pad(`${info.packageCount} apps`, 12)}${info.origin ?? 'unloaded'}${info.enabled ? '' : ' (disabled)'}`,
        );
        if (info.error) console.log(`    \x1b[33m${info.error}\x1b[0m`);
      }
      console.log(`\nPatch data folder: ${dataDir}`);
      if (demoSourceEnabled) console.log('Offline demo source: enabled');
      return;
    }

    default:
      console.log(`PatchPilot — find the APK a Morphe patch bundle needs.

Usage:
  patchpilot list [--stable]
  patchpilot versions <package>
  patchpilot get <package> [--version <v>] [--provider <id>] [--out <dir>]
  patchpilot verify <file> [--package <pkg>] [--version <v>]
  patchpilot bundles

Environment:
  PATCHPILOT_DATA_DIR   where the library and caches live (default ./data)
  PATCHPILOT_OFFLINE=1  never touch the network; use cached/bundled patch data
  PATCHPILOT_DEMO=1     enable the offline fixture source
  PORT                  port for the web UI (npm start)
`);
  }
}

main().catch((error: unknown) => {
  console.error(`\x1b[31m${(error as Error).message}\x1b[0m`);
  process.exitCode = 1;
});
