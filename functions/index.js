const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

exports.helloEveryMinute = onSchedule("every 1 minutes", async () => {
  logger.info("Hello from scheduled function", {structuredData: true});
});

exports.enforceSafetyCutoff = onSchedule("every 1 minutes", async () => {
  const now = new Date();
  const nowMs = now.getTime();

  try {
    const snap = await db.collectionGroup("devices")
        .where("type", "==", "iron")
        .where("state", "==", "ON")
        .get();

    logger.info("Safety cutoff scan started", {
      deviceCount: snap.size,
      structuredData: true,
    });

    const batch = db.batch();
    let shutOffCount = 0;

    snap.forEach((deviceSnap) => {
      try {
        const data = deviceSnap.data() || {};
        const turnedOnAt = data.turnedOnAt;
        const maxOnDurationMin = data.maxOnDurationMin;
        const deviceName = data.name || "Unknown device";
        const pathParts = deviceSnap.ref.path.split("/");
        const houseId = pathParts[1] || "unknown-house";

        if (!turnedOnAt || typeof turnedOnAt.toDate !== "function") {
          logger.warn("Skipping iron with missing turnedOnAt", {
            path: deviceSnap.ref.path,
            deviceId: deviceSnap.id,
            structuredData: true,
          });
          return;
        }

        if (typeof maxOnDurationMin !== "number") {
          logger.warn("Skipping iron with invalid maxOnDurationMin", {
            path: deviceSnap.ref.path,
            deviceId: deviceSnap.id,
            maxOnDurationMin,
            structuredData: true,
          });
          return;
        }

        const elapsedMin = (nowMs - turnedOnAt.toDate().getTime()) / 60000;

        logger.info("Checked iron device", {
          deviceId: deviceSnap.id,
          houseId,
          elapsedMin,
          maxOnDurationMin,
          structuredData: true,
        });

        if (elapsedMin < maxOnDurationMin) {
          return;
        }

        batch.update(deviceSnap.ref, {
          state: "OFF",
          turnedOnAt: null,
        });

        const usageLogRef = db
            .collection("houses")
            .doc(houseId)
            .collection("usageLogs")
            .doc();

        batch.set(usageLogRef, {
          houseId,
          deviceId: deviceSnap.id,
          deviceName,
          event: "OFF",
          timestamp: now,
        });

        const alertRef = db
            .collection("houses")
            .doc(houseId)
            .collection("alerts")
            .doc();

        batch.set(alertRef, {
          houseId,
          deviceId: deviceSnap.id,
          deviceName,
          message:
              "Auto shut-off: exceeded max on-duration of " +
              maxOnDurationMin +
              " min",
          timestamp: now,
          acknowledged: false,
        });

        shutOffCount += 1;
        logger.info("Iron exceeded max duration, shutting off", {
          deviceId: deviceSnap.id,
          houseId,
          elapsedMin,
          maxOnDurationMin,
          structuredData: true,
        });
      } catch (deviceError) {
        logger.error("Failed to process iron device", {
          deviceId: deviceSnap.id,
          path: deviceSnap.ref.path,
          error: deviceError.message,
          structuredData: true,
        });
      }
    });

    if (shutOffCount === 0) {
      logger.info("Safety cutoff run completed with no shut-offs", {
        structuredData: true,
      });
      return;
    }

    await batch.commit();
    logger.info("Safety cutoff batch committed", {
      shutOffCount,
      structuredData: true,
    });
  } catch (error) {
    logger.error("enforceSafetyCutoff failed", {
      error: error.message,
      structuredData: true,
    });
  }
});

exports.runBulbSchedule = onSchedule("every 1 minutes", async () => {
  const now = new Date();

  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hour = timeParts.find((p) => p.type === "hour").value;
  const minute = timeParts.find((p) => p.type === "minute").value;
  const currentTime = `${hour}:${minute}`;

  try {
    const snap = await db.collectionGroup("devices")
        .where("type", "==", "bulb")
        .where("scheduleEnabled", "==", true)
        .get();

    logger.info("Bulb schedule scan started", {
      deviceCount: snap.size,
      currentTime,
      timezone: "Asia/Colombo",
      structuredData: true,
    });

    const batch = db.batch();
    let transitionCount = 0;

    snap.forEach((deviceSnap) => {
      try {
        const data = deviceSnap.data() || {};
        const scheduleStart = data.scheduleStart;
        const scheduleEnd = data.scheduleEnd;
        const state = data.state;
        const deviceName = data.name || "Unknown device";
        const pathParts = deviceSnap.ref.path.split("/");
        const houseId = pathParts[1] || "unknown-house";

        if (
          typeof scheduleStart !== "string" ||
          typeof scheduleEnd !== "string"
        ) {
          logger.warn("Skipping bulb with invalid schedule", {
            path: deviceSnap.ref.path,
            deviceId: deviceSnap.id,
            scheduleStart,
            scheduleEnd,
            structuredData: true,
          });
          return;
        }

        const shouldTurnOn = currentTime === scheduleStart && state !== "ON";
        const shouldTurnOff = currentTime === scheduleEnd && state !== "OFF";

        if (!shouldTurnOn && !shouldTurnOff) {
          return;
        }

        const nextState = shouldTurnOn ? "ON" : "OFF";
        const turnedOnAt = shouldTurnOn ? now : null;

        batch.update(deviceSnap.ref, {
          state: nextState,
          turnedOnAt,
        });

        batch.set(db
            .collection("houses")
            .doc(houseId)
            .collection("usageLogs")
            .doc(), {
          houseId,
          deviceId: deviceSnap.id,
          deviceName,
          event: nextState,
          timestamp: now,
        });

        transitionCount += 1;
        logger.info("Bulb schedule transition queued", {
          deviceId: deviceSnap.id,
          houseId,
          currentTime,
          scheduleStart,
          scheduleEnd,
          fromState: state,
          toState: nextState,
          structuredData: true,
        });
      } catch (deviceError) {
        logger.error("Failed to process bulb device", {
          deviceId: deviceSnap.id,
          path: deviceSnap.ref.path,
          error: deviceError.message,
          structuredData: true,
        });
      }
    });

    if (transitionCount === 0) {
      logger.info("Bulb schedule run completed with no transitions", {
        currentTime,
        timezone: "Asia/Colombo",
        structuredData: true,
      });
      return;
    }

    await batch.commit();
    logger.info("Bulb schedule batch committed", {
      transitionCount,
      currentTime,
      timezone: "Asia/Colombo",
      structuredData: true,
    });
  } catch (error) {
    logger.error("runBulbSchedule failed", {
      error: error.message,
      structuredData: true,
    });
  }
});
