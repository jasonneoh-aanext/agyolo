const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @typedef {Object} PrecheckDefinition
 * @property {'agy_cli' | 'agy_auth'} id
 * @property {string} title
 * @property {string} description
 */

/**
 * @typedef {Object} PrecheckResult
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {boolean} ok
 * @property {'passed' | 'failed'} status
 * @property {string} detail
 * @property {string | null} remediation
 * @property {Record<string, unknown>} meta
 */

/**
 * @typedef {Object} PrechecksReport
 * @property {boolean} ok
 * @property {string} checkedAt
 * @property {number} pauseDurationMs
 * @property {PrecheckResult[]} checks
 */

const DEFAULT_PAUSE_DURATION_MS = 2000;

/** @type { Record<'AGY_CLI' | 'AGY_AUTH', PrecheckDefinition> } */
const PRECHECK_DEFINITIONS = {
  AGY_CLI: {
    id: 'agy_cli',
    title: 'AGY CLI Binary',
    description: 'Verify Antigravity CLI (agy) is installed and executable'
  },
  AGY_AUTH: {
    id: 'agy_auth',
    title: 'AGY Authentication',
    description: 'Verify Antigravity CLI has active authentication credentials'
  }
};

/**
 * Build a standardized PrecheckResult object from a check definition and outcome.
 * @param {PrecheckDefinition} definition
 * @param {{ ok: boolean, detail: string, remediation?: string | null, meta?: Record<string, unknown> }} outcome
 * @returns {PrecheckResult}
 */
function createCheckResult(definition, { ok, detail, remediation = null, meta = {} }) {
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    ok,
    status: ok ? 'passed' : 'failed',
    detail,
    remediation: ok ? null : remediation,
    meta
  };
}

/**
 * Replace leading home directory path with `~` for concise display in UI.
 * @param {string} targetPath
 * @param {string} homeDir
 * @returns {string}
 */
function shortenHomePath(targetPath, homeDir) {
  if (!targetPath || !homeDir) return targetPath || '';
  if (targetPath === homeDir) return '~';
  if (targetPath.startsWith(`${homeDir}${path.sep}`)) {
    return `~${targetPath.slice(homeDir.length)}`;
  }
  return targetPath;
}

/**
 * Check if a file exists and has executable permission bits.
 * @param {string} filePath
 * @param {typeof fs} fsModule
 * @returns {boolean}
 */
function isExecutableFile(filePath, fsModule = fs) {
  if (!filePath) return false;
  try {
    const stat = fsModule.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (stat.mode & 0o111) !== 0;
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the `agy` binary path from configured `agyBin` or system `PATH`.
 * @param {string} configuredAgyBin
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fs} fsModule
 * @returns {string | null}
 */
function resolveAgyBinaryPath(configuredAgyBin, env = process.env, fsModule = fs) {
  if (configuredAgyBin && isExecutableFile(configuredAgyBin, fsModule)) {
    return configuredAgyBin;
  }

  const pathEnv = env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'agy');
    if (isExecutableFile(candidate, fsModule)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Precheck 1: Verify `agy` CLI binary exists, is executable, and responds to `--version`.
 * @param {Object} [options]
 * @param {string} [options.agyBin]
 * @param {string} [options.homeDir]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof execFileSync} [options.execFileSyncFn]
 * @param {typeof fs} [options.fsModule]
 * @returns {PrecheckResult}
 */
function checkAgyCli(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const fsModule = options.fsModule || fs;
  const execFn = options.execFileSyncFn || execFileSync;
  const configuredAgyBin =
    options.agyBin || env.AGY_BIN || path.join(homeDir, '.local', 'bin', 'agy');

  const resolvedBin = resolveAgyBinaryPath(configuredAgyBin, env, fsModule);
  if (!resolvedBin) {
    let existsButNotExecutable = false;
    try {
      const stat = fsModule.statSync(configuredAgyBin);
      existsButNotExecutable = stat.isFile() && (stat.mode & 0o111) === 0;
    } catch (_) {
      existsButNotExecutable = false;
    }

    const displayPath = shortenHomePath(configuredAgyBin, homeDir);
    return createCheckResult(PRECHECK_DEFINITIONS.AGY_CLI, {
      ok: false,
      detail: existsButNotExecutable
        ? `AGY binary at ${displayPath} is not executable`
        : `AGY binary not found at ${displayPath} or in PATH`,
      remediation: existsButNotExecutable
        ? `Run "chmod +x ${displayPath}" in your terminal.`
        : 'Install Antigravity CLI (https://antigravity.google/docs/install) or set the AGY_BIN environment variable.',
      meta: {
        binaryPath: configuredAgyBin,
        version: null
      }
    });
  }

  try {
    const rawOutput = String(
      execFn(resolvedBin, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      }) || ''
    ).trim();

    const firstLine = rawOutput.split(/\r?\n/)[0]?.trim() || 'unknown';
    const version = firstLine.replace(/^agy\s+/i, '').replace(/^v/i, '').trim() || firstLine;
    const displayPath = shortenHomePath(resolvedBin, homeDir);

    return createCheckResult(PRECHECK_DEFINITIONS.AGY_CLI, {
      ok: true,
      detail: `Found agy v${version} (${displayPath})`,
      meta: {
        binaryPath: resolvedBin,
        version
      }
    });
  } catch (err) {
    const displayPath = shortenHomePath(resolvedBin, homeDir);
    const errMsg = err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err);
    return createCheckResult(PRECHECK_DEFINITIONS.AGY_CLI, {
      ok: false,
      detail: `Failed to execute ${displayPath} --version: ${errMsg}`,
      remediation: 'Verify your agy binary installation or reinstall Antigravity CLI.',
      meta: {
        binaryPath: resolvedBin,
        version: null
      }
    });
  }
}

