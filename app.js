"use strict";

const TOP_CANVAS_SIZE = { width: 3108, height: 1350 };
const FONT_PIXEL_SIZE = Math.round(10 * 300 / 72);
const TOP_CROPS = [
  { name: "01_top_left", x: 0, y: 0, width: 1080, height: 1350 },
  { name: "02_top_center", x: 1014, y: 0, width: 1080, height: 1350 },
  { name: "03_top_right", x: 2028, y: 0, width: 1080, height: 1350 },
];
const SQUARE_CROP = { name: "square_1350", x: 879, y: 0, width: 1350, height: 1350 };
const BOTTOM_PLACEMENTS = [
  { name: "04_bottom_a", key: "imageA", centerX: 540, centerY: 675, crop: TOP_CROPS[0] },
  { name: "05_bottom_b", key: "imageB", centerX: 1554, centerY: 675, crop: TOP_CROPS[1] },
  { name: "06_bottom_c", key: "imageC", centerX: 2574, centerY: 675, crop: TOP_CROPS[2] },
];
const FONT_FAMILY_REGULAR = "NanumGothicFeed";
const FONT_FAMILY_BOLD = "NanumGothicFeedBold";
const DEFAULT_BACKGROUND_FOCUS = { x: 0.5, y: 0.5 };
const LIVE_UPDATE_DELAY_MS = 120;

const elements = {
  form: document.querySelector("#generator-form"),
  backgroundInput: document.querySelector("#background"),
  backgroundEditor: document.querySelector("#background-editor"),
  resetBackgroundButton: document.querySelector("#reset-background-button"),
  status: document.querySelector("#status"),
  results: document.querySelector("#results"),
  outputCount: document.querySelector("#output-count"),
  generateButton: document.querySelector("#generate-button"),
  downloadButton: document.querySelector("#download-button"),
};

const state = {
  guide: null,
  logo: null,
  inputImages: null,
  options: null,
  editorBackgroundImage: null,
  backgroundFocus: { ...DEFAULT_BACKGROUND_FOCUS },
  dragState: null,
  isGenerating: false,
  pendingLiveUpdate: null,
  liveUpdateTimer: 0,
  outputs: [],
  zipFilename: "instagram-feed-images.zip",
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  renderEmptyState();
  renderBackgroundEditor();
  elements.form.addEventListener("submit", handleGenerate);
  elements.form.addEventListener("input", handleFormEdit);
  elements.form.addEventListener("change", handleFormEdit);
  elements.backgroundInput.addEventListener("change", handleBackgroundInputChange);
  elements.backgroundEditor.addEventListener("pointerdown", handleBackgroundPointerDown);
  elements.backgroundEditor.addEventListener("pointermove", handleBackgroundPointerMove);
  elements.backgroundEditor.addEventListener("pointerup", handleBackgroundPointerEnd);
  elements.backgroundEditor.addEventListener("pointercancel", handleBackgroundPointerEnd);
  elements.resetBackgroundButton.addEventListener("click", resetBackgroundPosition);
  elements.downloadButton.addEventListener("click", handleDownloadZip);
  window.addEventListener("resize", renderBackgroundEditor);

  try {
    setStatus("Loading assets");
    const [guide, logo] = await Promise.all([
      fetchJson("assets/guide_settings.json"),
      loadImage("assets/logo.png"),
      loadFonts(),
    ]);
    state.guide = guide;
    state.logo = logo;
    document.querySelector("#blur").value = String(guide.background_blur_radius);
    renderBackgroundEditor();
    setStatus("Ready", "success");
  } catch (error) {
    setStatus(error.message || "Failed to load assets", "error");
    elements.generateButton.disabled = true;
  }
}

async function handleGenerate(event) {
  event.preventDefault();
  await regenerateOutputs({ clearBeforeGenerate: true, reloadImages: true });
}

