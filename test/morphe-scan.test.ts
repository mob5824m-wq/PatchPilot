import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverMorphe, looksLikePatchList, reposIn, summariseDiscovery, type MorpheBundleSink } from '../src/app/morpheScan.ts';
import type { MorpheFileContents, MorpheScan } from '../src/app/native.ts';

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function readerFor(scan: Partial<MorpheScan>, contents: Record<string, string | Error>): {
  scan: () => Promise<MorpheScan>;
  read: (path: string) => Promise<MorpheFileContents>;
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    scan: async () => ({
      installed: [{ package: 'app.morphe.manager', version: '1.24.1' }],
      files: [],
      unreadable: [],
      notes: [],
      rooted: false,
      sdk: 34,
      ...scan,
    }),
    read: async (path: string) => {
      reads.push(path);
      const value = contents[path];
      if (value instanceof Error) throw value;
      if (typeof value !== 'string') throw new Error(`no fixture for ${path}`);
      return { path, name: path.split('/').pop() ?? path, sizeBytes: value.length, base64: base64(value) };
    },
  };
}

function sinkWith(configs: { id: string; name: string; repo?: string; enabled: boolean }[] = []): {
  sink: MorpheBundleSink;
  state: { archives: string[]; lists: string[]; added: string[]; enabled: string[] };
} {
  const state = { archives: [] as string[], lists: [] as string[], added: [] as string[], enabled: [] as string[] };
  const list = [...configs];
  return {
    state,
    sink: {
      configs: () => list,
      enable: async (id) => {
        state.enabled.push(id);
        const match = list.find((entry) => entry.id === id);
        if (match) match.enabled = true;
      },
      addRepo: async (repo) => {
        state.added.push(repo);
        list.push({ id: repo.replace('/', '-'), name: repo, repo, enabled: true });
      },
      addArchive: async (name) => {
        state.archives.push(name);
        return name.replace(/\.mpp$/i, '');
      },
      addPatchList: async (name) => {
        state.lists.push(name);
        return name.replace(/\.json$/i, '');
      },
    },
  };
}

test('a bundle file left where PatchPilot can see it is loaded', async () => {
  const reader = readerFor(
    {
      files: [{ path: '/sdcard/Android/media/app.morphe.manager/patches-2.0.0.mpp', name: 'patches-2.0.0.mpp', sizeBytes: 10, kind: 'bundle' }],
    },
    { '/sdcard/Android/media/app.morphe.manager/patches-2.0.0.mpp': 'PK-not-really-a-zip' },
  );
  const { sink, state } = sinkWith();

  const discovery = await discoverMorphe(reader, sink);

  assert.deepEqual(state.archives, ['patches-2.0.0.mpp']);
  assert.equal(discovery.filesRead, 1);
  assert.equal(discovery.found, true);
  assert.deepEqual(discovery.installed, [{ package: 'app.morphe.manager', version: '1.24.1' }]);
  assert.match(summariseDiscovery(discovery), /Read 1 file from app\.morphe\.manager 1\.24\.1 — added 1/);
});

test('a bare patches-list.json is accepted as a bundle', async () => {
  const list = JSON.stringify({ patches: [{ name: 'Hide ads', compatibility: [] }] });
  const reader = readerFor(
    { files: [{ path: '/sdcard/Download/Morphe/patches-list.json', name: 'patches-list.json', sizeBytes: list.length, kind: 'json' }] },
    { '/sdcard/Download/Morphe/patches-list.json': list },
  );
  const { sink, state } = sinkWith();

  const discovery = await discoverMorphe(reader, sink);

  assert.deepEqual(state.lists, ['patches-list.json']);
  assert.equal(discovery.found, true);
});

