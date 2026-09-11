export const IMAGE_RENDERER_VERSION = "r-ggplot-v1";

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function rgbToLab([red, green, blue]) {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const transform = (value) => (
    value > 0.008856451679 ? Math.cbrt(value) : 7.787037037 * value + 16 / 116
  );
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb([lightness, a, b]) {
  const fy = (lightness + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const transform = (value) => {
    const cube = value ** 3;
    return cube > 0.008856451679 ? cube : (value - 16 / 116) / 7.787037037;
  };
  const x = 0.95047 * transform(fx);
  const y = transform(fy);
  const z = 1.08883 * transform(fz);
  const linear = [
    x * 3.2404542 + y * -1.5371385 + z * -0.4985314,
    x * -0.969266 + y * 1.8760108 + z * 0.041556,
    x * 0.0556434 + y * -0.2040259 + z * 1.0572252,
  ];
  return linear.map((channel) => {
    const value = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(clamp(value, 0, 1) * 255);
  });
}

const SPECTROGRAM_LOW_LAB = rgbToLab([19, 43, 67]);
const SPECTROGRAM_HIGH_LAB = rgbToLab([86, 177, 247]);
const SPECTROGRAM_PALETTE = Array.from({ length: 256 }, (_, index) => {
  const amount = index / 255;
  const lab = SPECTROGRAM_LOW_LAB.map((value, channel) => (
    value + (SPECTROGRAM_HIGH_LAB[channel] - value) * amount
  ));
  const [red, green, blue] = labToRgb(lab);
  return `rgb(${red}, ${green}, ${blue})`;
});

function colorFor(value) {
  return SPECTROGRAM_PALETTE[Math.round(clamp(value, 0, 1) * 255)];
}

function displayEnergy(overview) {
  const current = overview.energy ?? [];
  const currentMinimum = current.length ? Math.min(...current) : 0;
  const currentMaximum = current.length ? Math.max(...current) : 0;
  if (currentMaximum > currentMinimum) return current;
  const raw = overview.rawEnergy ?? [];
  if (raw.length === 0) return current;
  const minimum = Math.min(...raw);
  const maximum = Math.max(...raw);
  if (!(maximum > minimum)) return raw.map(() => 0.5);
  return raw.map((value) => (value - minimum) / (maximum - minimum));
}

function drawOverview(context, result, x, y, width, height) {
  const energy = displayEnergy(result.overview);
  const duration = result.metrics.audioSeconds || energy.length || 1;
  const xMinimum = -duration * 0.05;
  const xMaximum = duration * 1.05;
  const dataMinimum = result.detections.length > 0 ? -0.1 : -0.05;
  const dataMaximum = Math.max(1, ...energy);
  const yExpansion = (dataMaximum - dataMinimum) * 0.05;
  const yMinimum = dataMinimum - yExpansion;
  const yMaximum = dataMaximum + yExpansion;
  const mapX = (value) => x + ((value - xMinimum) / (xMaximum - xMinimum)) * width;
  const mapY = (value) => y + ((yMaximum - value) / (yMaximum - yMinimum)) * height;

  context.fillStyle = "#ffffff";
  context.fillRect(x, y, width, height);

  const states = result.overview.states ?? [];
  for (let index = 0; index < result.overview.classes.length; index += 1) {
    const state = states[index];
    const start = state?.start ?? index + 0.5;
    const end = state?.end ?? index + 1.5;
    const left = mapX(start);
    const right = mapX(end);
    context.fillStyle = result.overview.classes[index] === "P" ? "#28ae80" : "#472d7b";
    context.fillRect(left, mapY(-0.05) - 11, Math.max(1, right - left), 22);
  }

  for (const detection of result.detections) {
    const left = mapX(detection.start);
    const right = mapX(detection.end);
    context.fillStyle = "#21918c";
    context.fillRect(left, mapY(-0.1) - 11, Math.max(2, right - left), 22);
    context.fillStyle = "#ffffff";
    context.font = "17px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(detection.ribbit.toFixed(2), (left + right) / 2, mapY(-0.1));
  }

  if (energy.length > 0) {
    context.strokeStyle = "#111111";
    context.lineWidth = 1.15;
    context.beginPath();
    for (let index = 0; index < energy.length; index += 1) {
      const pointX = mapX(states[index]?.t ?? index + 1);
      const pointY = mapY(clamp(energy[index], 0, 1));
      if (index === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    }
    context.stroke();
  }

  context.strokeStyle = "#3b3b3b";
  context.lineWidth = 1;
  context.strokeRect(x, y, width, height);
  context.fillStyle = "#3b3b3b";
  context.font = "16px Arial, sans-serif";
  context.textBaseline = "middle";
  context.textAlign = "right";
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = tick / 4;
    const tickY = mapY(value);
    context.beginPath();
    context.moveTo(x - 6, tickY);
    context.lineTo(x, tickY);
    context.stroke();
    context.fillText(value.toFixed(2), x - 10, tickY);
  }

  const roughStep = duration / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, roughStep)));
  const normalizedStep = roughStep / magnitude;
  const step = (normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10) * magnitude;
  context.textAlign = "center";
  context.textBaseline = "top";
  for (let value = 0; value <= duration; value += step) {
    const tickX = mapX(value);
    context.beginPath();
    context.moveTo(tickX, y + height);
    context.lineTo(tickX, y + height + 6);
    context.stroke();
    context.fillText(String(Math.round(value)), tickX, y + height + 10);
  }

  context.save();
  context.translate(x - 62, y + height / 2);
  context.rotate(-Math.PI / 2);
  context.fillStyle = "#202020";
  context.font = "19px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("env", 0, 0);
  context.restore();
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText("t", x + width / 2, y + height + 40);

  const legendX = x + width + 26;
  const legendY = y + height / 2 - 42;
  context.fillStyle = "#202020";
  context.font = "17px Arial, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText("class", legendX, legendY);
  context.fillStyle = "#472d7b";
  context.fillRect(legendX, legendY + 22, 24, 19);
  context.fillStyle = "#202020";
  context.fillText("N", legendX + 37, legendY + 31.5);
  context.fillStyle = "#28ae80";
  context.fillRect(legendX, legendY + 57, 24, 19);
  context.fillStyle = "#202020";
  context.fillText("P", legendX + 37, legendY + 66.5);
}