/**
 * Inspect a stored OAuth token JSON payload to determine if it contains valid credentials.
 * Supports both `codeassistclient.StoredToken` (`token: { access_token, refresh_token }`)
 * and flat `oauth2.Token` (`access_token`, `refresh_token`) shapes.
 * @param {unknown} parsed
 * @returns {{ valid: boolean, reason?: string, projectId?: string | null, userTier?: string | null }}
 */
function inspectStoredTokenPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, reason: 'Token file does not contain a JSON object' };
  }

  const record = /** @type {Record<string, unknown>} */ (parsed);
  const nestedToken =
    record.token && typeof record.token === 'object'
      ? /** @type {Record<string, unknown>} */ (record.token)
      : record.Token && typeof record.Token === 'object'
        ? /** @type {Record<string, unknown>} */ (record.Token)
        : null;

  const tokenSource = nestedToken || record;
  const accessToken =
    typeof tokenSource.access_token === 'string'
      ? tokenSource.access_token.trim()
      : typeof tokenSource.AccessToken === 'string'
        ? tokenSource.AccessToken.trim()
        : '';
  const refreshToken =
    typeof tokenSource.refresh_token === 'string'
      ? tokenSource.refresh_token.trim()
      : typeof tokenSource.RefreshToken === 'string'
        ? tokenSource.RefreshToken.trim()
        : '';
  const idToken =
    typeof record.id_token === 'string'
      ? record.id_token.trim()
      : typeof record.IDToken === 'string'
        ? record.IDToken.trim()
        : '';

  if (!accessToken && !refreshToken && !idToken) {
    return { valid: false, reason: 'Stored token file is empty or missing OAuth tokens' };
  }

  // If there is no refresh token and an explicit expiry is in the past, treat as expired
  const expiryRaw = tokenSource.expiry || tokenSource.Expiry;
  if (!refreshToken && typeof expiryRaw === 'string' && expiryRaw.trim()) {
    const expiryMs = Date.parse(expiryRaw);
    if (!Number.isNaN(expiryMs) && expiryMs <= Date.now()) {
      return { valid: false, reason: 'Stored OAuth access token has expired' };
    }
  }

  const projectId =
    typeof record.project_id === 'string'
      ? record.project_id
      : typeof record.projectId === 'string'
        ? record.projectId
        : null;
  const userTier =
    typeof record.user_tier === 'string'
      ? record.user_tier
      : typeof record.userTier === 'string'
        ? record.userTier
        : null;

  return { valid: true, projectId, userTier };
}

/**
 * Precheck 2: Verify `agy` CLI authentication is configured and valid.
 * Checks environment tokens, stored OAuth token files, ADC credentials, and macOS Keychain.
 * @param {Object} [options]
 * @param {string} [options.homeDir]
 * @param {string} [options.agyCliDir]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof execFileSync} [options.execFileSyncFn]
 * @param {typeof fs} [options.fsModule]
 * @param {NodeJS.Platform} [options.platform]
 * @returns {PrecheckResult}
 */
