/**
 * Session metrics tracker:
 * - Peak concurrent LiveKit connections
 * - Estimated WebRTC minutes used
 * - Open WebSocket connections
 * - Time from "granted" to audible audio (attendee & principal)
 */

export class SessionMetrics {
  constructor(sessionCode) {
    this.sessionCode = sessionCode;
    this.openSockets = 0;
    this.peakSockets = 0;
    this.currentLivekitConnections = 0;
    this.peakLivekitConnections = 0;
    this.totalWebRtcSeconds = 0;
    this.grantToAudioTimes = {
      attendee: [],
      principal: []
    };
  }

  updateSocketCount(count) {
    this.openSockets = count;
    if (count > this.peakSockets) {
      this.peakSockets = count;
    }
  }

  updateLiveKitCount(count) {
    this.currentLivekitConnections = count;
    if (count > this.peakLivekitConnections) {
      this.peakLivekitConnections = count;
    }
  }

  recordWebRtcSeconds(seconds) {
    this.totalWebRtcSeconds += Math.max(0, seconds);
  }

  recordGrantToAudio(role, durationMs) {
    const key = role === 'principal' ? 'principal' : 'attendee';
    this.grantToAudioTimes[key].push({
      durationMs,
      timestamp: Date.now()
    });
    // Keep last 50 measurements
    if (this.grantToAudioTimes[key].length > 50) {
      this.grantToAudioTimes[key].shift();
    }
  }

  getSnapshot() {
    const calcAvg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b.durationMs, 0) / arr.length) : null;
    return {
      openSockets: this.openSockets,
      peakSockets: this.peakSockets,
      currentLivekitConnections: this.currentLivekitConnections,
      peakLivekitConnections: this.peakLivekitConnections,
      webrtcMinutesUsed: Number((this.totalWebRtcSeconds / 60).toFixed(2)),
      avgGrantToAudioMs: {
        attendee: calcAvg(this.grantToAudioTimes.attendee),
        principal: calcAvg(this.grantToAudioTimes.principal)
      },
      recentGrantToAudio: {
        attendee: this.grantToAudioTimes.attendee.slice(-5),
        principal: this.grantToAudioTimes.principal.slice(-5)
      }
    };
  }
}

const sessionMetricsMap = new Map();

export function getSessionMetrics(sessionCode) {
  if (!sessionMetricsMap.has(sessionCode)) {
    sessionMetricsMap.set(sessionCode, new SessionMetrics(sessionCode));
  }
  return sessionMetricsMap.get(sessionCode);
}

export function clearMetrics() {
  sessionMetricsMap.clear();
}
