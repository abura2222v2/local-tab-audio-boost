(() => {
  'use strict';

  const player = document.getElementById('player');
  const panel = document.getElementById('test-panel');
  const status = document.getElementById('status');
  const currentAddress = document.getElementById('current-address');
  let currentObjectUrl = null;
  let delayedSourceTimer = null;

  function writeAscii(view, offset, text) {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }

  function createToneObjectUrl() {
    const sampleRate = 44_100;
    const durationSeconds = 2;
    const sampleCount = sampleRate * durationSeconds;
    const bytesPerSample = 2;
    const dataBytes = sampleCount * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const fade = Math.min(1, sample / 500, (sampleCount - sample) / 500);
      const value = Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 0.2 * fade;
      view.setInt16(44 + sample * bytesPerSample, Math.round(value * 32767), true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function installSource() {
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = createToneObjectUrl();
    player.src = currentObjectUrl;
    player.load();
    status.textContent = 'The local tone is ready. Press Play in the audio controls.';
  }

  function updateAddress() {
    currentAddress.textContent = window.location.href;
  }

  document.getElementById('source-now').addEventListener('click', () => {
    if (delayedSourceTimer !== null) clearTimeout(delayedSourceTimer);
    delayedSourceTimer = null;
    installSource();
  });

  document.getElementById('source-later').addEventListener('click', () => {
    if (delayedSourceTimer !== null) clearTimeout(delayedSourceTimer);
    status.textContent = 'Waiting 2 seconds before assigning the audio source...';
    delayedSourceTimer = setTimeout(() => {
      delayedSourceTimer = null;
      installSource();
    }, 2000);
  });

  for (const button of document.querySelectorAll('[data-route]')) {
    button.addEventListener('click', () => {
      history.pushState({}, '', button.dataset.route);
      updateAddress();
      status.textContent = `Same-document navigation completed: ${button.dataset.route}`;
    });
  }

  document.getElementById('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await panel.requestFullscreen();
    } catch (error) {
      status.textContent = `Fullscreen failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  window.addEventListener('popstate', updateAddress);
  window.addEventListener('pagehide', () => {
    if (delayedSourceTimer !== null) clearTimeout(delayedSourceTimer);
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  });
  updateAddress();
})();
