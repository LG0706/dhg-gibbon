const FLOOR = 1e-6;
const MAX_ITERATIONS = 200;
const CONVERGENCE_DELTA = 1e-6;
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

function fallback(envelope, reason) {
  const normalized = new Float64Array(envelope.length);
  return {
    classes: Array(envelope.length).fill("N"),
    normalized,
    posterior: Array.from({ length: envelope.length }, () => [1, 0]),
    means: [0, 0],
    variances: [FLOOR, FLOOR],
    transitions: [[0.9, 0.1], [0.1, 0.9]],
    converged: false,
    iterations: 0,
    reason,
  };
}

function percentile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function gaussian(value, mean, variance) {
  const safeVariance = Math.max(variance, FLOOR);
  const difference = value - mean;
  const density = Math.exp(-(difference * difference) / (2 * safeVariance)) / (SQRT_TWO_PI * Math.sqrt(safeVariance));
  return Math.max(density, Number.MIN_VALUE);
}
function viterbiClasses(normalized, initial, transitions, means, variances) {
  const length = normalized.length;
  const backFromZero = new Uint8Array(length);
  const backFromOne = new Uint8Array(length);
  let previousZero = Math.log(initial[0]) + Math.log(gaussian(normalized[0], means[0], variances[0]));
  let previousOne = Math.log(initial[1]) + Math.log(gaussian(normalized[0], means[1], variances[1]));

  for (let time = 1; time < length; time += 1) {
    const toZeroFromZero = previousZero + Math.log(transitions[0][0]);
    const toZeroFromOne = previousOne + Math.log(transitions[1][0]);
    const toOneFromZero = previousZero + Math.log(transitions[0][1]);
    const toOneFromOne = previousOne + Math.log(transitions[1][1]);
    backFromZero[time] = toZeroFromOne > toZeroFromZero ? 1 : 0;
    backFromOne[time] = toOneFromOne > toOneFromZero ? 1 : 0;
    previousZero = Math.max(toZeroFromZero, toZeroFromOne)
      + Math.log(gaussian(normalized[time], means[0], variances[0]));
    previousOne = Math.max(toOneFromZero, toOneFromOne)
      + Math.log(gaussian(normalized[time], means[1], variances[1]));
  }

  const path = new Uint8Array(length);
  path[length - 1] = previousOne > previousZero ? 1 : 0;
  for (let time = length - 2; time >= 0; time -= 1) {
    path[time] = path[time + 1] === 0 ? backFromZero[time + 1] : backFromOne[time + 1];
  }
  const positiveState = means[0] > means[1] ? 0 : 1;
  return Array.from(path, (state) => (state === positiveState ? "P" : "N"));
}

