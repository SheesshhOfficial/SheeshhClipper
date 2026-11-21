'use strict';

// The drop zone is optional; the ordinary file picker remains keyboard-accessible.
function attachLocalFileDrop(zone, importFile, reportError) {
  function isFileDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }
  zone.addEventListener('dragover', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', event => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    zone.classList.remove('drag-over');
    const files = event.dataTransfer.files;
    if (files.length !== 1 || !/\.mp4$/i.test(files[0].name)) {
      reportError('Drop one MP4 video at a time.');
      return;
    }
    importFile(files[0]);
  });
}
