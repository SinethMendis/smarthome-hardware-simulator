import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  doc,
  updateDoc,
  addDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { authReady, db } from './firebase-config.js';

const DEVICE_TYPES = {
  outlet: { label: '', icon: '' },
  multiswitch: { label: '', icon: '' },
  iron: { label: '', icon: '' },
  bulb: { label: '', icon: '' },
  camera: { label: '', icon: '' },
};

const MOCK_CAMERA_IMAGES = [
  'assets/mock-camera-1.jpg',
  'assets/mock-camera-2.jpg',
];

const floorSelect = document.getElementById('floor-select');
const deviceGrid = document.getElementById('device-grid');
const usageLogStatus = document.getElementById('usage-log-status');
const usageLogList = document.getElementById('usage-log-list');
const connectionStatus = document.getElementById('connection-status');
const connectionStatusText = connectionStatus?.querySelector('.connection-status__text');
const connectionBanner = document.getElementById('connection-banner');

let houseId = null;
let currentFloorId = null;
let floorsUnsubscribe = null;
let devicesUnsubscribe = null;
let usageLogsUnsubscribe = null;
let ironCountdownInterval = null;
let floorsById = new Map();
let devicesLoaded = false;
let currentDevices = [];
const disconnectedStateByDeviceId = new Map();

function setConnectionStatus(kind, text) {
  if (!connectionStatus || !connectionStatusText) {
    return;
  }

  connectionStatus.dataset.state = kind;
  connectionStatusText.textContent = text;
}

function showConnectionBanner(message) {
  if (!connectionBanner) {
    return;
  }

  connectionBanner.hidden = false;
  connectionBanner.textContent = message;
}

function hideConnectionBanner() {
  if (!connectionBanner) {
    return;
  }

  connectionBanner.hidden = true;
  connectionBanner.textContent = '';
}

function clearIronCountdownInterval() {
  if (ironCountdownInterval) {
    clearInterval(ironCountdownInterval);
    ironCountdownInterval = null;
  }
}

function toDate(value) {
  if (!value) {
    return null;
  }

  return typeof value.toDate === 'function' ? value.toDate() : new Date(value);
}

function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getIronRemainingMs(device) {
  if (device.state !== 'ON' || !device.turnedOnAt || !device.maxOnDurationMin) {
    return null;
  }

  const turnedOnAt = toDate(device.turnedOnAt);
  const maxMs = device.maxOnDurationMin * 60 * 1000;
  const elapsed = Date.now() - turnedOnAt.getTime();

  return Math.max(0, maxMs - elapsed);
}

function hasActiveIronTimer(device) {
  const remainingMs = getIronRemainingMs(device);
  return remainingMs !== null && remainingMs > 0;
}

