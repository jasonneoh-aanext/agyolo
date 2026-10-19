const PRECHECK_PAUSE_MS = 2000;
const PRECHECK_DEFINITIONS = [
  {
    id: 'agy_cli',
    title: 'AGY CLI Binary',
    description: 'Verify Antigravity CLI (agy) is installed and executable'
  },
  {
    id: 'agy_auth',
    title: 'AGY Authentication',
    description: 'Verify Antigravity CLI has active authentication credentials'
  }
];

const precheckModalEl = document.getElementById('precheckModal');
const precheckModalSubtitleEl = document.getElementById('precheckModalSubtitle');
const precheckStatusBadgeEl = document.getElementById('precheckStatusBadge');
const precheckProgressLabelEl = document.getElementById('precheckProgressLabel');
const precheckProgressPercentEl = document.getElementById('precheckProgressPercent');
const precheckProgressFillEl = document.getElementById('precheckProgressFill');
const precheckListEl = document.getElementById('precheckList');
const precheckFooterHintEl = document.getElementById('precheckFooterHint');
const precheckActionsEl = document.getElementById('precheckActions');
const precheckDismissBtn = document.getElementById('precheckDismissBtn');
const precheckRetryBtn = document.getElementById('precheckRetryBtn');

let isPrecheckRunning = false;

function escapePrecheckHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderPrecheckSteps(steps) {
  if (!precheckListEl) return;
  precheckListEl.innerHTML = steps
    .map((step) => {
      const stateClass = step.state || 'pending';
      let iconText = '•';
      let statusLabel = 'Pending';
      if (stateClass === 'checking') {
        iconText = '';
        statusLabel = 'Checking...';
      } else if (stateClass === 'passed') {
        iconText = '✓';
        statusLabel = 'Passed';
      } else if (stateClass === 'failed') {
        iconText = '✕';
        statusLabel = 'Failed';
      }

      const remediationHtml =
        stateClass === 'failed' && step.remediation
          ? `<div class="precheck-step-remediation">${escapePrecheckHtml(step.remediation)}</div>`
          : '';

      return `
        <div class="precheck-step ${escapePrecheckHtml(stateClass)}" role="listitem" data-check-id="${escapePrecheckHtml(step.id)}">
          <div class="precheck-step-icon" aria-hidden="true">${iconText}</div>
          <div class="precheck-step-body">
            <div class="precheck-step-header">
              <span class="precheck-step-title">${escapePrecheckHtml(step.title)}</span>
              <span class="precheck-step-status">${escapePrecheckHtml(statusLabel)}</span>
            </div>
            <div class="precheck-step-detail">${escapePrecheckHtml(step.detail || step.description)}</div>
            ${remediationHtml}
          </div>
        </div>
      `;
    })
    .join('');
}

function setPrecheckProgress(percent, label, variant = 'checking') {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (precheckProgressPercentEl) {
    precheckProgressPercentEl.textContent = `${clamped}%`;
  }
  if (precheckProgressLabelEl && label) {
    precheckProgressLabelEl.textContent = label;
  }
  if (precheckProgressFillEl) {
    precheckProgressFillEl.style.width = `${clamped}%`;
    precheckProgressFillEl.classList.remove('passed', 'failed');
    if (variant === 'passed' || variant === 'failed') {
      precheckProgressFillEl.classList.add(variant);
    }
  }
}

function setPrecheckBadge(text, variant = 'checking') {
  if (!precheckStatusBadgeEl) return;
  precheckStatusBadgeEl.textContent = text;
  precheckStatusBadgeEl.className = `precheck-badge ${variant}`;
}

function dismissPrecheckModal() {
  if (!precheckModalEl) return;
  precheckModalEl.classList.add('closing');
  setTimeout(() => {
    precheckModalEl.classList.add('hidden');
    precheckModalEl.classList.remove('closing');
    const composerInput = document.getElementById('promptInput');
    if (composerInput) {
      composerInput.focus();
    }
  }, 220);
}

