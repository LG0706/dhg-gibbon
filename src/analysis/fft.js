import FFT from "fft.js";

const PLAN_CACHE = new Map();

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function assertInput(input, length) {
  if (!input || input.length !== length) {
    throw new RangeError(`FFT 输入长度必须为 ${length}`);
  }
}

function createPowerOfTwoPlan(length) {
  const fft = new FFT(length);
  const complex = new Float64Array(length * 2);
  const real = new Float64Array(Math.floor(length / 2) + 1);
  const imag = new Float64Array(real.length);

  return {
    length,
    binCount: real.length,
    algorithm: "radix-4",
    transform(input) {
      assertInput(input, length);
      fft.realTransform(complex, input);
      for (let bin = 0; bin < real.length; bin += 1) {
        real[bin] = complex[bin * 2];
        imag[bin] = complex[bin * 2 + 1];
      }
      return { real, imag };
    },
    magnitudes(input, output = new Float64Array(real.length)) {
      const spectrum = this.transform(input);
      for (let bin = 0; bin < output.length; bin += 1) {
        output[bin] = Math.hypot(spectrum.real[bin], spectrum.imag[bin]);
      }
      return output;
    },
  };
}

function createBluesteinPlan(length) {
  const convolutionLength = nextPowerOfTwo(length * 2 - 1);
  const fft = new FFT(convolutionLength);
  const chirpReal = new Float64Array(length);
  const chirpImag = new Float64Array(length);
  const kernel = new Float64Array(convolutionLength * 2);
  const kernelSpectrum = new Float64Array(convolutionLength * 2);
  const work = new Float64Array(convolutionLength * 2);
  const workSpectrum = new Float64Array(convolutionLength * 2);
  const convolution = new Float64Array(convolutionLength * 2);
  const real = new Float64Array(Math.floor(length / 2) + 1);
  const imag = new Float64Array(real.length);

  for (let index = 0; index < length; index += 1) {
    const angle = Math.PI * ((index * index) % (length * 2)) / length;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    chirpReal[index] = cosine;
    chirpImag[index] = -sine;
    kernel[index * 2] = cosine;
    kernel[index * 2 + 1] = sine;
    if (index !== 0) {
      const mirrored = convolutionLength - index;
      kernel[mirrored * 2] = cosine;
      kernel[mirrored * 2 + 1] = sine;
    }
  }
  fft.transform(kernelSpectrum, kernel);

  return {
    length,
    binCount: real.length,
    algorithm: "bluestein",
    convolutionLength,
    transform(input) {
      assertInput(input, length);
      work.fill(0);
      for (let index = 0; index < length; index += 1) {
        work[index * 2] = input[index] * chirpReal[index];
        work[index * 2 + 1] = input[index] * chirpImag[index];
      }
      fft.transform(workSpectrum, work);
      for (let index = 0; index < convolutionLength; index += 1) {
        const offset = index * 2;
        const ar = workSpectrum[offset];
        const ai = workSpectrum[offset + 1];
        const br = kernelSpectrum[offset];
        const bi = kernelSpectrum[offset + 1];
        convolution[offset] = ar * br - ai * bi;
        convolution[offset + 1] = ar * bi + ai * br;
      }
      fft.inverseTransform(work, convolution);
      for (let bin = 0; bin < real.length; bin += 1) {
        const offset = bin * 2;
        const valueReal = work[offset];
        const valueImag = work[offset + 1];
        real[bin] = valueReal * chirpReal[bin] - valueImag * chirpImag[bin];
        imag[bin] = valueReal * chirpImag[bin] + valueImag * chirpReal[bin];
      }
      return { real, imag };
    },
    magnitudes(input, output = new Float64Array(real.length)) {
      const spectrum = this.transform(input);
      for (let bin = 0; bin < output.length; bin += 1) {
        output[bin] = Math.hypot(spectrum.real[bin], spectrum.imag[bin]);
      }
      return output;
    },
  };
}

export function createRealFftPlan(length) {
  if (!Number.isSafeInteger(length) || length < 2) {
    throw new RangeError("FFT 长度必须是大于 1 的整数");
  }
  if (!PLAN_CACHE.has(length)) {
    PLAN_CACHE.set(length, isPowerOfTwo(length) ? createPowerOfTwoPlan(length) : createBluesteinPlan(length));
  }
  return PLAN_CACHE.get(length);
}