function isWithinSchedule(scheduleStart, scheduleEnd, now = new Date()) {
  if (!scheduleStart || !scheduleEnd) {
    return false;
  }

  const [startHour, startMinute] = scheduleStart.split(':').map(Number);
  const [endHour, endMinute] = scheduleEnd.split(':').map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function hasActiveBulbSchedule(device) {
  return (
    device.state === 'ON' &&
    device.scheduleEnabled === true &&
    isWithinSchedule(device.scheduleStart, device.scheduleEnd)
  );
}

function getStatusBadge(device) {
  const state = device.state ?? 'OFF';

  if (state === 'ERROR') {
    return { label: 'Error', className: 'status-badge--error' };
  }

  if (state === 'DISCONNECTED') {
    return { label: 'Disconnected', className: 'status-badge--disconnected' };
  }

  if (state === 'ON') {
    if (
      (device.type === 'iron' && hasActiveIronTimer(device)) ||
      (device.type === 'bulb' && hasActiveBulbSchedule(device))
    ) {
      return { label: 'On', className: 'status-badge--active' };
    }

    return { label: 'On', className: 'status-badge--on' };
  }

  return { label: 'Off', className: 'status-badge--off' };
}

function getDeviceTypeMeta(type) {
  return (
    DEVICE_TYPES[type] ?? {
      label: type || 'Unknown',
      icon: '❔',
    }
  );
}

function formatLogTimestamp(value) {
  const date = toDate(value);

  if (!date) {
    return 'Saving…';
  }

  return date.toLocaleString([], {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function getDeviceRef(deviceId) {
  return doc(
    db,
    'houses',
    houseId,
    'floors',
    currentFloorId,
    'devices',
    deviceId,
  );
}

function getDeviceDisplayName(device) {
  return device.name || device.id || 'Device';
}

function isDeviceControllable(device) {
  return device.state !== 'ERROR' && device.state !== 'DISCONNECTED';
}

function setButtonSaving(button, isSaving) {
  if (isSaving) {
    button.disabled = true;
    button.classList.add('toggle-btn--saving');
    button.dataset.originalLabel = button.textContent;
    button.textContent = 'Saving…';
    return;
  }

  button.classList.remove('toggle-btn--saving');

  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

function getCardErrorEl(card) {
  let errorEl = card.querySelector('.device-card__error');

  if (!errorEl) {
    errorEl = document.createElement('p');
    errorEl.className = 'device-card__error';
    errorEl.hidden = true;
    card.appendChild(errorEl);
  }

  return errorEl;
}

function showCardError(button, message) {
  const card = button.closest('.device-card');
  if (!card) {
    return;
  }

  const errorEl = getCardErrorEl(card);
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearCardError(button) {
  const card = button.closest('.device-card');
  if (!card) {
    return;
  }

  const errorEl = card.querySelector('.device-card__error');
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
}

async function logUsageEvent(deviceId, deviceName, event) {
  await addDoc(collection(db, 'houses', houseId, 'usageLogs'), {
    houseId,
    deviceId,
    deviceName,
    event,
    timestamp: serverTimestamp(),
  });
}

function renderUsageLogs(logs) {
  usageLogList.replaceChildren();

  if (logs.length === 0) {
    usageLogStatus.hidden = false;
    usageLogStatus.textContent = 'No usage events yet.';
    return;
  }

  usageLogStatus.hidden = true;

  for (const log of logs) {
    const item = document.createElement('li');
    item.className = 'usage-log-item';

    const device = document.createElement('span');
    device.className = 'usage-log-item__device';
    device.textContent = log.deviceName || log.deviceId || 'Unknown device';

    const event = document.createElement('span');
    const normalizedEvent = (log.event || '').toUpperCase();
    event.className = 'usage-log-item__event';
    if (normalizedEvent === 'ERROR') {
      event.classList.add('usage-log-item__event--error');
    } else if (normalizedEvent === 'DISCONNECTED') {
      event.classList.add('usage-log-item__event--disconnected');
    }
    event.textContent = normalizedEvent || 'EVENT';

    const message = document.createElement('span');
    message.textContent = `${log.deviceName || log.deviceId || 'Device'} changed to ${normalizedEvent || 'EVENT'}.`;

    const timestamp = document.createElement('span');
    timestamp.className = 'usage-log-item__time';
    timestamp.textContent = formatLogTimestamp(log.timestamp);

    item.append(device, event, message, timestamp);
    usageLogList.appendChild(item);
  }
}

function unsubscribeUsageLogsListener() {
  if (usageLogsUnsubscribe) {
    usageLogsUnsubscribe();
    usageLogsUnsubscribe = null;
  }
}

function listenToUsageLogs() {
  unsubscribeUsageLogsListener();

  if (!houseId) {
    usageLogStatus.hidden = false;
    usageLogStatus.textContent = 'Select a house to view usage logs.';
    usageLogList.replaceChildren();
    return;
  }

  usageLogStatus.hidden = false;
  usageLogStatus.textContent = 'Loading usage logs…';
  usageLogList.replaceChildren();

  const usageLogsRef = collection(db, 'houses', houseId, 'usageLogs');
  const usageLogsQuery = query(
    usageLogsRef,
    orderBy('timestamp', 'desc'),
    limit(20),
  );

  usageLogsUnsubscribe = onSnapshot(
    usageLogsQuery,
    (snapshot) => {
      const logs = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      console.log(`[usageLogs] house ${houseId}: ${logs.length} log(s)`);
      renderUsageLogs(logs);
    },
    (error) => {
      console.error('Usage log listener failed:', error);
      usageLogStatus.hidden = false;
      usageLogStatus.textContent = 'Could not load usage logs from Firestore.';
      usageLogList.replaceChildren();
    },
  );
}

async function logAlertEvent(deviceId, deviceName, message) {
  await addDoc(collection(db, 'houses', houseId, 'alerts'), {
    houseId,
    deviceId,
    deviceName,
    message,
    timestamp: serverTimestamp(),
    acknowledged: false,
  });
}

async function toggleDeviceState(device, button) {
  if (!isDeviceControllable(device)) {
    return;
  }

  const nextState = device.state === 'ON' ? 'OFF' : 'ON';
  const updates = {
    state: nextState,
    turnedOnAt: nextState === 'ON' ? serverTimestamp() : null,
  };

  try {
    setButtonSaving(button, true);
    clearCardError(button);
    await updateDoc(getDeviceRef(device.id), updates);
    await logUsageEvent(device.id, device.name || device.id, nextState);
  } catch (error) {
    console.error(`Toggle failed for device ${device.id}:`, error);
    showCardError(button, 'Could not save change. Try again.');
  } finally {
    setButtonSaving(button, false);
    button.disabled = !isDeviceControllable(device);
  }
}

async function toggleMultiswitchState(device, switchItem, button) {
  if (!isDeviceControllable(device)) {
    return;
  }

  const switches = Array.isArray(device.switches) ? [...device.switches] : [];
  const switchIndex = switches.findIndex(
    (entry) => entry.id === switchItem.id,
  );

  if (switchIndex === -1) {
    return;
  }

  const currentSwitch = switches[switchIndex];
  const nextState = currentSwitch.state === 'ON' ? 'OFF' : 'ON';
  switches[switchIndex] = { ...currentSwitch, state: nextState };

  const switchName =
    currentSwitch.name || currentSwitch.id || 'Switch';
  const logDeviceName = `${device.name || device.id} : ${switchName}`;

  try {
    setButtonSaving(button, true);
    clearCardError(button);
    await updateDoc(getDeviceRef(device.id), { switches });
    await logUsageEvent(device.id, logDeviceName, nextState);
  } catch (error) {
    console.error(
      `Toggle failed for switch ${switchItem.id} on device ${device.id}:`,
      error,
    );
    showCardError(button, 'Could not save change. Try again.');
  } finally {
    setButtonSaving(button, false);
    button.disabled = !isDeviceControllable(device);
  }
}

function createActionButton({ label, disabled, compact = false, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = compact
    ? 'toggle-btn toggle-btn--compact'
    : 'toggle-btn';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function createToggleButton({ isOn, disabled, onClick, compact = false }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = compact
    ? 'toggle-btn toggle-btn--compact'
    : 'toggle-btn';
  button.textContent = isOn ? 'Turn off' : 'Turn on';
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function stripUriQuery(uri) {
  return (uri ?? '').split('?')[0];
}

function resolveCameraAssetUrl(assetPath) {
  return new URL(assetPath, window.location.href).href;
}

function getMockCameraIndex(uri) {
  const normalized = stripUriQuery(uri).toLowerCase();

  if (normalized.includes('mock-camera-2')) {
    return 1;
  }

  if (normalized.includes('mock-camera-1')) {
    return 0;
  }

  return -1;
}

function buildCameraUri(imageIndex) {
  const basePath = resolveCameraAssetUrl(MOCK_CAMERA_IMAGES[imageIndex]);
  return `${basePath}?t=${Date.now()}`;
}

function getNextCameraUri(currentUri) {
  const currentIndex = getMockCameraIndex(currentUri);
  const nextIndex = currentIndex === 0 ? 1 : 0;
  return buildCameraUri(nextIndex);
}

async function simulateCameraSnapshot(device, button) {
  const nextUri = getNextCameraUri(device.cameraUri);

  try {
    setButtonSaving(button, true);
    clearCardError(button);
    await updateDoc(getDeviceRef(device.id), { cameraUri: nextUri });
  } catch (error) {
    console.error(`Snapshot update failed for camera ${device.id}:`, error);
    showCardError(button, 'Could not update snapshot. Try again.');
  } finally {
    setButtonSaving(button, false);
    button.disabled = false;
  }
}

async function simulateDeviceError(device, button) {
  try {
    setButtonSaving(button, true);
    clearCardError(button);
    await updateDoc(getDeviceRef(device.id), {
      state: 'ERROR',
      turnedOnAt: null,
    });
    await Promise.all([
      logUsageEvent(device.id, getDeviceDisplayName(device), 'ERROR'),
      logAlertEvent(
        device.id,
        getDeviceDisplayName(device),
        'Device reported a fault.',
      ),
    ]);
  } catch (error) {
    console.error(`Error simulation failed for device ${device.id}:`, error);
    showCardError(button, 'Could not save change. Try again.');
  } finally {
    setButtonSaving(button, false);
    button.disabled = false;
  }
}

async function toggleDeviceDisconnect(device, button) {
  const isDisconnected = device.state === 'DISCONNECTED';
  const savedSnapshot = disconnectedStateByDeviceId.get(device.id);

  const restoreSnapshot =
    savedSnapshot ?? {
      state: 'OFF',
      turnedOnAt: null,
    };

  const nextUpdates = isDisconnected
    ? {
      state: restoreSnapshot.state,
      turnedOnAt:
        restoreSnapshot.state === 'ON'
          ? restoreSnapshot.turnedOnAt ?? serverTimestamp()
          : null,
    }
    : {
      state: 'DISCONNECTED',
      turnedOnAt: null,
    };

  const nextEvent = isDisconnected ? restoreSnapshot.state : 'DISCONNECTED';
  const nextAlertMessage = isDisconnected
    ? 'Device reconnected.'
    : 'Device disconnected for testing.';

  try {
    setButtonSaving(button, true);
    clearCardError(button);

    if (!isDisconnected) {
      disconnectedStateByDeviceId.set(device.id, {
        state: device.state ?? 'OFF',
        turnedOnAt: device.turnedOnAt ?? null,
      });
    }

    await updateDoc(getDeviceRef(device.id), nextUpdates);

    await Promise.all([
      logUsageEvent(device.id, getDeviceDisplayName(device), nextEvent),
      logAlertEvent(device.id, getDeviceDisplayName(device), nextAlertMessage),
    ]);

    if (isDisconnected) {
      disconnectedStateByDeviceId.delete(device.id);
    }
  } catch (error) {
    console.error(
      `Disconnect toggle failed for device ${device.id}:`,
      error,
    );
    showCardError(button, 'Could not save change. Try again.');
  } finally {
    setButtonSaving(button, false);
    button.disabled = false;
  }
}

function renderFaultControls(device) {
  const faultControls = document.createElement('div');
  faultControls.className = 'device-card__control-row device-card__control-row--faults';

  const errorButton = createActionButton({
    label: 'Simulate error',
    disabled: false,
    compact: true,
    onClick: (event) => simulateDeviceError(device, event.currentTarget),
  });
  errorButton.classList.add('toggle-btn--danger');

  const disconnectButton = createActionButton({
    label: device.state === 'DISCONNECTED' ? 'Reconnect' : 'Disconnect',
    disabled: false,
    compact: true,
    onClick: (event) => toggleDeviceDisconnect(device, event.currentTarget),
  });
  disconnectButton.classList.add('toggle-btn--secondary');

  faultControls.append(errorButton, disconnectButton);
  return faultControls;
}

function renderDeviceControls(device) {
  const controls = document.createElement('div');
  controls.className = 'device-card__controls';

  const primaryControls = document.createElement('div');
  primaryControls.className = 'device-card__control-row';

  if (device.type === 'camera') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-btn';
    button.textContent = 'Simulate new snapshot';
    button.addEventListener('click', (event) =>
      simulateCameraSnapshot(device, event.currentTarget),
    );
    primaryControls.appendChild(button);
    controls.append(primaryControls, renderFaultControls(device));
    return controls;
  }

  if (['outlet', 'iron', 'bulb'].includes(device.type)) {
    const isOn = device.state === 'ON';
    const disabled = !isDeviceControllable(device);

    primaryControls.appendChild(
      createToggleButton({
        isOn,
        disabled,
        onClick: (event) => toggleDeviceState(device, event.currentTarget),
      }),
    );

    controls.append(primaryControls, renderFaultControls(device));
    return controls;
  }

  controls.append(renderFaultControls(device));
  return controls;
}

function renderGridMessage(message, isError = false) {
  clearIronCountdownInterval();
  currentDevices = [];
  deviceGrid.replaceChildren();

  const statusEl = document.createElement('p');
  statusEl.className = 'floor-status';
  statusEl.classList.toggle('floor-status--error', isError);
  statusEl.textContent = message;
  deviceGrid.appendChild(statusEl);
}

function renderMultiswitchBody(device) {
  const switches = Array.isArray(device.switches) ? device.switches : [];

  if (switches.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'device-card__detail device-card__detail--muted';
    empty.textContent = 'No switches configured.';
    return empty;
  }

  const details = document.createElement('details');
  details.className = 'multiswitch-details';
  details.open = switches.length <= 3;

  const summary = document.createElement('summary');
  summary.textContent = `${switches.length} switch${switches.length === 1 ? '' : 'es'}`;
  details.appendChild(summary);

  const list = document.createElement('ul');
  list.className = 'multiswitch-list';

  for (const switchItem of switches) {
    const item = document.createElement('li');
    item.className = 'multiswitch-list__item';

    const name = document.createElement('span');
    name.textContent = switchItem.name || switchItem.id || 'Switch';

    const isOn = switchItem.state === 'ON';
    const toggle = createToggleButton({
      isOn,
      disabled: !isDeviceControllable(device),
      compact: true,
      onClick: (event) =>
        toggleMultiswitchState(device, switchItem, event.currentTarget),
    });

    item.append(name, toggle);
    list.appendChild(item);
  }

  details.appendChild(list);
  return details;
}

function renderIronBody(device) {
  const detail = document.createElement('p');
  detail.className = 'device-card__detail';

  if (device.state !== 'ON') {
    detail.textContent = `Auto-off after ${device.maxOnDurationMin ?? '?'} min when on.`;
    return detail;
  }

  const remainingMs = getIronRemainingMs(device);

  if (remainingMs === null) {
    detail.textContent = 'Timer unavailable.';
    return detail;
  }

  const countdown = document.createElement('span');
  countdown.className = 'iron-countdown';
  countdown.dataset.deviceId = device.id;
  countdown.textContent = formatCountdown(remainingMs);

  detail.append('Time remaining: ', countdown);
  return detail;
}

function renderBulbBody(device) {
  const detail = document.createElement('p');
  detail.className = 'device-card__detail';

  if (device.scheduleEnabled) {
    detail.textContent = `Schedule: ${device.scheduleStart ?? '--:--'} - ${device.scheduleEnd ?? '--:--'} (enabled)`;
  } else {
    detail.textContent = `Schedule: ${device.scheduleStart ?? '--:--'} - ${device.scheduleEnd ?? '--:--'} (disabled)`;
  }

  return detail;
}

function renderCameraBody(device) {
  const wrapper = document.createElement('div');
  wrapper.className = 'camera-body';

  if (!device.cameraUri) {
    const detail = document.createElement('p');
    detail.className = 'device-card__detail device-card__detail--muted';
    detail.textContent = 'No snapshot yet. Simulate one below.';
    wrapper.appendChild(detail);
    return wrapper;
  }

  const image = document.createElement('img');
  image.className = 'camera-preview';
  image.src = resolveCameraAssetUrl(device.cameraUri);
  image.alt = `${device.name || 'Camera'} snapshot`;
  image.loading = 'lazy';
  wrapper.appendChild(image);
  return wrapper;
}

function renderDeviceBody(device) {
  switch (device.type) {
    case 'multiswitch':
      return renderMultiswitchBody(device);
    case 'iron':
      return renderIronBody(device);
    case 'bulb':
      return renderBulbBody(device);
    case 'camera':
      return renderCameraBody(device);
    default:
      return null;
  }
}

function renderDeviceCard(device) {
  const typeMeta = getDeviceTypeMeta(device.type);
  const status = getStatusBadge(device);

  const card = document.createElement('article');
  card.className = 'device-card';
  card.dataset.deviceId = device.id;

  const header = document.createElement('header');
  header.className = 'device-card__header';

  const name = document.createElement('h2');
  name.className = 'device-card__name';
  name.textContent = device.name || device.id;

  const type = document.createElement('span');
  type.className = 'device-card__type';
  type.textContent = `${typeMeta.icon} ${typeMeta.label}`;

  header.append(name, type);

  const meta = document.createElement('div');
  meta.className = 'device-card__meta';

  const badge = document.createElement('span');
  badge.className = `status-badge ${status.className}`;
  badge.textContent = status.label;
  meta.appendChild(badge);

  card.append(header, meta);

  const body = renderDeviceBody(device);
  if (body) {
    card.appendChild(body);
  }

  const controls = renderDeviceControls(device);
  if (controls) {
    card.appendChild(controls);
  }

  return card;
}

function updateIronCountdowns() {
  for (const device of currentDevices) {
    if (device.type !== 'iron' || device.state !== 'ON') {
      continue;
    }

    const countdownEl = deviceGrid.querySelector(
      `.iron-countdown[data-device-id="${device.id}"]`,
    );

    if (!countdownEl) {
      continue;
    }

    const remainingMs = getIronRemainingMs(device);
    countdownEl.textContent =
      remainingMs === null ? '--:--' : formatCountdown(remainingMs);

    const badge = countdownEl
      .closest('.device-card')
      ?.querySelector('.status-badge');

    if (badge) {
      const status = getStatusBadge(device);
      badge.className = `status-badge ${status.className}`;
      badge.textContent = status.label;
    }
  }
}

function scheduleIronCountdownUpdates(devices) {
  clearIronCountdownInterval();

  const hasActiveIron = devices.some(
    (device) => device.type === 'iron' && hasActiveIronTimer(device),
  );

  if (hasActiveIron) {
    ironCountdownInterval = setInterval(updateIronCountdowns, 1000);
  }
}

function renderDevices(devices) {
  currentDevices = devices;
  deviceGrid.replaceChildren();

  if (!devicesLoaded) {
    devicesLoaded = true;
  }

  if (devices.length === 0) {
    renderGridMessage('No devices on this floor.');
    return;
  }

  const sortedDevices = [...devices].sort((a, b) =>
    (a.name || a.id).localeCompare(b.name || b.id, undefined, {
      sensitivity: 'base',
    }),
  );

  for (const device of sortedDevices) {
    deviceGrid.appendChild(renderDeviceCard(device));
  }

  scheduleIronCountdownUpdates(sortedDevices);
}

function unsubscribeDevicesListener() {
  if (devicesUnsubscribe) {
    devicesUnsubscribe();
    devicesUnsubscribe = null;
  }

  clearIronCountdownInterval();
  devicesLoaded = false;
  currentDevices = [];
  currentFloorId = null;
}

function listenToDevices(floorId) {
  unsubscribeDevicesListener();
  currentFloorId = floorId;

  if (!houseId || !floorId) {
    renderGridMessage('Select a floor to view devices.');
    return;
  }

  renderGridMessage('Loading devices…');

  const devicesRef = collection(
    db,
    'houses',
    houseId,
    'floors',
    floorId,
    'devices',
  );

  devicesUnsubscribe = onSnapshot(
    devicesRef,
    (snapshot) => {
      const devices = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      console.log(
        `[devices] floor ${floorId}: ${devices.length} device(s)`,
        devices.map((device) => `${device.name || device.id} (${device.type})`),
      );

      renderDevices(devices);
    },
    (error) => {
      console.error(`Device listener failed for floor ${floorId}:`, error);
      setConnectionStatus('error', 'Disconnected from Firestore');
      showConnectionBanner(
        'Disconnected from Firestore. Check your network and Firestore rules, then refresh the page.',
      );
      renderGridMessage(
        'Could not load devices for this floor. Check the console for details.',
        true,
      );
    },
  );
}

function populateFloorSelector(floors) {
  floorsById = new Map(floors.map((floor) => [floor.id, floor]));

  const previousSelection = floorSelect.value;
  floorSelect.replaceChildren();

  if (floors.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No floors found';
    floorSelect.appendChild(option);
    floorSelect.disabled = true;
    unsubscribeDevicesListener();
    renderGridMessage('No floors are configured for this house.');
    return;
  }

  for (const floor of floors) {
    const option = document.createElement('option');
    option.value = floor.id;
    option.textContent = floor.name || floor.id;
    floorSelect.appendChild(option);
  }

  floorSelect.disabled = false;

  const nextSelection =
    floorsById.has(previousSelection) ? previousSelection : floors[0].id;

  floorSelect.value = nextSelection;
  listenToDevices(nextSelection);
}

function listenToFloors() {
  if (floorsUnsubscribe) {
    floorsUnsubscribe();
    floorsUnsubscribe = null;
  }

  const floorsRef = collection(db, 'houses', houseId, 'floors');
  const floorsQuery = query(floorsRef);

  floorsUnsubscribe = onSnapshot(
    floorsQuery,
    (snapshot) => {
      const floors = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) =>
          (a.name || a.id).localeCompare(b.name || b.id, undefined, {
            sensitivity: 'base',
          }),
        );

      console.log(
        `[floors] house ${houseId}: ${floors.length} floor(s)`,
        floors.map((floor) => floor.name || floor.id),
      );

      populateFloorSelector(floors);
    },
    (error) => {
      console.error('Floor listener failed:', error);
      setConnectionStatus('error', 'Disconnected from Firestore');
      showConnectionBanner(
        'Disconnected from Firestore. Check your network and Firestore rules, then refresh the page.',
      );
      floorSelect.disabled = true;
      floorSelect.replaceChildren();
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Could not load floors';
      floorSelect.appendChild(option);
      unsubscribeDevicesListener();
      renderGridMessage('Could not load floors from Firestore.', true);
    },
  );
}

function resolveHouseId(snapshotFn) {
  return new Promise((resolve, reject) => {
    const housesRef = collection(db, 'houses');

    const unsubscribe = snapshotFn(
      housesRef,
      (snapshot) => {
        unsubscribe();

        if (snapshot.empty) {
          reject(new Error('No houses found in Firestore.'));
          return;
        }

        if (snapshot.size > 1) {
          console.warn(
            `[houses] Multiple houses found (${snapshot.size}); using "${snapshot.docs[0].id}".`,
          );
        }

        resolve(snapshot.docs[0].id);
      },
      (error) => {
        unsubscribe();
        reject(error);
      },
    );
  });
}

floorSelect.addEventListener('change', () => {
  listenToDevices(floorSelect.value);
});

authReady
  .then(async () => {
    houseId = await resolveHouseId(onSnapshot);
    console.log(`Using house: ${houseId}`);
    setConnectionStatus('live', 'Live');
    hideConnectionBanner();
    listenToUsageLogs();
    listenToFloors();
  })
  .catch((error) => {
    console.error('App initialization failed:', error);
    setConnectionStatus('error', 'Disconnected from Firestore');
    showConnectionBanner(
      'Disconnected from Firestore. Check the console for details and try again.',
    );
    floorSelect.disabled = true;
    floorSelect.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Initialization failed';
    floorSelect.appendChild(option);
    renderGridMessage(
      error.message === 'No houses found in Firestore.'
        ? 'No houses found in Firestore.'
        : 'Could not connect to Firestore. Check the console for details.',
      true,
    );
  });
