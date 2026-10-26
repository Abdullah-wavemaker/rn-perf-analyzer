import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataPaths } from '../config.js';
import { run } from '../exec.js';
import { requireTool, type Toolchain } from '../android/sdk.js';

const ALIAS = 'rnpa';

interface Keystore {
  path: string;
  password: string;
}

/**
 * A local, per-installation signing key for instrumented builds. Generated on
 * first use with a random password stored next to it (owner-only perms). The
 * password reaches keytool/apksigner through the environment, never argv, so
 * it does not show up in process listings.
 */
async function ensureKeystore(paths: DataPaths, tools: Toolchain): Promise<Keystore> {
  const path = join(paths.keystore, 'rnpa-test-signing.p12');
  const passwordPath = join(paths.keystore, 'password');
  if (existsSync(path) && existsSync(passwordPath)) {
    return { path, password: readFileSync(passwordPath, 'utf8').trim() };
  }
  const keytool = requireTool(tools.keytool, 'keytool (JDK)');
  const password = randomBytes(24).toString('base64url');
  writeFileSync(passwordPath, password, { mode: 0o600 });
  await run(
    keytool,
    [
      '-genkeypair', '-keystore', path, '-storetype', 'PKCS12', '-alias', ALIAS,
      '-keyalg', 'RSA', '-keysize', '3072', '-validity', '3650',
      '-dname', 'CN=RN Performance Analyzer local test key',
      '-storepass:env', 'RNPA_KS_PASS', '-keypass:env', 'RNPA_KS_PASS',
    ],
    { env: { ...process.env, RNPA_KS_PASS: password }, timeoutMs: 120_000 },
  );
  chmodSync(path, 0o600);
  return { path, password };
}

/** zipalign + apksigner (v1–v3 as appropriate for minSdk), then verify. */
export async function alignAndSign(input: string, output: string, paths: DataPaths, tools: Toolchain, signal?: AbortSignal): Promise<void> {
  const zipalign = requireTool(tools.zipalign, 'zipalign (Android build-tools)');
  const apksigner = requireTool(tools.apksigner, 'apksigner (Android build-tools)');
  const keystore = await ensureKeystore(paths, tools);
  const aligned = `${output}.aligned`;
  const pageArgs = tools.zipalignPageSize ? ['-P', '16'] : ['-p'];
  await run(zipalign, ['-f', ...pageArgs, '4', input, aligned], { timeoutMs: 10 * 60_000, signal });
  const env = { ...process.env, RNPA_KS_PASS: keystore.password };
  await run(
    apksigner,
    ['sign', '--ks', keystore.path, '--ks-key-alias', ALIAS, '--ks-pass', 'env:RNPA_KS_PASS', '--key-pass', 'env:RNPA_KS_PASS', '--v4-signing-enabled', 'false', '--out', output, aligned],
    { env, timeoutMs: 10 * 60_000, signal },
  );
  chmodSync(output, 0o600);
  await run(apksigner, ['verify', output], { timeoutMs: 5 * 60_000, signal });
  await rm(aligned, { force: true });
}