async function regenerateOutputs({ clearBeforeGenerate, reloadImages }) {
  if (state.isGenerating) {
    state.pendingLiveUpdate = {
      reloadImages: Boolean(state.pendingLiveUpdate?.reloadImages || reloadImages),
    };
    return;
  }

  if (clearBeforeGenerate) {
    clearOutputs();
  }

  state.isGenerating = true;
  setBusy(true);
  try {
    const options = collectOptions();
    validateOptions(options);
    state.zipFilename = makeZipFilename(options.location, options.date);

    const images = await getInputImages({ reloadImages });

    setStatus("Generating");
    const nextOutputs = await generateFeed(images, options);
    replaceOutputs(nextOutputs);
    state.options = options;
    setStatus(`${state.outputs.length} files generated`, "success");
  } catch (error) {
    if (clearBeforeGenerate || !state.outputs.length) {
      renderEmptyState();
    }
    setStatus(error.message || "Generation failed", "error");
  } finally {
    state.isGenerating = false;
    setBusy(false);
    flushPendingLiveUpdate();
  }
}

async function generateFeed(images, options) {
  const guide = normalizeGuide(state.guide);
  const extension = options.format === "png" ? "png" : "jpg";
  const mimeType = options.format === "png" ? "image/png" : "image/jpeg";
  const outputs = [];

  const topCanvas = createCanvas(TOP_CANVAS_SIZE.width, TOP_CANVAS_SIZE.height);
  const topContext = topCanvas.getContext("2d");
  topContext.fillStyle = "#ffffff";
  topContext.fillRect(0, 0, topCanvas.width, topCanvas.height);
  drawCoverImage(
    topContext,
    images.background,
    topCanvas.width,
    topCanvas.height,
    options.blurRadius,
    options.backgroundFocus,
  );
  drawLogo(topContext, guide);
  drawTopText(topContext, guide, options.location, options.date);

  if (options.saveTopCanvas) {
    outputs.push(await makeOutput(topCanvas, `00_top_canvas_3108x1350.${extension}`, mimeType, options.quality));
  }

  for (const crop of TOP_CROPS) {
    const canvas = cropCanvas(topCanvas, crop);
    outputs.push(await makeOutput(canvas, `${crop.name}.${extension}`, mimeType, options.quality));
  }

  const squareCanvas = cropCanvas(topCanvas, SQUARE_CROP);
  outputs.push(await makeOutput(squareCanvas, `${SQUARE_CROP.name}.${extension}`, mimeType, options.quality));

  const bottomCanvas = createCanvas(TOP_CANVAS_SIZE.width, TOP_CANVAS_SIZE.height);
  const bottomContext = bottomCanvas.getContext("2d");
  bottomContext.fillStyle = "#ffffff";
  bottomContext.fillRect(0, 0, bottomCanvas.width, bottomCanvas.height);
  drawBottomImages(bottomContext, images, guide);

  for (const placement of BOTTOM_PLACEMENTS) {
    const canvas = cropCanvas(bottomCanvas, placement.crop);
    outputs.push(await makeOutput(canvas, `${placement.name}.${extension}`, mimeType, options.quality));
  }

  return outputs;
}

function collectOptions() {
  const formData = new FormData(elements.form);
  return {
    location: String(formData.get("location") || ""),
    date: String(formData.get("date") || ""),
    format: formData.get("format"),
    quality: Number(formData.get("quality") || 95) / 100,
    blurRadius: Number(formData.get("blur") || state.guide.background_blur_radius),
    saveTopCanvas: formData.has("saveTopCanvas"),
    backgroundFocus: { ...state.backgroundFocus },
  };
}

async function getInputImages({ reloadImages }) {
  if (state.inputImages && !reloadImages) {
    return state.inputImages;
  }

  setStatus("Loading images");
  const formData = new FormData(elements.form);
  const images = {
    background: await loadUploadImage(formData.get("background"), "Background"),
    imageA: await loadUploadImage(formData.get("imageA"), "Image A"),
    imageB: await loadUploadImage(formData.get("imageB"), "Image B"),
    imageC: await loadUploadImage(formData.get("imageC"), "Image C"),
  };
  state.inputImages = images;
  state.editorBackgroundImage = images.background;
  elements.resetBackgroundButton.disabled = false;
  renderBackgroundEditor();
  return images;
}

