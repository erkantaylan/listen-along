'use strict';

/**
 * Turns a stream of byte counts into few percent reports: only when the whole
 * percent changed and at most once per intervalMs. Reaching 100% is reported at
 * once (the server then still has to process the file), and finish() reports
 * the last percent reached if the throttle held it back, e.g. when an upload
 * stops early.
 *
 * @param {object} o
 * @param {(percent: number, sent: number, total: number) => void} o.emit
 * @param {number} [o.intervalMs]
 * @param {() => number} [o.now]
 * @returns {{update: (sent: number, total: number) => void, finish: () => void}}
 */
function percentThrottle({ emit, intervalMs = 1000, now = Date.now }) {
  let lastPercent = null;
  let lastAt = -Infinity;
  let latest = null;
  let finished = false;

  const report = () => {
    lastPercent = latest.percent;
    lastAt = now();
    emit(latest.percent, latest.sent, latest.total);
  };

  return {
    update(sent, total) {
      if (finished || !(total > 0)) return;
      const percent = Math.min(100, Math.floor((sent * 100) / total));
      latest = { percent, sent, total };
      if (percent === lastPercent) return;
      if (percent === 100 || now() - lastAt >= intervalMs) report();
    },
    finish() {
      if (finished) return;
      finished = true;
      if (latest && latest.percent !== lastPercent) report();
    },
  };
}

module.exports = { percentThrottle };
