/**
 * Photos and documents: the camera sheet, the iPhone camera, and attached files.
 * Part of the voice window; loaded after the files before it in voice.html (see voice.js).
 */

/** The photo to send with this question, or "" when the question is not about a picture. */
function photoForQuestion(question) {
  if (!latestShot) return "";
  const aboutPicture = /\b(photo|picture|image|slide|slides|screen|whiteboard|chart|figure|diagram)\b/i.test(question);
  const firstAsk = !latestShotSent && Date.now() - latestShotAt < 3 * 60 * 1000;
  if (!aboutPicture && !firstAsk) return "";
  latestShotSent = true;
  return latestShot;
}

/** Words for a camera that would not open. */
function cameraError(err) {
  const msg = `${err?.name || ""} ${err?.message || err || ""}`;
  if (/Permission|NotAllowed/i.test(msg)) return "Camera permission was denied. Allow the camera for this window, then press Photo again.";
  if (/NotFound|not found|DevicesNotFound/i.test(msg)) return "No camera was found. Unlock your iPhone, keep it nearby, then press Photo again.";
  return "The camera did not open. Unlock your iPhone and keep it nearby, then try again.";
}

/** Turn the camera light off and hide the preview. */
function stopPhotoCamera() {
  photoStream?.getTracks().forEach((track) => track.stop());
  photoStream = null;
  if (photoVideo) photoVideo.srcObject = null;
}

/** Cameras the browser can open. Skip Chrome's "default" copy of the Mac camera. */
function listCameras(devices) {
  return devices.filter((device) => (
    device.kind === "videoinput"
    && device.deviceId
    && device.deviceId !== "default"
    && device.deviceId !== "communications"
  ));
}

/**
 * The iPhone camera, when the phone is unlocked and nearby.
 * The name may be "iPhone Camera", or it may only share a group with the iPhone microphone.
 */
function phoneCamera(devices) {
  const cameras = listCameras(devices);
  const main = cameras.find((camera) => (
    /iphone|continuity/i.test(camera.label || "") && !/desk view/i.test(camera.label || "")
  ));
  if (main) return main;
  const phoneGroups = new Set(
    devices
      .filter((device) => device.kind === "audioinput" && /iphone/i.test(device.label || ""))
      .map((device) => device.groupId)
      .filter(Boolean),
  );
  const byGroup = cameras.find((camera) => camera.groupId && phoneGroups.has(camera.groupId) && !/desk view/i.test(camera.label || ""));
  if (byGroup) return byGroup;
  return cameras.find((camera) => /desk view/i.test(camera.label || "")) || null;
}

/** Ask for camera permission, then release it so the iPhone camera can appear. */
async function allowCameraNames() {
  const first = await navigator.mediaDevices.enumerateDevices();
  if (first.some((device) => device.kind === "videoinput" && device.label)) return first;
  const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  probe.getTracks().forEach((track) => track.stop());
  await sleep(500);
  return navigator.mediaDevices.enumerateDevices();
}

/** Put every camera in the menu. The iPhone is first. Returns that camera, or null. */
function fillCameraMenu(devices) {
  const cameras = listCameras(devices);
  const phone = phoneCamera(devices);
  const ordered = phone ? [phone, ...cameras.filter((camera) => camera.deviceId !== phone.deviceId)] : cameras;
  // Filling the menu can fire a change for the Mac camera. Ignore that.
  cameraSelect.dataset.quiet = "1";
  cameraSelect.replaceChildren();
  for (const camera of ordered) {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    const isPhone = phone && camera.deviceId === phone.deviceId;
    option.textContent = isPhone ? `iPhone (${camera.label || "Camera"})` : (camera.label || "This Mac");
    cameraSelect.append(option);
  }
  if (phone) cameraSelect.value = phone.deviceId;
  requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
  return phone;
}

/** Open one camera. An empty id uses whichever camera the Mac offers first. */
async function openPhotoCamera(deviceId) {
  stopPhotoCamera();
  const video = deviceId ? { deviceId: { exact: deviceId } } : true;
  try {
    photoStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    const msg = `${err?.name || ""} ${err?.message || ""}`;
    if (!deviceId || !/Overconstrained|NotFound|not found/i.test(msg)) throw err;
    photoStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { ideal: deviceId } },
      audio: false,
    });
  }
  photoVideo.srcObject = photoStream;
  await photoVideo.play();
}

/** A smaller JPEG of the current camera picture. */
function shotFromVideo(video) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return "";
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const pen = canvas.getContext("2d");
  if (!pen) return "";
  pen.drawImage(video, 0, 0, canvas.width, canvas.height);
  let quality = 0.72;
  let data = canvas.toDataURL("image/jpeg", quality);
  while (data.length > 1_200_000 && quality > 0.4) {
    quality -= 0.12;
    data = canvas.toDataURL("image/jpeg", quality);
  }
  return data.startsWith("data:image/jpeg") ? data : "";
}