function drawCoverImage(context, image, targetWidth, targetHeight, blurRadius, focus = DEFAULT_BACKGROUND_FOCUS) {
  const metrics = getCoverMetrics(image, targetWidth, targetHeight, focus);
  const blur = Math.max(0, Number(blurRadius) || 0);
  const pad = Math.ceil(blur * 4);

  context.save();
  if (blur > 0) {
    context.filter = `blur(${blur}px)`;
  }
  context.drawImage(
    image,
    metrics.drawX - pad,
    metrics.drawY - pad,
    metrics.drawWidth + pad * 2,
    metrics.drawHeight + pad * 2,
  );
  context.restore();
}

function getCoverMetrics(image, targetWidth, targetHeight, focus = DEFAULT_BACKGROUND_FOCUS) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  return {
    drawWidth,
    drawHeight,
    drawX: (targetWidth - drawWidth) * clamp(focus.x, 0, 1),
    drawY: (targetHeight - drawHeight) * clamp(focus.y, 0, 1),
  };
}

async function handleBackgroundInputChange() {
  state.inputImages = null;
  state.backgroundFocus = { ...DEFAULT_BACKGROUND_FOCUS };
  elements.resetBackgroundButton.disabled = true;

  const file = elements.backgroundInput.files?.[0];
  if (!file) {
    state.editorBackgroundImage = null;
    renderBackgroundEditor();
    return;
  }

  try {
    state.editorBackgroundImage = await loadUploadImage(file, "Background");
    elements.resetBackgroundButton.disabled = false;
    renderBackgroundEditor();
    scheduleLiveRegenerate({ reloadImages: true });
  } catch (error) {
    state.editorBackgroundImage = null;
    renderBackgroundEditor();
    setStatus(error.message || "Could not load background", "error");
  }
}

function handleFormEdit(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target === elements.backgroundInput) {
    return;
  }

  const reloadImages = target.matches("input[type='file']");
  if (reloadImages) {
    state.inputImages = null;
  }

  renderBackgroundEditor();
  scheduleLiveRegenerate({ reloadImages });
}

function handleBackgroundPointerDown(event) {
  if (!state.editorBackgroundImage) {
    return;
  }

  elements.backgroundEditor.setPointerCapture(event.pointerId);
  elements.backgroundEditor.classList.add("is-dragging");
  state.dragState = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  };
}

function handleBackgroundPointerMove(event) {
  if (!state.dragState || state.dragState.pointerId !== event.pointerId || !state.editorBackgroundImage) {
    return;
  }

  const rect = elements.backgroundEditor.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  const deltaX = (event.clientX - state.dragState.lastX) * TOP_CANVAS_SIZE.width / rect.width;
  const deltaY = (event.clientY - state.dragState.lastY) * TOP_CANVAS_SIZE.height / rect.height;
  state.dragState.lastX = event.clientX;
  state.dragState.lastY = event.clientY;

  moveBackgroundBy(deltaX, deltaY);
  renderBackgroundEditor();
  scheduleLiveRegenerate({ reloadImages: false });
}

function handleBackgroundPointerEnd(event) {
  if (state.dragState?.pointerId !== event.pointerId) {
    return;
  }

  elements.backgroundEditor.classList.remove("is-dragging");
  state.dragState = null;
}

function resetBackgroundPosition() {
  state.backgroundFocus = { ...DEFAULT_BACKGROUND_FOCUS };
  renderBackgroundEditor();
  scheduleLiveRegenerate({ reloadImages: false });
}

function moveBackgroundBy(deltaX, deltaY) {
  const metrics = getCoverMetrics(
    state.editorBackgroundImage,
    TOP_CANVAS_SIZE.width,
    TOP_CANVAS_SIZE.height,
    state.backgroundFocus,
  );
  const rangeX = TOP_CANVAS_SIZE.width - metrics.drawWidth;
  const rangeY = TOP_CANVAS_SIZE.height - metrics.drawHeight;

  if (rangeX !== 0) {
    state.backgroundFocus.x = clamp(state.backgroundFocus.x + deltaX / rangeX, 0, 1);
  }
  if (rangeY !== 0) {
    state.backgroundFocus.y = clamp(state.backgroundFocus.y + deltaY / rangeY, 0, 1);
  }
}

