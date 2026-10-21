// Runs inside PhotoCraft's page, before the editor starts.
// The voice app sends a picture here. This file hands that picture to PhotoCraft
// (a drop, or the next File › Open) and sends a saved picture back.
(function () {
  let pending = null;

  function fileFrom(message) {
    const bytes = message.bytes;
    if (!bytes) return null;
    const blob = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const name = message.name || "photo.jpg";
    const mime = message.mime || "image/jpeg";
    return new File([blob], name, { type: mime });
  }

  // A drop away from the canvas opens the picture. A drop on the canvas would
  // place it on a document that may not exist yet.
  function tryDrop() {
    if (!pending) return false;
    const target = document.body || document.documentElement;
    if (!target || typeof DataTransfer !== "function") return false;
    try {
      const data = new DataTransfer();
      data.items.add(pending);
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  // File › Open builds a file button and clicks it. Give it this picture instead
  // of opening the Mac's file window.
  function supply(input) {
    if (!pending || input.type !== "file" || typeof DataTransfer !== "function") return false;
    try {
      const data = new DataTransfer();
      data.items.add(pending);
      input.files = data.files;
      // Keep the picture, so a later File › Open still receives it.
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (err) {
      return false;
    }
  }

  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (supply(this)) return;
    return origClick.apply(this, arguments);
  };
  if (typeof HTMLInputElement.prototype.showPicker === "function") {
    const origShow = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      if (supply(this)) return Promise.resolve();
      return origShow.apply(this, arguments);
    };
  }

  // PhotoCraft's Save downloads the file. Also tell the voice app, so the chat matches.
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const name = this.download || "";
    const href = this.href || "";
    if (name && href.startsWith("blob:") && window.parent && window.parent !== window) {
      const anchor = this;
      fetch(href)
        .then((response) => response.arrayBuffer())
        .then((bytes) => {
          window.parent.postMessage({ type: "photo-saved", name: anchor.download, bytes: bytes }, location.origin);
        })
        .catch(() => {});
    }
    return origAnchorClick.apply(this, arguments);
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (!event.data || event.data.type !== "open-photo") return;
    const file = fileFrom(event.data);
    if (!file) return;
    pending = file;
    tryDrop();
  });

  window.addEventListener("TrunkApplicationStarted", () => {
    setTimeout(tryDrop, 300);
  });
})();
