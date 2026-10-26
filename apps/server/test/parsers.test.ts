import { describe, expect, it } from 'vitest';
import { assertComponent, assertInt, assertPackage, assertSerial } from '../src/android/validate.js';
import { patchSmali } from '../src/apk/instrument.js';
import { isSignatureEntry } from '../src/apk/zip.js';
import { sanitizeFileName } from '../src/apps/service.js';
import { parseUiDump } from '../src/automation/ui.js';
import { cpuBetween, parseFramestats, parseMeminfo, parseProcSnapshot, summarizeFrames } from '../src/collectors/device.js';
import { parseInputDevices } from '../src/collectors/input.js';
import { parseDisplayedTime } from '../src/collectors/logcat.js';
import { parseCpuProfile, profileToEvents } from '../src/profiling/cpuprofile.js';
import { safeEqual } from '../src/security.js';

describe('validators (device shell injection guard)', () => {
  it('accepts legitimate values', () => {
    expect(assertPackage('com.example.app')).toBe('com.example.app');
    expect(assertComponent('com.example.app/.MainActivity')).toBe('com.example.app/.MainActivity');
    expect(assertSerial('emulator-5554')).toBe('emulator-5554');
    expect(assertInt(10.4, 0, 100, 'x')).toBe(10);
  });
  it.each(['com.example;rm -rf /', 'com.example app', '$(reboot)', 'com', 'com.ex`id`'])('rejects package %s', (bad) => {
    expect(() => assertPackage(bad)).toThrow();
  });
  it('rejects hostile serials, components and numbers', () => {
    expect(() => assertSerial('a b')).toThrow();
    expect(() => assertComponent('com.a/.Main;reboot')).toThrow();
    expect(() => assertInt(Number.NaN, 0, 1, 'x')).toThrow();
    expect(() => assertInt(1e9, 0, 100, 'x')).toThrow();
  });
});

describe('meminfo', () => {
  it('parses the App Summary', () => {
    const text = ` App Summary
                       Pss(KB)                        Rss(KB)
           Java Heap:     4664                          20044
         Native Heap:    11576                          11728
                Code:     8692                          61452
               Stack:     1316                           1324
            Graphics:     4588                           4588
           TOTAL PSS:    36384            TOTAL RSS:    100652       TOTAL SWAP PSS:       52`;
    expect(parseMeminfo(text)).toEqual({ totalPssKb: 36384, javaHeapKb: 4664, nativeHeapKb: 11576, codeKb: 8692, stackKb: 1316, graphicsKb: 4588 });
    expect(parseMeminfo('No process found for: com.x')).toBeNull();
  });
});

describe('cpu', () => {
  const snap = (total: number, proc: number, main: number, js: number) =>
    `cpu  ${total} 0 0 0 0 0 0 0 0 0\ncpu0 1\ncpu1 1\n` +
    `100 (com.example) S 1 1 0 0 0 0 0 0 0 0 ${proc} 0 0\n` +
    `100 (com.example) S 1 1 0 0 0 0 0 0 0 0 ${main} 0 0\n` +
    `120 (mqt_js) S 1 1 0 0 0 0 0 0 0 0 ${js} 0 0\n`;
  it('computes process and per-thread CPU', () => {
    const a = parseProcSnapshot(snap(1000, 100, 50, 30), 100);
    const b = parseProcSnapshot(snap(1200, 150, 70, 55), 100);
    expect(a && b).toBeTruthy();
    // 200 jiffies over 2 cores → 100 per core; process used 50 → 50%.
    expect(cpuBetween(a!, b!, 100)).toEqual({ total: 50, cores: 2, ui: 20, js: 25 });
  });
  it('handles thread names with spaces and parens', () => {
    const s = parseProcSnapshot('cpu  10 0 0 0 0 0 0 0\ncpu0 1\n7 (a b) c)) S 1 1 0 0 0 0 0 0 0 0 5 5 0\n', 7);
    expect(s?.process).toBe(10);
  });
});

describe('gfxinfo framestats', () => {
  it('parses PROFILEDATA and summarizes jank', () => {
    const text = `Uptime: 5000 Realtime: 5000
---PROFILEDATA---
Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,FrameCompleted,
0,1,1000000000,1000000000,1010000000,
0,2,1016000000,1016000000,1066000000,
1,3,1032000000,1032000000,1040000000,
---PROFILEDATA---`;
    const { uptimeMs, frames } = parseFramestats(text);
    expect(uptimeMs).toBe(5000);
    expect(frames).toEqual([{ start: 1000, duration: 10 }, { start: 1016, duration: 50 }]);
    const summary = summarizeFrames(frames, 1000 / 60);
    expect(summary.janky).toBe(1);
    expect(summary.fps).toBeLessThan(60);
  });
});