function renderBackgroundEditor() {
  const canvas = elements.backgroundEditor;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width || canvas.clientWidth || 920));
  const cssHeight = Math.round(cssWidth * TOP_CANVAS_SIZE.height / TOP_CANVAS_SIZE.width);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssWidth * pixelRatio);
  canvas.height = Math.round(cssHeight * pixelRatio);

  const context = canvas.getContext("2d");
  context.setTransform(canvas.width / TOP_CANVAS_SIZE.width, 0, 0, canvas.height / TOP_CANVAS_SIZE.height, 0, 0);
  context.clearRect(0, 0, TOP_CANVAS_SIZE.width, TOP_CANVAS_SIZE.height);
  context.fillStyle = "#eef0f4";
  context.fillRect(0, 0, TOP_CANVAS_SIZE.width, TOP_CANVAS_SIZE.height);

  canvas.classList.toggle("is-empty", !state.editorBackgroundImage);
  if (!state.editorBackgroundImage) {
    return;
  }

  const guide = state.guide ? normalizeGuide(state.guide) : null;
  const blurInput = document.querySelector("#blur");
  const locationInput = document.querySelector("#location");
  const dateInput = document.querySelector("#date");
  const blurRadius = Number(blurInput?.value || guide?.backgroundBlurRadius || 0);

  drawCoverImage(
    context,
    state.editorBackgroundImage,
    TOP_CANVAS_SIZE.width,
    TOP_CANVAS_SIZE.height,
    blurRadius,
    state.backgroundFocus,
  );

  if (guide && state.logo) {
    drawLogo(context, guide);
    drawTopText(
      context,
      guide,
      locationInput?.value || "",
      dateInput?.value || "",
    );
  }
  drawEditorGuides(context);
}

function drawEditorGuides(context) {
  context.save();
  context.lineWidth = 4;
  context.strokeStyle = "rgba(255, 255, 255, .86)";
  context.setLineDash([]);
  for (const crop of TOP_CROPS) {
    context.strokeRect(crop.x + 2, crop.y + 2, crop.width - 4, crop.height - 4);
  }
  context.strokeStyle = "rgba(23, 105, 224, .86)";
  context.setLineDash([18, 14]);
  context.strokeRect(SQUARE_CROP.x + 2, SQUARE_CROP.y + 2, SQUARE_CROP.width - 4, SQUARE_CROP.height - 4);
  context.restore();
}

function drawLogo(context, guide) {
  const [left, top, right, bottom] = guide.logoBox;
  drawImageWithShadow(
    context,
    state.logo,
    left,
    top,
    right - left,
    bottom - top,
    guide.logoShadow,
  );
}

function drawTopText(context, guide, location, date) {
  context.fillStyle = "#ffffff";
  context.textBaseline = "alphabetic";

  const locationText = String(location || "").trim().replace(/^-+|-+$/g, "").trim();
  if (locationText) {
    drawCenteredSegments(context, [
      { text: "- ", family: FONT_FAMILY_REGULAR },
      { text: locationText, family: FONT_FAMILY_BOLD },
      { text: " -", family: FONT_FAMILY_REGULAR },
    ], guide.locationCenter[0], guide.locationCenter[1]);
  }

  const dateText = String(date || "").trim();
  if (dateText) {
    drawCenteredText(context, dateText, guide.dateCenter[0], guide.dateCenter[1], FONT_FAMILY_BOLD);
  }
}