function checkAgyAuth(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const agyCliDir = options.agyCliDir || path.join(homeDir, '.gemini', 'antigravity-cli');
  const env = options.env || process.env;
  const fsModule = options.fsModule || fs;
  const execFn = options.execFileSyncFn || execFileSync;
  const platform = options.platform || process.platform;

  // 1. Direct OAuth token or Gemini API key via environment variables
  if (typeof env.JETSKI_OAUTH_TOKEN === 'string' && env.JETSKI_OAUTH_TOKEN.trim().length > 0) {
    return createCheckResult(PRECHECK_DEFINITIONS.AGY_AUTH, {
      ok: true,
      detail: 'Authenticated via JETSKI_OAUTH_TOKEN environment variable',
      meta: {
        method: 'env_oauth_token',
        source: 'JETSKI_OAUTH_TOKEN'
      }
    });
  }

  if (typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0) {
    return createCheckResult(PRECHECK_DEFINITIONS.AGY_AUTH, {
      ok: true,
      detail: 'Authenticated via GEMINI_API_KEY environment variable',
      meta: {
        method: 'gemini_api_key',
        source: 'GEMINI_API_KEY'
      }
    });
  }

  // 2. Stored OAuth token files in ~/.gemini/antigravity-cli or ~/.gemini
  const tokenCandidates = [
    path.join(agyCliDir, 'antigravity-oauth-token'),
    path.join(agyCliDir, 'antigravity-cli-oauth-token'),
    path.join(homeDir, '.gemini', 'jetski-standalone-oauth-token')
  ];

  /** @type {string | null} */
  let diagnosticFailureDetail = null;

  for (const tokenPath of tokenCandidates) {
    let stat = null;
    try {
      stat = fsModule.statSync(tokenPath);
    } catch (_) {
      stat = null;
    }

    if (!stat || !stat.isFile() || stat.size === 0) {
      continue;
    }

    const displayPath = shortenHomePath(tokenPath, homeDir);
    try {
      const raw = fsModule.readFileSync(tokenPath, 'utf8');
      const parsed = JSON.parse(raw);
      const inspection = inspectStoredTokenPayload(parsed);
      if (inspection.valid) {
        const suffix = inspection.projectId ? ` · project: ${inspection.projectId}` : '';
        return createCheckResult(PRECHECK_DEFINITIONS.AGY_AUTH, {
          ok: true,
          detail: `Authenticated via OAuth token (${displayPath}${suffix})`,
          meta: {
            method: 'oauth_token_file',
            source: tokenPath,
            projectId: inspection.projectId || null,
            userTier: inspection.userTier || null
          }
        });
      }
      diagnosticFailureDetail = `${inspection.reason} (${displayPath})`;
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      // If a sandboxed process can stat the non-empty token file (~1.5KB) but cannot read its contents
      if (code === 'EPERM' || code === 'EACCES') {
        return createCheckResult(PRECHECK_DEFINITIONS.AGY_AUTH, {
          ok: true,
          detail: `Authenticated via OAuth token (${displayPath})`,
          meta: {
            method: 'oauth_token_file',
            source: tokenPath
          }
        });
      }
      diagnosticFailureDetail = `Malformed token file at ${displayPath}`;
    }
  }

  // 3. Application Default Credentials (ADC) when enabled via env or settings.json
  let adcEnabled =
    env.AGY_ADC_AUTH === 'true' ||
    env.AGY_ADC_AUTH === '1' ||
    Boolean(env.GOOGLE_APPLICATION_CREDENTIALS);

  if (!adcEnabled) {
    const settingsPath = path.join(agyCliDir, 'settings.json');
    try {
      const settingsRaw = fsModule.readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(settingsRaw);
      if (settings && typeof settings === 'object' && settings.enableAdc === true) {
        adcEnabled = true;
      }
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      if (code && code !== 'ENOENT' && code !== 'EPERM' && code !== 'EACCES' && !diagnosticFailureDetail) {
        diagnosticFailureDetail = `Unable to read settings at ${shortenHomePath(settingsPath, homeDir)}`;
      } else if (err instanceof SyntaxError && !diagnosticFailureDetail) {
        diagnosticFailureDetail = `Malformed JSON in ${shortenHomePath(settingsPath, homeDir)}`;
      }
    }
  }

  if (adcEnabled) {
    const adcPath =
      env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.join(homeDir, '.config', 'gcloud', 'application_default_credentials.json');
    const displayAdc = shortenHomePath(adcPath, homeDir);
    try {
      const adcStat = fsModule.statSync(adcPath);
      if (adcStat.isFile() && adcStat.size > 0) {
        return createCheckResult(PRECHECK_DEFINITIONS.AGY_AUTH, {
          ok: true,
          detail: `Authenticated via Application Default Credentials (${displayAdc})`,
          meta: {
            method: 'adc',
            source: adcPath
          }
        });
      }
      if (!diagnosticFailureDetail) {
        diagnosticFailureDetail = `ADC credentials file at ${displayAdc} is empty`;
      }
    } catch (_) {
      if (!diagnosticFailureDetail) {
        diagnosticFailureDetail = `ADC enabled but credentials file not found at ${displayAdc}`;
      }
    }
  }

  // 4. OS Keyring (macOS Keychain via `security find-generic-password`)
  if (platform === 'darwin') {
    for (const serviceName of ['antigravity', 'antigravity-cli']) {
      try {
        execFn('security', ['find-generic-password', '-s', serviceName, '-a', 'gemini'], {
          encoding: 'utf8',
          timeout: 2500,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        return createCheckResult(PRECHECK_DEFINITIONS.AGY_AUTH, {
          ok: true,
          detail: `Authenticated via macOS Keychain (${serviceName})`,
          meta: {
            method: 'macos_keychain',
            source: `keychain:${serviceName}/gemini`
          }
        });
      } catch (_) {
        // Keychain item not present for this service name; continue checking next candidate
      }
    }
  }

  return createCheckResult(PRECHECK_DEFINITIONS.AGY_AUTH, {
    ok: false,
    detail: diagnosticFailureDetail || 'No active Antigravity CLI authentication credentials found',
    remediation: 'Run "agy" or "agy login" in your terminal and complete sign-in.',
    meta: {
      method: null,
      source: null
    }
  });
}

/**
 * Run all startup prechecks (or a specific check if `checkId` is passed).
 * @param {Object} [options]
 * @param {string} [options.checkId]
 * @param {string} [options.agyBin]
 * @param {string} [options.homeDir]
 * @param {string} [options.agyCliDir]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof execFileSync} [options.execFileSyncFn]
 * @param {typeof fs} [options.fsModule]
 * @param {NodeJS.Platform} [options.platform]
 * @param {number} [options.pauseDurationMs]
 * @returns {PrechecksReport}
 */
function runPrechecks(options = {}) {
  const allRunners = [
    { id: PRECHECK_DEFINITIONS.AGY_CLI.id, run: () => checkAgyCli(options) },
    { id: PRECHECK_DEFINITIONS.AGY_AUTH.id, run: () => checkAgyAuth(options) }
  ];

  const requestedId = typeof options.checkId === 'string' ? options.checkId.trim() : '';
  if (requestedId && !allRunners.some((entry) => entry.id === requestedId)) {
    const validIds = allRunners.map((entry) => entry.id).join(', ');
    const err = new Error(`Unknown precheck id "${requestedId}". Valid ids: ${validIds}`);
    /** @type {Error & { code?: string }} */ (err).code = 'INVALID_PRECHECK_ID';
    throw err;
  }

  const selectedRunners = requestedId
    ? allRunners.filter((entry) => entry.id === requestedId)
    : allRunners;

  const checks = selectedRunners.map((entry) => entry.run());
  const pauseDurationMs =
    typeof options.pauseDurationMs === 'number' && options.pauseDurationMs >= 0
      ? options.pauseDurationMs
      : DEFAULT_PAUSE_DURATION_MS;

  return {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    checkedAt: new Date().toISOString(),
    pauseDurationMs,
    checks
  };
}

module.exports = {
  DEFAULT_PAUSE_DURATION_MS,
  PRECHECK_DEFINITIONS,
  shortenHomePath,
  resolveAgyBinaryPath,
  inspectStoredTokenPayload,
  checkAgyCli,
  checkAgyAuth,
  runPrechecks
};
