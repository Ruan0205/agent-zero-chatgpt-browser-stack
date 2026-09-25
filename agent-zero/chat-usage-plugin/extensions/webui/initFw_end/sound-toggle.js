import { armSound, soundEnabled, setSoundEnabled } from "/plugins/_chat_usage/webui/sound.mjs";

export default function installSoundToggle() {
  const refresh = () => {
    for (const button of document.querySelectorAll(".chat-usage-sound")) {
      const enabled = soundEnabled();
      button.textContent = enabled ? "♪" : "♪̸";
      button.setAttribute("aria-pressed", String(enabled));
      button.title = enabled ? "Som de conclusão ligado" : "Som de conclusão desligado";
    }
  };
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.(".chat-usage-sound")) return;
    const enabled = !soundEnabled();
    setSoundEnabled(enabled);
    if (enabled) armSound();
    refresh();
  });
  document.addEventListener("a0-final-sound-setting", refresh);
  document.addEventListener("webui-extensions-loaded", refresh);
  document.addEventListener("pointerdown", armSound, { once: true });
  document.addEventListener("keydown", armSound, { once: true });
  refresh();
}
