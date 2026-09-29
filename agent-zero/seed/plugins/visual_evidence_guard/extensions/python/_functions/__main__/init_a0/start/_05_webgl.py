from helpers.extension import Extension
from usr.plugins.visual_evidence_guard.runtime import install


class BrowserRendererStartup(Extension):
    def execute(self, **kwargs):
        # Install before restoring chats or allowing the UI to open a browser.
        # A tool-only hook would miss browsers opened by the viewer after reboot.
        install()