function drawSpectrogramPanel(context, candidate, x, y, width, height) {
  const spectrum = candidate.spectrogram;
  if (!spectrum || spectrum.matrix.length === 0 || spectrum.frequencyAxisHz.length === 0) return;

  context.fillStyle = "#ffffff";
  context.fillRect(x, y, width, height);
  const columns = spectrum.matrix.length;
  const rows = spectrum.frequencyAxisHz.length;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const scale = spectrum.maxDb > 0 ? spectrum.maxDb : 1;
  for (let column = 0; column < columns; column += 1) {
    const frame = spectrum.matrix[column];
    for (let row = 0; row < rows; row += 1) {
      context.fillStyle = colorFor(frame[row] / scale);
      context.fillRect(
        x + column * cellWidth,
        y + height - (row + 1) * cellHeight,
        Math.ceil(cellWidth + 0.5),
        Math.ceil(cellHeight + 0.5),
      );
    }
  }
  context.strokeStyle = "#111111";
  context.lineWidth = 1.25;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x, y + height);
  context.lineTo(x + width, y + height);
  context.stroke();
}

function drawSpectrogramFacets(context, candidates) {
  const columns = Math.ceil(Math.sqrt(candidates.length));
  const rows = Math.ceil(candidates.length / columns);
  const areaX = 65;
  const areaY = 620;
  const areaWidth = 1072;
  const areaHeight = 550;
  const columnGap = 14;
  const rowGap = 18;
  const facetWidth = (areaWidth - columnGap * (columns - 1)) / columns;
  const facetHeight = (areaHeight - rowGap * (rows - 1)) / rows;

  candidates.forEach((candidate, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const facetX = areaX + column * (facetWidth + columnGap);
    const facetY = areaY + row * (facetHeight + rowGap);
    context.fillStyle = "#202020";
    context.font = "17px Arial, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(String(index + 1), facetX - (column === 0 ? 44 : 0), facetY);
    drawSpectrogramPanel(context, candidate, facetX, facetY + 34, facetWidth, facetHeight - 34);
  });
}

export function renderAnalysisCanvas(canvas, result, candidateId, options = {}) {
  const hasVisualCandidates = result.candidates.length > 0;
  const width = options.width ?? 1200;
  const referenceHeight = hasVisualCandidates ? 1200 : 600;
  const height = width * (referenceHeight / 1200);
  const pixelRatio = options.pixelRatio ?? 1;
  const coordinateScale = width / 1200;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  canvas.dataset.layout = hasVisualCandidates ? "square" : "wide";
  canvas.style.removeProperty("aspect-ratio");
  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio * coordinateScale, 0, 0, pixelRatio * coordinateScale, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1200, referenceHeight);
  drawOverview(context, result, 86, 12, 1018, 522);
  if (hasVisualCandidates) drawSpectrogramFacets(context, result.candidates);
  return canvas;
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成 PNG 图像")), "image/png");
  });
}

export async function createAnalysisImageBlob(result, candidateId = result.candidates[0]?.candidate_id) {
  const canvas = document.createElement("canvas");
  renderAnalysisCanvas(canvas, result, candidateId, { width: 1200, pixelRatio: 2 });
  return canvasToPngBlob(canvas);
}
