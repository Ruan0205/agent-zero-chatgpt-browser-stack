from helpers.extension import Extension
from helpers.errors import RepairableException
from usr.plugins.visual_evidence_guard.evidence import normalize_browser_args, is_visual_review, prepare_review, inspect_image
from usr.plugins.visual_evidence_guard.runtime import install


class EvidenceBefore(Extension):
    async def execute(self, tool_name='', tool_args=None, **kwargs):
        args = tool_args if isinstance(tool_args, dict) else {}
        name = tool_name.split(':')[0]
        try:
            if name == 'browser':
                install()
                normalize_browser_args(args)
            if name in ('call_subordinate', 'tasks') and is_visual_review(args.get('message', '')):
                message, paths = prepare_review(args['message'], args.get('attachments'), self.agent.context.get_data('last_visual_capture'))
                args['message'], args['attachments'] = message, paths
            expected = self.agent.context.get_data('visual_review_evidence')
            if expected and name == 'vision_load':
                raw_paths = args.get('paths', [])
                if isinstance(raw_paths, str): raw_paths = [raw_paths]
                requested = [inspect_image(p)['path'] for p in raw_paths]
                if not requested or any(p not in expected for p in requested):
                    raise ValueError('Use somente os arquivos explícitos no manifesto desta avaliação; não selecione imagens por recência.')
                for path in requested:
                    report = inspect_image(path)
                    expected_hash = (self.agent.context.get_data('visual_review_hashes') or {}).get(path)
                    if expected_hash and report['sha256'] != expected_hash:
                        raise ValueError('Evidência alterada durante a avaliação. Peça uma nova delegação com a versão atual; não misture iterações.')
                    if report['uniform']:
                        raise ValueError('Evidência ficou uniforme/vazia. Não emitir nota; informe não avaliável.')
            if expected and name == 'response':
                loaded = set(self.agent.context.get_data('visual_review_loaded') or [])
                if not set(expected).issubset(loaded):
                    # Permit reporting an evidence failure without requiring a bogus score.
                    text = str(args.get('text', '')).lower()
                    if 'não avaliável' not in text and 'not evaluable' not in text:
                        raise ValueError('Avaliação bloqueada: carregue TODAS as evidências com vision_load ou responda não avaliável. Não invente uma nota.')
        except (ValueError, OSError) as error:
            raise RepairableException(str(error)) from error