describe('logcat helpers', () => {
  it('parses Displayed durations', () => {
    expect(parseDisplayedTime('+1s234ms')).toBe(1234);
    expect(parseDisplayedTime('+523ms')).toBe(523);
    expect(parseDisplayedTime('+2s')).toBe(2000);
    expect(parseDisplayedTime('nope')).toBeNull();
  });
});

describe('getevent device discovery', () => {
  it('finds multi-touch devices and their ranges', () => {
    const text = `add device 1: /dev/input/event1
  name:     "virtio_input_multi_touch_1"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 1439, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 3119, fuzz 0, flat 0, resolution 0
add device 2: /dev/input/event0
  name:     "keyboard"`;
    expect(parseInputDevices(text)).toEqual([{ path: '/dev/input/event1', maxX: 1439, maxY: 3119 }]);
  });
});

describe('uiautomator dump parsing', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" clickable="false" scrollable="false" enabled="true" bounds="[0,0][1080,2400]"><node index="0" text="Log &amp; in" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="" clickable="true" scrollable="false" enabled="true" bounds="[100,200][300,260]" /></node></hierarchy>`;
  it('flattens nodes and decodes entities', () => {
    const snap = parseUiDump(`UI hierchary dumped to: /dev/tty\n${xml}`, { width: 1080, height: 2400 });
    expect(snap.foregroundPackage).toBe('com.example');
    expect(snap.nodes[1]).toMatchObject({ text: 'Log & in', clickable: true, bounds: [100, 200, 300, 260] });
  });
  it('rejects DOCTYPE/entity declarations', () => {
    expect(() => parseUiDump(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><hierarchy></hierarchy>`, { width: 1, height: 1 })).toThrow();
  });
});

describe('smali loader patch', () => {
  const source = `.class public Lcom/facebook/react/bridge/CatalystInstanceImpl;
.method public loadScriptFromAssets(Landroid/content/res/AssetManager;Ljava/lang/String;Z)V
    .locals 2
    .param p1, "assetManager"    # Landroid/content/res/AssetManager;
    .annotation runtime Lcom/facebook/proguard/annotations/DoNotStrip;
    .end annotation

    .line 10
    invoke-virtual {p0, p2}, Lcom/facebook/react/bridge/CatalystInstanceImpl;->setSourceURLs(Ljava/lang/String;Ljava/lang/String;)V
    return-void
.end method

.method public abstract loadScriptFromAssets(Landroid/content/res/AssetManager;Ljava/lang/String;Z)V
.end method
`;
  it('inserts the helper call before the first instruction of concrete methods only', () => {
    const { patched, count } = patchSmali(source);
    expect(count).toBe(1);
    const lines = patched.split('\n');
    const call = lines.findIndex((l) => l.includes('Lcom/rnpa/Prelude;->beforeLoad'));
    const annotationEnd = lines.findIndex((l) => l.includes('.end annotation'));
    expect(call).toBeGreaterThan(annotationEnd);
    expect(lines[call]).toContain('invoke-static/range {p0 .. p3}');
    expect(patchSmali(patched).count).toBe(0);
  });
});

describe('cpu profile import', () => {
  it('turns leaf runs into FUNCTION spans', () => {
    const profile = parseCpuProfile({
      nodes: [
        { id: 1, callFrame: { functionName: '(root)' }, children: [2, 3] },
        { id: 2, callFrame: { functionName: 'renderList', url: 'index.bundle', lineNumber: 10 } },
        { id: 3, callFrame: { functionName: '(idle)' } },
      ],
      startTime: 0,
      endTime: 10_000,
      samples: [2, 2, 2, 3, 2],
      timeDeltas: [0, 1000, 1000, 1000, 1000],
    });
    const events = profileToEvents(profile, { hostStart: 1000 }, 1);
    expect(events.map((e) => [e.metadata.name, e.ts, e.duration])).toEqual([
      ['renderList', 1000, 3],
      ['renderList', 1004, 1],
    ]);
  });
  it('rejects non-profiles', () => {
    expect(() => parseCpuProfile({ hello: 'world' })).toThrow();
  });
});

describe('misc security helpers', () => {
  it('compares secrets in constant time and handles absent values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abd', 'abc')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('ab', 'abc')).toBe(false);
  });
  it('sanitizes uploaded file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\x\\my"app<1>.apk')).toBe('my_app_1_.apk');
  });
  it('identifies v1 signature files only at META-INF root', () => {
    expect(isSignatureEntry('META-INF/CERT.RSA')).toBe(true);
    expect(isSignatureEntry('META-INF/MANIFEST.MF')).toBe(true);
    expect(isSignatureEntry('META-INF/services/x.RSA')).toBe(false);
    expect(isSignatureEntry('META-INF/kotlin.kotlin_module')).toBe(false);
  });
});
