const STORAGE_KEY = "a0:final-reply-sound:v1";
let audioContext;

export function armSound() {
  if (!soundEnabled()) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audioContext ||= new Context();
    if (audioContext.state === "suspended") void audioContext.resume();
  } catch (error) {
    console.warn("Could not prepare response sound", error);
  }
}

export function soundEnabled() {
  return localStorage.getItem(STORAGE_KEY) !== "off";
}

export function setSoundEnabled(enabled) {
  localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  document.dispatchEvent(new Event("a0-final-sound-setting"));
}

export async function playFinalSound() {
  if (!soundEnabled()) return false;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return false;
    audioContext ||= new Context();
    if (audioContext.state === "suspended") await audioContext.resume();
    const now = audioContext.currentTime;
    for (const [frequency, start] of [[659.25, 0], [783.99, 0.12], [987.77, 0.24]]) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.055, now + start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.42);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now + start);
      oscillator.stop(now + start + 0.44);
    }
    return true;
  } catch (error) {
    console.warn("Final response sound could not play", error);
    return false;
  }
}
