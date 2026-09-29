"""Narrow browser-runtime adapter: explicit software WebGL and capture diagnostics."""
from collections import deque
from .evidence import inspect_image

SOFTWARE_WEBGL = True


def install():
    from plugins._browser.helpers import runtime as module
    core = module._BrowserRuntimeCore
    if getattr(core, '_visual_evidence_installed', False):
        return
    original_config = module.build_browser_launch_config
    original_register = core._register_page_locked
    original_capture = core.screenshot_file

    def config(settings):
        result = original_config(settings)
        if SOFTWARE_WEBGL:
            result['args'] = [*result['args'], '--use-gl=angle', '--use-angle=swiftshader']
        return result

    def register(self, page, *args, **kwargs):
        item = original_register(self, page, *args, **kwargs)
        if not hasattr(page, '_visual_errors'):
            page._visual_errors = deque(maxlen=12)
            page.on('pageerror', lambda e: page._visual_errors.append(str(e)[:1500]))
            page.on('console', lambda m: page._visual_errors.append(m.text[:1500]) if m.type == 'error' else None)
            page.on('framenavigated', lambda frame: page._visual_errors.clear() if frame == page.main_frame else None)
        return item

    async def diagnostics(self, browser_id=None):
        await self.ensure_started()
        bid = self._resolve_browser_id(browser_id)
        page = self._page(bid)
        state = await page.evaluate("""() => ({url:location.href, ready:document.readyState,
          bodyText:document.body.innerText.slice(0,1000), rootChildren:document.querySelector('#root')?.childElementCount,
          canvases:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height})),
          images:[...document.images].map(i=>({src:i.src.startsWith('data:')?'data:image (inline)':i.src.slice(0,300),loaded:i.complete&&i.naturalWidth>0}))})""", isolated_context=False)
        state['errors'] = list(getattr(page, '_visual_errors', ()))
        return state

    async def capture(self, *args, **kwargs):
        await self.ensure_started()
        bid = self._resolve_browser_id(args[0] if args else kwargs.get('browser_id'))
        page = self._page(bid)
        # Readiness is a bounded condition, not an arbitrary long sleep or reload loop.
        try:
            await page.wait_for_function("() => [...document.images].every(i=>i.complete)", timeout=5000)
        except Exception:
            pass  # Preserve screenshot and diagnostics of broken assets.
        result = await original_capture(self, *args, **kwargs)
        report = inspect_image(result['path'])
        result['visual_evidence'] = {**report, 'valid': not report['uniform']}
        if report['uniform']:
            result['diagnostics'] = await diagnostics(self, result.get('browser_id'))
            result['warning'] = 'VISUAL_EVIDENCE_INVALID: quadro uniforme/vazio. Não avaliar nem delegar esta captura; confira diagnostics antes de recapturar.'
        return result

    module.build_browser_launch_config = config
    core._register_page_locked = register
    core.visual_diagnostics = diagnostics
    core.screenshot_file = capture
    core._visual_evidence_installed = True