function drawBottomImages(context, images, guide) {
  for (const placement of BOTTOM_PLACEMENTS) {
    const image = images[placement.key];
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, guide.photosMaxSide / Math.max(sourceWidth, sourceHeight));
    const drawWidth = Math.round(sourceWidth * scale);
    const drawHeight = Math.round(sourceHeight * scale);
    const drawX = Math.round(placement.centerX - drawWidth / 2);
    const drawY = Math.round(placement.centerY - drawHeight / 2);
    drawImageWithShadow(context, image, drawX, drawY, drawWidth, drawHeight, guide.imageShadow);
  }
}

function drawImageWithShadow(context, image, x, y, width, height, shadow) {
  context.save();
  if (shadow) {
    const [red, green, blue] = shadow.color;
    const [offsetX, offsetY] = shadowOffset(shadow);
    context.shadowColor = `rgba(${red}, ${green}, ${blue}, ${shadow.opacity})`;
    context.shadowBlur = shadow.size / 2.35;
    context.shadowOffsetX = offsetX;
    context.shadowOffsetY = offsetY;
  }
  context.drawImage(image, x, y, width, height);
  context.restore();
}

function drawCenteredText(context, text, centerX, centerY, family) {
  setCanvasFont(context, family);
  const metrics = context.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent || FONT_PIXEL_SIZE * .78;
  const descent = metrics.actualBoundingBoxDescent || FONT_PIXEL_SIZE * .22;
  const x = centerX - metrics.width / 2;
  const y = centerY + (ascent - descent) / 2;
  context.fillText(text, x, y);
}

function drawCenteredSegments(context, segments, centerX, centerY) {
  const measured = [];
  let totalWidth = 0;
  let maxAscent = 0;
  let maxDescent = 0;

  for (const segment of segments) {
    if (!segment.text) {
      continue;
    }
    setCanvasFont(context, segment.family);
    const metrics = context.measureText(segment.text);
    const ascent = metrics.actualBoundingBoxAscent || FONT_PIXEL_SIZE * .78;
    const descent = metrics.actualBoundingBoxDescent || FONT_PIXEL_SIZE * .22;
    measured.push({ ...segment, width: metrics.width });
    totalWidth += metrics.width;
    maxAscent = Math.max(maxAscent, ascent);
    maxDescent = Math.max(maxDescent, descent);
  }

  let x = centerX - totalWidth / 2;
  const y = centerY + (maxAscent - maxDescent) / 2;
  for (const segment of measured) {
    setCanvasFont(context, segment.family);
    context.fillText(segment.text, x, y);
    x += segment.width;
  }
}

function cropCanvas(sourceCanvas, crop) {
  const canvas = createCanvas(crop.width, crop.height);
  const context = canvas.getContext("2d");
  context.drawImage(
    sourceCanvas,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  return canvas;
}

async function makeOutput(canvas, filename, mimeType, quality) {
  const blob = await canvasToBlob(canvas, mimeType, quality);
  return {
    filename,
    blob,
    url: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
  };
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not encode canvas"));
      }
    }, mimeType, quality);
  });
}

function setCanvasFont(context, family) {
  context.font = `${FONT_PIXEL_SIZE}px "${family}", "Nanum Gothic", sans-serif`;
}

function shadowOffset(settings) {
  const radians = settings.angle * Math.PI / 180;
  return [
    -Math.cos(radians) * settings.distance,
    Math.sin(radians) * settings.distance,
  ];
}

function normalizeGuide(rawGuide) {
  return {
    backgroundBlurRadius: Number(rawGuide.background_blur_radius),
    imageShadow: normalizeShadow(rawGuide.image_shadow),
    logoShadow: rawGuide.logo_shadow ? normalizeShadow(rawGuide.logo_shadow) : null,
    logoBox: rawGuide.logo_box.map(Number),
    locationCenter: rawGuide.location_center.map(Number),
    dateCenter: rawGuide.date_center.map(Number),
    photosMaxSide: Number(rawGuide.photos_max_side),
  };
}

function normalizeShadow(rawShadow) {
  return {
    opacity: Number(rawShadow.opacity),
    angle: Number(rawShadow.angle),
    distance: Number(rawShadow.distance),
    size: Number(rawShadow.size),
    choke: Number(rawShadow.choke),
    color: rawShadow.color.map(Number),
  };
}