test("Morphe's own preference file yields repository urls", async () => {
  const prefs = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="flutter.sources">[{&quot;url&quot;:&quot;https:\\/\\/github.com\\/MorpheApp\\/morphe-patches&quot;},{&quot;url&quot;:&quot;https:\\/\\/github.com\\/hxreborn\\/morphe-patches.git&quot;}]</string>
</map>`;
  const reader = readerFor(
    { files: [{ path: '/data/data/app.morphe.manager/shared_prefs/FlutterSharedPreferences.xml', name: 'FlutterSharedPreferences.xml', sizeBytes: prefs.length, kind: 'preferences' }] },
    { '/data/data/app.morphe.manager/shared_prefs/FlutterSharedPreferences.xml': prefs },
  );
  const { sink, state } = sinkWith([
    { id: 'morphe-official', name: 'Morphe Patches', repo: 'MorpheApp/morphe-patches', enabled: false },
    { id: 'hxreborn', name: 'hxreborn patches', repo: 'hxreborn/morphe-patches', enabled: false },
  ]);

  const discovery = await discoverMorphe(reader, sink);

  assert.deepEqual(discovery.sources, ['MorpheApp/morphe-patches', 'hxreborn/morphe-patches']);
  assert.deepEqual(state.enabled, ['morphe-official', 'hxreborn']);
  assert.deepEqual(discovery.enabled, ['Morphe Patches', 'hxreborn patches']);
  assert.equal(discovery.added.length, 0);
  assert.equal(discovery.found, true);
});

test('a repository Morphe has that PatchPilot does not is fetched', async () => {
  const prefs = '<string name="sources">https://github.com/someone/other-patches</string>';
  const reader = readerFor(
    { files: [{ path: '/sdcard/Android/media/app.morphe.manager/sources.xml', name: 'sources.xml', sizeBytes: prefs.length, kind: 'preferences' }] },
    { '/sdcard/Android/media/app.morphe.manager/sources.xml': prefs },
  );
  const { sink, state } = sinkWith([]);

  const discovery = await discoverMorphe(reader, sink);

  assert.deepEqual(state.added, ['someone/other-patches']);
  assert.deepEqual(discovery.added, ['someone/other-patches']);
});

test('a file that cannot be read is reported and does not stop the rest', async () => {
  const reader = readerFor(
    {
      files: [
        { path: '/a/locked.mpp', name: 'locked.mpp', sizeBytes: 4, kind: 'bundle' },
        { path: '/a/patches-2.0.0.mpp', name: 'patches-2.0.0.mpp', sizeBytes: 4, kind: 'bundle' },
      ],
    },
    {
      '/a/locked.mpp': new Error('Android does not allow other apps to read this folder'),
      '/a/patches-2.0.0.mpp': 'PK',
    },
  );
  const { sink, state } = sinkWith();

  const discovery = await discoverMorphe(reader, sink);

  assert.equal(discovery.filesRead, 1);
  assert.deepEqual(state.archives, ['patches-2.0.0.mpp']);
  assert.ok(discovery.notes.some((note) => note.includes('locked.mpp') && note.includes('does not allow')));
});

test('Morphe installed with nothing readable says exactly that', async () => {
  const reader = readerFor({ notes: ['Morphe is installed, but Android keeps its source list private to it.'] }, {});
  const { sink } = sinkWith();

  const discovery = await discoverMorphe(reader, sink);

  assert.equal(discovery.found, false);
  assert.equal(discovery.filesRead, 0);
  assert.match(summariseDiscovery(discovery), /Android keeps its sources private/);
});

test('Morphe not installed is not an error', async () => {
  const reader = readerFor({ installed: [], notes: ['Morphe Manager is not installed on this device.'] }, {});
  const { sink } = sinkWith();

  const discovery = await discoverMorphe(reader, sink);

  assert.equal(discovery.found, false);
  assert.match(summariseDiscovery(discovery), /not installed/);
});

test('a granted folder is named in the outcome', async () => {
  const reader = readerFor(
    {
      files: [
        {
          path: 'content://com.android.externalstorage.documents/tree/primary%3ADownload/document/primary%3ADownload%2Fpatches-2.0.0.mpp',
          name: 'patches-2.0.0.mpp',
          sizeBytes: 10,
          kind: 'bundle',
          folder: 'Download',
        },
      ],
      folders: [{ uri: 'content://tree/primary%3ADownload', name: 'Download' }],
    },
    {
      'content://com.android.externalstorage.documents/tree/primary%3ADownload/document/primary%3ADownload%2Fpatches-2.0.0.mpp':
        'PK-not-really-a-zip',
    },
  );
  const { sink, state } = sinkWith();

  const discovery = await discoverMorphe(reader, sink);

  assert.deepEqual(state.archives, ['patches-2.0.0.mpp']);
  assert.deepEqual(discovery.folders, ['Download']);
  assert.equal(discovery.found, true);
});

test('repository and patch-list detection are conservative', () => {
  assert.deepEqual(reposIn('github.com/A/b and https://github.com/c/d.git'), ['A/b', 'c/d']);
  assert.deepEqual(reposIn('https://github.com/owner/repo/releases/tag/v1'), ['owner/repo']);
  assert.deepEqual(reposIn('nothing here'), []);
  assert.equal(looksLikePatchList({ patches: [{ name: 'x' }] }), true);
  assert.equal(looksLikePatchList({ patches: [] }), false);
  assert.equal(looksLikePatchList({ sources: [] }), false);
  assert.equal(looksLikePatchList(null), false);
});
