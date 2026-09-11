import { ribbit } from "./dsp.js";

function mergeExtended(intervals, extension, durationSeconds) {
  const extended = intervals
    .map((interval) => ({
      label: interval.label,
      start: interval.start - extension,
      end: interval.end + extension,
    }))
    .sort((left, right) => left.start - right.start);
  if (extended.length === 0) return [];

  const merged = [{ ...extended[0] }];
  for (let index = 1; index < extended.length; index += 1) {
    const current = merged[merged.length - 1];
    const next = extended[index];
    if (current.end >= next.start) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }

  return merged
    .map((interval) => ({
      label: interval.label,
      start: Math.max(0, interval.start + extension),
      end: Math.min(durationSeconds, interval.end - extension),
    }))
    .filter((interval) => interval.end > interval.start);
}

function subtractIntervals(interval, covers) {
  let fragments = [{ ...interval }];
  for (const cover of covers) {
    const nextFragments = [];
    for (const fragment of fragments) {
      if (cover.end <= fragment.start || cover.start >= fragment.end) {
        nextFragments.push(fragment);
        continue;
      }
      if (cover.start > fragment.start) nextFragments.push({ ...fragment, end: cover.start });
      if (cover.end < fragment.end) nextFragments.push({ ...fragment, start: cover.end });
    }
    fragments = nextFragments;
  }
  return fragments.filter((fragment) => fragment.end > fragment.start);
}

function processClass(source, label, extension, higherPriority, durationSeconds) {
  const trimmed = source
    .filter((interval) => interval.label === label)
    .flatMap((interval) => subtractIntervals(interval, higherPriority));
  return mergeExtended(trimmed, extension, durationSeconds);
}

export function postProcessStates(states, recordingDurationSeconds, options = {}) {
  const {
    minimumBoutSeconds = 180,
    candidateScoreThreshold = 0.1,
    ribbitBandHz = [0.05, 0.1],
  } = options;
  const rawIntervals = states.map((state) => ({
    label: state.class,
    start: state.start,
    end: state.end,
  }));

  const negative = processClass(rawIntervals, "N", 1, [], recordingDurationSeconds);
  const positive = processClass(rawIntervals, "P", 60, negative, recordingDurationSeconds);
  const coveredNegative = negative.flatMap((interval) => subtractIntervals(interval, positive));
  const intervals = [...positive, ...coveredNegative].sort((left, right) => left.start - right.start);

  const retained = positive
    .filter((interval) => interval.end - interval.start > minimumBoutSeconds)
    .sort((left, right) => left.start - right.start)
    .map((interval, index) => {
      const boutEnvelope = states
        .filter((state) => state.start >= interval.start && state.end <= interval.end)
        .map((state) => state.env);
      const score = ribbit(boutEnvelope, {
        windowLength: 180,
        overlapPercent: 50,
        callRateBandHz: ribbitBandHz,
      });
      return {
        ...interval,
        selec: index + 1,
        ribbit: score,
        is_candidate: score > candidateScoreThreshold,
      };
    });

  return { intervals, bouts: retained };
}