async function fetchSinglePrecheck(checkDef) {
  try {
    const tauriInvoke =
      typeof window !== 'undefined' &&
      window.__TAURI__ &&
      window.__TAURI__.core &&
      typeof window.__TAURI__.core.invoke === 'function'
        ? window.__TAURI__.core.invoke
        : null;

    if (!tauriInvoke) {
      throw new Error('Tauri IPC runtime (window.__TAURI__.core.invoke) is not available.');
    }

    const data = await tauriInvoke('run_prechecks', { check: checkDef.id });

    const matched = Array.isArray(data.checks)
      ? data.checks.find((c) => c.id === checkDef.id) || data.checks[0]
      : null;
    const pauseDurationMs =
      typeof data.pauseDurationMs === 'number' && data.pauseDurationMs >= 0
        ? data.pauseDurationMs
        : PRECHECK_PAUSE_MS;

    if (matched) {
      return {
        ok: Boolean(matched.ok),
        detail: matched.detail || checkDef.description,
        remediation: matched.remediation || null,
        pauseDurationMs
      };
    }

    return {
      ok: false,
      detail: `No result returned for ${checkDef.title}`,
      remediation: 'Check application logs and retry.',
      pauseDurationMs
    };
  } catch (err) {
    return {
      ok: false,
      detail: `Precheck invocation failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Ensure the Antigravity Console Tauri backend is running.',
      pauseDurationMs: PRECHECK_PAUSE_MS
    };
  }
}

async function runStartupPrechecks() {
  if (!precheckModalEl || isPrecheckRunning) return;
  isPrecheckRunning = true;

  try {
    const steps = PRECHECK_DEFINITIONS.map((def) => ({
      ...def,
      state: 'pending',
      detail: def.description,
      remediation: null
    }));
    const total = steps.length;

    precheckModalEl.classList.remove('hidden', 'closing');
    if (precheckActionsEl) {
      precheckActionsEl.classList.add('hidden');
    }
    if (precheckModalSubtitleEl) {
      precheckModalSubtitleEl.textContent =
        'Verifying Antigravity CLI environment before starting...';
    }
    setPrecheckBadge(`Checking 1/${total}`, 'checking');
    setPrecheckProgress(0, 'Starting prechecks...', 'checking');
    if (precheckFooterHintEl) {
      precheckFooterHintEl.textContent = 'Pausing 2s on each check before advancing...';
    }
    renderPrecheckSteps(steps);

    for (let i = 0; i < total; i++) {
      const step = steps[i];
      step.state = 'checking';
      step.detail = `Checking ${step.title}...`;
      setPrecheckBadge(`Checking ${i + 1}/${total}`, 'checking');
      setPrecheckProgress(
        Math.round((i / total) * 100),
        `Step ${i + 1} of ${total} · Checking ${step.title}...`,
        'checking'
      );
      renderPrecheckSteps(steps);

      const result = await fetchSinglePrecheck(step);
      step.state = result.ok ? 'passed' : 'failed';
      step.detail = result.detail;
      step.remediation = result.remediation;

      const stepProgressPct = Math.round(((i + 1) / total) * 100);
      setPrecheckProgress(
        stepProgressPct,
        `Step ${i + 1} of ${total} · ${step.title}: ${result.ok ? 'Passed' : 'Failed'}`,
        result.ok ? 'checking' : 'failed'
      );
      if (precheckFooterHintEl) {
        precheckFooterHintEl.textContent = `Check ${i + 1} of ${total} complete · pausing 2s...`;
      }
      renderPrecheckSteps(steps);

      await sleepMs(result.pauseDurationMs);
    }

    const allPassed = steps.every((s) => s.state === 'passed');
    if (allPassed) {
      setPrecheckBadge('All Passed', 'passed');
      setPrecheckProgress(100, 'All startup prechecks passed', 'passed');
      if (precheckModalSubtitleEl) {
        precheckModalSubtitleEl.textContent = 'Environment verified and ready.';
      }
      if (precheckFooterHintEl) {
        precheckFooterHintEl.textContent = 'All checks passed — dismissing modal...';
      }
      dismissPrecheckModal();
    } else {
      setPrecheckBadge('Check Failed', 'failed');
      setPrecheckProgress(100, 'One or more startup prechecks failed', 'failed');
      if (precheckModalSubtitleEl) {
        precheckModalSubtitleEl.textContent =
          'Please resolve the issue(s) below and retry.';
      }
      if (precheckFooterHintEl) {
        precheckFooterHintEl.textContent = 'Prechecks failed.';
      }
      if (precheckActionsEl) {
        precheckActionsEl.classList.remove('hidden');
      }
    }
  } finally {
    isPrecheckRunning = false;
  }
}

if (precheckRetryBtn) {
  precheckRetryBtn.addEventListener('click', () => {
    runStartupPrechecks();
  });
}

if (precheckDismissBtn) {
  precheckDismissBtn.addEventListener('click', () => {
    dismissPrecheckModal();
  });
}

window.runStartupPrechecks = runStartupPrechecks;