/** Show the picture in the transcript. */
function addPhotoBubble(dataUrl, where) {
  clearEmptyHint();
  const bubble = document.createElement("article");
  bubble.className = `bubble photo ${where}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = where === "lecture" ? "Lecture" : where === "meeting" ? "Meeting" : "Photo";
  const img = document.createElement("img");
  img.className = "shot";
  img.alt = where === "lecture" ? "Photo added to the lecture" : where === "meeting" ? "Photo added to the meeting" : "Photo added to the talk";
  img.src = dataUrl;
  bubble.append(who, img);
  transcriptEl.appendChild(bubble);
  followTranscript();
}

/** Keep this picture with the meeting, the lecture, or the next question. */
function keepPhoto(dataUrl) {
  if (meetingOn) {
    if (capturePhotos.length >= 8) {
      setStatus("This already has 8 photos. Turn it off to save them before taking more.");
      return;
    }
    capturePhotos.push(dataUrl);
    meetingLines.push(`A photo was taken (${capturePhotos.length}).`);
    const where = captureKind === "lecture" ? "lecture" : "meeting";
    addPhotoBubble(dataUrl, where);
    setStatus(where === "lecture"
      ? "Photo added to the lecture. It will be saved with the talk."
      : "Photo added to the meeting. It will be saved with the minutes.");
    return;
  }
  latestShot = dataUrl;
  latestShotAt = Date.now();
  latestShotSent = false;
  addPhotoBubble(dataUrl, "talk");
  setStatus("Photo added. Ask what it shows.");
}

const photoCard = document.querySelector(".photo-card");

/** Show the preview and the Mac's Take photo button again. */
function showMacCamera() {
  photoCard?.classList.remove("phone-wait");
}

/** Close the camera window without keeping a picture. */
function closePhotoSheet() {
  photoEpoch += 1;
  photoSheet.hidden = true;
  photoBusy = false;
  showMacCamera();
  stopPhotoCamera();
  if (photoHint) photoHint.textContent = "Your iPhone is used when it is unlocked and nearby. Otherwise this Mac’s camera is used.";
}

/**
 * Ask the iPhone to open its camera. The shutter on the phone takes the picture.
 * If the phone is not nearby, the Mac camera preview opens instead.
 */
function askIphoneShutter() {
  if (photoBusy) return;
  photoBusy = true;
  photoError.hidden = true;
  photoError.textContent = "";
  stopPhotoCamera();
  photoCard?.classList.add("phone-wait");
  photoSheet.hidden = false;
  if (photoHint) photoHint.textContent = "On your iPhone, press the shutter button, then tap Use Photo.";
  setStatus("Look at your iPhone. Press the shutter, then tap Use Photo.");
  window.ipc.postMessage("iphone-photo");
}

/** The window app calls this with the picture from the iPhone. */
window.receivePhonePhoto = (dataUrl) => {
  if (!dataUrl || !String(dataUrl).startsWith("data:image/jpeg")) return;
  keepPhoto(dataUrl);
  closePhotoSheet();
};

/** The window app calls this when the iPhone camera is not available. */
window.phonePhotoUnavailable = () => {
  if (photoSheet.hidden) return;
  showMacCamera();
  photoBusy = false;
  startPhotoSheet();
};

/** The camera that is showing now. */
function currentCameraId() {
  return photoStream?.getVideoTracks()?.[0]?.getSettings()?.deviceId || "";
}

/**
 * Look for the iPhone camera without holding the Mac camera open.
 * The phone often appears a moment after the Mac camera is released.
 */
async function findPhoneCamera(epoch) {
  let devices = await allowCameraNames();
  if (epoch !== photoEpoch) return null;
  let phone = fillCameraMenu(devices);
  if (phone) return phone;
  if (photoHint) photoHint.textContent = "Looking for your iPhone… unlock it and keep it nearby.";
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && epoch === photoEpoch && !photoSheet.hidden) {
    await sleep(400);
    devices = await navigator.mediaDevices.enumerateDevices();
    phone = fillCameraMenu(devices);
    if (phone) return phone;
  }
  return null;
}

/** Switch the open preview to the iPhone when it connects. */
async function usePhoneIfPresent(epoch) {
  if (photoPickedByUser || epoch !== photoEpoch || photoSheet.hidden) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const phone = fillCameraMenu(devices);
  if (!phone || epoch !== photoEpoch || photoSheet.hidden) return;
  if (currentCameraId() === phone.deviceId) {
    cameraSelect.value = phone.deviceId;
    if (photoHint) photoHint.textContent = "Using your iPhone camera.";
    return;
  }
  await openPhotoCamera(phone.deviceId);
  if (epoch !== photoEpoch) {
    stopPhotoCamera();
    return;
  }
  cameraSelect.dataset.quiet = "1";
  cameraSelect.value = phone.deviceId;
  requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
  if (photoHint) photoHint.textContent = "Using your iPhone camera.";
  photoError.hidden = true;
  shutterBtn.disabled = false;
}

/** Open the camera, preferring the iPhone when it is nearby. */
async function startPhotoSheet() {
  if (photoBusy) return;
  photoBusy = true;
  photoPickedByUser = false;
  const epoch = photoEpoch;
  photoError.hidden = true;
  photoError.textContent = "";
  photoSheet.hidden = false;
  shutterBtn.disabled = true;
  cameraSelect.replaceChildren();
  if (photoHint) photoHint.textContent = "Looking for your iPhone… unlock it and keep it nearby.";
  try {
    const phone = await findPhoneCamera(epoch);
    if (epoch !== photoEpoch) return;
    if (phone) {
      await openPhotoCamera(phone.deviceId);
      if (epoch !== photoEpoch) {
        stopPhotoCamera();
        return;
      }
      cameraSelect.dataset.quiet = "1";
      cameraSelect.value = phone.deviceId;
      requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
      if (photoHint) photoHint.textContent = "Using your iPhone camera.";
    } else {
      const devices = await navigator.mediaDevices.enumerateDevices();
      fillCameraMenu(devices);
      const mac = listCameras(devices)[0];
      if (!mac) throw new Error("NotFoundError: No camera was found");
      await openPhotoCamera(mac.deviceId);
      if (epoch !== photoEpoch) {
        stopPhotoCamera();
        return;
      }
      cameraSelect.dataset.quiet = "1";
      cameraSelect.value = mac.deviceId;
      requestAnimationFrame(() => { cameraSelect.dataset.quiet = ""; });
      if (photoHint) photoHint.textContent = "The iPhone camera is not connected, so this is the Mac camera. Unlock the phone, keep it nearby, and it will switch over.";
    }
    shutterBtn.disabled = false;
  } catch (err) {
    if (epoch !== photoEpoch) return;
    console.error("Failed while opening the camera:", err);
    photoError.hidden = false;
    photoError.textContent = cameraError(err);
    stopPhotoCamera();
  }
}

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (photoSheet.hidden || !photoBusy) return;
  usePhoneIfPresent(photoEpoch).catch((err) => {
    console.error("Failed while switching to the iPhone camera:", err);
  });
});

documentBtn.addEventListener("click", () => documentFile.click());

/** Read an uploaded document; its summary joins the conversation so it can be asked about. */
documentFile.addEventListener("change", async () => {
  const file = documentFile.files?.[0];
  documentFile.value = "";
  if (!file) return;
  documentBtn.disabled = true;
  documentBtn.textContent = "Reading…";
  setStatus(`Reading ${file.name}. Long documents take a minute.`);
  try {
    const response = await fetch("/document", {
      method: "POST",
      headers: {
        // Raw bytes, so the server does not try to read a text file as a form.
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        "X-Model": chosenModelId || "",
      },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not read that document.");
    const said = `I read ${data.title}. ${data.summary}`;
    addBubble("assistant", `${said}\n\nA copy and a wiki page are in the meeting folder. Ask me anything about it.`);
    rememberTurn(`I uploaded the document "${file.name}". What is in it?`, said);
    setStatus("Document saved. Ask me about it.");
  } catch (err) {
    console.error("Failed while uploading a document:", err);
    setStatus(err.message);
  } finally {
    documentBtn.disabled = false;
    documentBtn.textContent = "Document";
  }
});

photoBtn.addEventListener("click", () => {
  // The Second Brain window can open the camera on the iPhone.
  // A browser tab cannot hear the phone's shutter, so it uses the preview instead.
  if (window.ipc?.postMessage) askIphoneShutter();
  else startPhotoSheet();
});

photoCancelBtn.addEventListener("click", closePhotoSheet);

photoSheet.addEventListener("click", (event) => {
  if (event.target === photoSheet) closePhotoSheet();
});

cameraSelect.addEventListener("change", async () => {
  if (cameraSelect.dataset.quiet === "1" || !cameraSelect.value || photoSheet.hidden) return;
  photoPickedByUser = true;
  shutterBtn.disabled = true;
  try {
    await openPhotoCamera(cameraSelect.value);
    photoError.hidden = true;
  } catch (err) {
    console.error("Failed while switching cameras:", err);
    photoError.hidden = false;
    photoError.textContent = cameraError(err);
  } finally {
    shutterBtn.disabled = !photoStream;
  }
});

shutterBtn.addEventListener("click", () => {
  const dataUrl = shotFromVideo(photoVideo);
  if (!dataUrl) {
    photoError.hidden = false;
    photoError.textContent = "The camera has no picture yet. Wait a moment, then try again.";
    return;
  }
  keepPhoto(dataUrl);
  closePhotoSheet();
});

