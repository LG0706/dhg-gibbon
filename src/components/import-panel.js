export function recordingKey(fileLike) {
  return `${fileLike.name}\u0000${fileLike.size}\u0000${fileLike.lastModified}`;
}

export function createImportPanel({ existingKeys, onFilesAdded, onDuplicate }) {
  const section = document.createElement("section");
  section.className = "import-panel";
  section.setAttribute("aria-labelledby", "import-heading");
  section.innerHTML = `
    <div class="section-heading">
      <div>
        <h2 id="import-heading">导入录音</h2>
        <p>支持未压缩 RIFF/WAVE。文件只在当前浏览器中读取。</p>
      </div>
    </div>
    <div class="drop-zone" data-role="drop-zone">
      <input class="sr-only" data-role="files" id="wav-files" type="file" accept=".wav,audio/wav" multiple />
      <p><strong>拖放 WAV 录音到这里</strong></p>
      <p>也可以从电脑中选择多个文件。之后添加的录音会继续排在当前队列末尾。</p>
      <button class="secondary-button" data-role="choose" type="button">选择录音</button>
    </div>
    <p class="inline-notice" data-role="notice" aria-live="polite"></p>`;

  const fileInput = section.querySelector('[data-role="files"]');
  const dropZone = section.querySelector('[data-role="drop-zone"]');
  const notice = section.querySelector('[data-role="notice"]');

  function addFiles(fileList) {
    const added = [];
    const duplicates = [];
    for (const file of fileList) {
      const key = recordingKey(file);
      if (existingKeys.has(key) || added.some((item) => item.key === key)) {
        duplicates.push(file.name);
        onDuplicate?.(file, key);
      } else {
        existingKeys.add(key);
        added.push({ file, key });
      }
    }
    if (added.length > 0) onFilesAdded(added);
    notice.textContent = duplicates.length > 0
      ? `${duplicates.join("、")} 已存在，未重复加入。`
      : added.length > 0 ? `已加入 ${added.length} 个录音。` : "";
    fileInput.value = "";
  }

  section.querySelector('[data-role="choose"]').addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => addFiles(fileInput.files));
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    addFiles(event.dataTransfer.files);
  });

  return { element: section, addFiles, notice };
}