export function fitEnergyHmm(envelope) {
  if (!envelope || envelope.length < 2) return fallback(envelope ?? [], "insufficient_data");
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const raw of envelope) {
    if (!Number.isFinite(raw)) return fallback(envelope, "non_finite_input");
    if (raw < minimum) minimum = raw;
    if (raw > maximum) maximum = raw;
  }
  if (!(maximum > minimum)) return fallback(envelope, "flat_sequence");

  const normalized = Float64Array.from(envelope, (value) => (value - minimum) / (maximum - minimum));
  const sorted = Array.from(normalized).sort((a, b) => a - b);
  const globalMean = normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const globalVariance = normalized.reduce((sum, value) => sum + (value - globalMean) ** 2, 0) / normalized.length;

  let initial = [0.5, 0.5];
  let transitions = [[0.9, 0.1], [0.1, 0.9]];
  let means = [percentile(sorted, 0.25), percentile(sorted, 0.75)];
  let variances = [Math.max(globalVariance, FLOOR), Math.max(globalVariance, FLOOR)];
  let previousLogLikelihood = -Infinity;
  let converged = false;
  let completedIterations = 0;
  let finalGamma = null;

  const length = normalized.length;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const emissions = Array.from({ length }, () => new Float64Array(2));
    const alpha = Array.from({ length }, () => new Float64Array(2));
    const beta = Array.from({ length }, () => new Float64Array(2));
    const gamma = Array.from({ length }, () => new Float64Array(2));
    const scales = new Float64Array(length);

    for (let time = 0; time < length; time += 1) {
      emissions[time][0] = gaussian(normalized[time], means[0], variances[0]);
      emissions[time][1] = gaussian(normalized[time], means[1], variances[1]);
    }

    alpha[0][0] = initial[0] * emissions[0][0];
    alpha[0][1] = initial[1] * emissions[0][1];
    scales[0] = Math.max(alpha[0][0] + alpha[0][1], Number.MIN_VALUE);
    alpha[0][0] /= scales[0];
    alpha[0][1] /= scales[0];

    for (let time = 1; time < length; time += 1) {
      for (let state = 0; state < 2; state += 1) {
        alpha[time][state] = emissions[time][state] * (
          alpha[time - 1][0] * transitions[0][state] + alpha[time - 1][1] * transitions[1][state]
        );
      }
      scales[time] = Math.max(alpha[time][0] + alpha[time][1], Number.MIN_VALUE);
      alpha[time][0] /= scales[time];
      alpha[time][1] /= scales[time];
    }

    beta[length - 1][0] = 1;
    beta[length - 1][1] = 1;
    for (let time = length - 2; time >= 0; time -= 1) {
      for (let state = 0; state < 2; state += 1) {
        beta[time][state] = (
          transitions[state][0] * emissions[time + 1][0] * beta[time + 1][0]
          + transitions[state][1] * emissions[time + 1][1] * beta[time + 1][1]
        ) / Math.max(scales[time + 1], Number.MIN_VALUE);
      }
    }

    for (let time = 0; time < length; time += 1) {
      const denominator = Math.max(
        alpha[time][0] * beta[time][0] + alpha[time][1] * beta[time][1],
        Number.MIN_VALUE,
      );
      gamma[time][0] = (alpha[time][0] * beta[time][0]) / denominator;
      gamma[time][1] = (alpha[time][1] * beta[time][1]) / denominator;
    }

    const transitionNumerators = [[0, 0], [0, 0]];
    const transitionDenominators = [0, 0];
    for (let time = 0; time < length - 1; time += 1) {
      let denominator = 0;
      for (let from = 0; from < 2; from += 1) {
        for (let to = 0; to < 2; to += 1) {
          denominator += alpha[time][from] * transitions[from][to] * emissions[time + 1][to] * beta[time + 1][to];
        }
      }
      denominator = Math.max(denominator, Number.MIN_VALUE);
      for (let from = 0; from < 2; from += 1) {
        transitionDenominators[from] += gamma[time][from];
        for (let to = 0; to < 2; to += 1) {
          transitionNumerators[from][to] += (
            alpha[time][from] * transitions[from][to] * emissions[time + 1][to] * beta[time + 1][to]
          ) / denominator;
        }
      }
    }

    const nextMeans = [0, 0];
    const stateWeights = [0, 0];
    for (let time = 0; time < length; time += 1) {
      for (let state = 0; state < 2; state += 1) {
        stateWeights[state] += gamma[time][state];
        nextMeans[state] += gamma[time][state] * normalized[time];
      }
    }
    for (let state = 0; state < 2; state += 1) {
      nextMeans[state] /= Math.max(stateWeights[state], FLOOR);
    }

    const nextVariances = [0, 0];
    for (let time = 0; time < length; time += 1) {
      for (let state = 0; state < 2; state += 1) {
        nextVariances[state] += gamma[time][state] * (normalized[time] - nextMeans[state]) ** 2;
      }
    }
    for (let state = 0; state < 2; state += 1) {
      nextVariances[state] = Math.max(nextVariances[state] / Math.max(stateWeights[state], FLOOR), FLOOR);
    }

    const nextTransitions = [[0, 0], [0, 0]];
    for (let from = 0; from < 2; from += 1) {
      const denominator = Math.max(transitionDenominators[from], FLOOR);
      nextTransitions[from][0] = Math.max(transitionNumerators[from][0] / denominator, FLOOR);
      nextTransitions[from][1] = Math.max(transitionNumerators[from][1] / denominator, FLOOR);
      const rowSum = nextTransitions[from][0] + nextTransitions[from][1];
      nextTransitions[from][0] /= rowSum;
      nextTransitions[from][1] /= rowSum;
    }

    const logLikelihood = Array.from(scales).reduce((sum, value) => sum + Math.log(value), 0);
    const finite = Number.isFinite(logLikelihood)
      && nextMeans.every(Number.isFinite)
      && nextVariances.every(Number.isFinite)
      && nextTransitions.flat().every(Number.isFinite);
    if (!finite) return fallback(envelope, "non_finite_iteration");

    initial = [Math.max(gamma[0][0], FLOOR), Math.max(gamma[0][1], FLOOR)];
    const initialSum = initial[0] + initial[1];
    initial = initial.map((value) => value / initialSum);
    transitions = nextTransitions;
    means = nextMeans;
    variances = nextVariances;
    finalGamma = gamma;
    completedIterations = iteration;

    if (iteration > 1 && Math.abs(logLikelihood - previousLogLikelihood) < CONVERGENCE_DELTA) {
      converged = true;
      break;
    }
    previousLogLikelihood = logLikelihood;
  }

  if (!converged || !finalGamma) return fallback(envelope, "not_converged");
  const classes = viterbiClasses(normalized, initial, transitions, means, variances);

  return {
    classes,
    normalized,
    posterior: finalGamma.map((values) => Array.from(values)),
    means,
    variances,
    transitions,
    converged,
    iterations: completedIterations,
    reason: null,
  };
}