function validateOptions(options) {
  if (!state.guide || !state.logo) {
    throw new Error("Assets are not ready");
  }
  if (!["jpg", "png"].includes(options.format)) {
    throw new Error("Unsupported output format");
  }
  if (!Number.isFinite(options.blurRadius) || options.blurRadius < 0) {
    throw new Error("Background blur must be zero or greater");
  }
  if (!Number.isFinite(options.quality) || options.quality < .7 || options.quality > 1) {
    throw new Error("JPG quality is out of range");
  }
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function loadUploadImage(value, label) {
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} file is required`);
  }
  if (value.type && !value.type.startsWith("image/")) {
    throw new Error(`${label} must be a browser-readable image`);
  }

  const url = URL.createObjectURL(value);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${src}`));
    image.src = src;
  });
}

async function loadFonts() {
  if (!("FontFace" in window)) {
    return;
  }

  const regular = new FontFace(FONT_FAMILY_REGULAR, "url('fonts/NanumGothic.otf')");
  const bold = new FontFace(FONT_FAMILY_BOLD, "url('fonts/NanumGothicBold.otf')");
  await Promise.all([regular.load(), bold.load()]);
  document.fonts.add(regular);
  document.fonts.add(bold);
  await document.fonts.ready;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}`);
  }
  return response.json();
}

async function handleDownloadZip() {
  if (!state.outputs.length) {
    return;
  }
  elements.downloadButton.disabled = true;
  setStatus("Preparing ZIP");
  try {
    const zipBlob = await createZip(state.outputs);
    downloadBlob(zipBlob, state.zipFilename);
    setStatus("ZIP ready", "success");
  } catch (error) {
    setStatus(error.message || "Could not create ZIP", "error");
  } finally {
    elements.downloadButton.disabled = false;
  }
}

async function createZip(outputs) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const records = [];
  let offset = 0;

  for (const output of outputs) {
    const nameBytes = encoder.encode(output.filename);
    const data = new Uint8Array(await output.blob.arrayBuffer());
    const crc = crc32(data);
    const localHeader = makeLocalHeader(nameBytes, data, crc);
    localParts.push(localHeader, data);
    records.push({ nameBytes, data, crc, offset });
    offset += localHeader.byteLength + data.byteLength;
  }

  let centralSize = 0;
  for (const record of records) {
    const centralHeader = makeCentralHeader(record.nameBytes, record.data, record.crc, record.offset);
    centralParts.push(centralHeader);
    centralSize += centralHeader.byteLength;
  }

  const endHeader = makeEndOfCentralDirectory(records.length, centralSize, offset);
  return new Blob([...localParts, ...centralParts, endHeader], { type: "application/zip" });
}

function makeLocalHeader(nameBytes, data, crc) {
  const header = new ArrayBuffer(30 + nameBytes.length);
  const view = new DataView(header);
  const { dosTime, dosDate } = getDosTimestamp();
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 10, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, data.byteLength, true);
  view.setUint32(22, data.byteLength, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  new Uint8Array(header, 30).set(nameBytes);
  return new Uint8Array(header);
}

function makeCentralHeader(nameBytes, data, crc, localOffset) {
  const header = new ArrayBuffer(46 + nameBytes.length);
  const view = new DataView(header);
  const { dosTime, dosDate } = getDosTimestamp();
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 10, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, data.byteLength, true);
  view.setUint32(24, data.byteLength, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  new Uint8Array(header, 46).set(nameBytes);
  return new Uint8Array(header);
}

function makeEndOfCentralDirectory(fileCount, centralSize, centralOffset) {
  const header = new ArrayBuffer(22);
  const view = new DataView(header);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, fileCount, true);
  view.setUint16(10, fileCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return new Uint8Array(header);
}

function getDosTimestamp() {
  const date = new Date();
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(data) {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function scheduleLiveRegenerate({ reloadImages }) {
  if (!state.outputs.length) {
    return;
  }

  window.clearTimeout(state.liveUpdateTimer);
  state.liveUpdateTimer = window.setTimeout(() => {
    regenerateOutputs({ clearBeforeGenerate: false, reloadImages });
  }, LIVE_UPDATE_DELAY_MS);
}

function flushPendingLiveUpdate() {
  if (!state.pendingLiveUpdate) {
    return;
  }

  const pending = state.pendingLiveUpdate;
  state.pendingLiveUpdate = null;
  scheduleLiveRegenerate({ reloadImages: pending.reloadImages });
}

function replaceOutputs(outputs) {
  revokeOutputUrls(state.outputs);
  state.outputs = outputs;
  renderOutputs(state.outputs);
}

function renderOutputs(outputs) {
  elements.results.textContent = "";
  const fragment = document.createDocumentFragment();
  const feedOutputs = outputs.filter((output) => /^0[1-6]_/.test(output.filename));
  const squareOutputs = outputs.filter((output) => output.filename.startsWith("square_1350."));
  const extraOutputs = outputs.filter((output) => (
    !feedOutputs.includes(output) && !squareOutputs.includes(output)
  ));

  if (feedOutputs.length) {
    fragment.append(createOutputSection("Instagram Feed", formatFileCount(feedOutputs.length), feedOutputs, "feed-grid"));
  }
  if (squareOutputs.length) {
    fragment.append(createOutputSection("Square Image", formatFileCount(squareOutputs.length), squareOutputs, "single-grid"));
  }
  if (extraOutputs.length) {
    fragment.append(createOutputSection("Extra", formatFileCount(extraOutputs.length), extraOutputs, "extra-grid"));
  }

  elements.results.append(fragment);
  elements.outputCount.textContent = formatFileCount(outputs.length);
  elements.downloadButton.disabled = outputs.length === 0;
}

function createOutputSection(title, count, outputs, gridClassName) {
  const section = document.createElement("section");
  section.className = "output-section";

  const head = document.createElement("div");
  head.className = "section-head";

  const heading = document.createElement("h3");
  heading.textContent = title;

  const countText = document.createElement("span");
  countText.textContent = count;

  const grid = document.createElement("div");
  grid.className = `output-grid ${gridClassName}`;

  for (const output of outputs) {
    grid.append(createOutputItem(output));
  }

  head.append(heading, countText);
  section.append(head, grid);
  return section;
}

function createOutputItem(output) {
  const figure = document.createElement("figure");
  figure.className = `output-item${output.width === output.height ? " square" : ""}`;
  figure.style.setProperty("--preview-ratio", `${output.width} / ${output.height}`);

  const image = document.createElement("img");
  image.src = output.url;
  image.alt = output.filename;
  image.width = output.width;
  image.height = output.height;

  const meta = document.createElement("figcaption");
  meta.className = "output-meta";

  const name = document.createElement("strong");
  name.textContent = output.filename;

  const link = document.createElement("a");
  link.href = output.url;
  link.download = output.filename;
  link.textContent = "Download";

  meta.append(name, link);
  figure.append(image, meta);
  return figure;
}

function renderEmptyState() {
  elements.results.textContent = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "No output";
  elements.results.append(empty);
  elements.outputCount.textContent = formatFileCount(0);
  elements.downloadButton.disabled = true;
}

function clearOutputs() {
  revokeOutputUrls(state.outputs);
  state.outputs = [];
  renderEmptyState();
}

function revokeOutputUrls(outputs) {
  for (const output of outputs) {
    URL.revokeObjectURL(output.url);
  }
}

function setBusy(isBusy) {
  elements.generateButton.disabled = isBusy;
  elements.downloadButton.disabled = isBusy || state.outputs.length === 0;
}

function setStatus(message, tone) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", tone === "error");
  elements.status.classList.toggle("is-success", tone === "success");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeZipFilename(location, date) {
  const parts = [location, date]
    .map((part) => sanitizeFilenamePart(part))
    .filter(Boolean);
  const baseName = parts.length ? parts.join("_") : "instagram-feed-images";
  return `${baseName}.zip`;
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatFileCount(count) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
